// The send path. The agent never sends: only an owner approving a send approval reaches this code.
//
//   1. Load the approval with its draft, lead, suppression and pause state; run checkSendApproval.
//   2. In one statement, consume the approval and claim the draft (status 'sending'), re-asserting the
//      same rules in SQL so a concurrent pause, suppression, consent change or second approve loses.
//   3. Call AgentMail. On success store message/thread ids on the draft and in `messages`.
//      On a definite failure mark the draft send_failed. On an ambiguous one (no response, 5xx) leave it
//      'sending': the cron looks the message up by its draft label and settles it. Never resend blindly.
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { ApiError, notConfigured, notFound } from "../lib/errors.ts";
import { AgentMailClient, draftLabel, type SentMessage } from "../providers/agentmail.ts";
import { ProviderError, type FetchFn } from "../providers/http.ts";
import { checkSendApproval } from "./approval-rules.ts";
import type { ApprovalRow } from "./approvals.ts";
import type { Draft } from "../db.ts";

type DraftRow = Draft & { sending_at: Date | null; delivered_at: Date | null };

export type SendDeps = { sql: Sql; env: Env; fetch?: FetchFn; actor: string; now?: Date };

export type SendResult =
  | { status: "sent"; draft_id: string; message_id: string; thread_id: string }
  | { status: "sending"; draft_id: string; note: string };

function agentMail(env: Env, fetchFn?: FetchFn) {
  if (!env.AGENTMAIL_API_KEY) throw notConfigured("AGENTMAIL_API_KEY");
  if (!env.AGENTMAIL_INBOX_ID) throw notConfigured("AGENTMAIL_INBOX_ID");
  return new AgentMailClient(env.AGENTMAIL_API_KEY, env.AGENTMAIL_INBOX_ID, fetchFn);
}

export async function approveAndSend(deps: SendDeps, code: string): Promise<SendResult> {
  const { sql, env, actor } = deps;
  const rows = await sql`
    select a.*, to_jsonb(d) as draft, to_jsonb(l) as lead,
           (select max(version) from drafts where lead_id = a.lead_id) as latest_version,
           exists (select 1 from suppressions s where s.email = lower(a.recipient)) as suppressed,
           coalesce((select value = 'true'::jsonb from settings where key = 'paused'), false) as paused
    from approvals a
    left join drafts d on d.id = a.draft_id
    left join leads l on l.id = a.lead_id
    where a.code = ${code.toUpperCase()}`;
  const row = rows[0];
  if (!row) throw notFound("Approval");
  const approval = row as ApprovalRow;
  const check = checkSendApproval({
    approval,
    draft: row.draft,
    latestVersion: row.latest_version,
    lead: row.lead,
    suppressed: row.suppressed,
    paused: row.paused,
    now: deps.now ?? new Date(),
  });
  if (!check.ok) {
    if (check.code === "approval_expired") {
      await sql`update approvals set status = 'expired', decided_at = now() where code = ${approval.code} and status = 'pending'`;
    }
    await sql`insert into events (lead_id, kind, data) values (${approval.lead_id}, 'send_refused', ${JSON.stringify({
      code: approval.code,
      reason: check.code,
      actor,
    })}::jsonb)`;
    throw new ApiError(check.status, check.code, check.message);
  }
  const client = agentMail(env, deps.fetch); // before consuming: a missing key must not burn the approval

  const claimed = await sql`
    with a as (
      update approvals set status = 'approved', decided_at = now(), decided_via = 'api'
      where code = ${approval.code} and kind = 'send' and status = 'pending' and expires_at > now()
        and not coalesce((select value = 'true'::jsonb from settings where key = 'paused'), false)
        and not exists (select 1 from suppressions s where s.email = lower(approvals.recipient))
        and exists (select 1 from leads l where l.id = approvals.lead_id
                    and l.consent_at is not null and lower(l.email) = lower(approvals.recipient))
        and exists (select 1 from drafts d where d.id = approvals.draft_id and d.status = 'pending_approval'
                    and d.version = (select max(version) from drafts where lead_id = approvals.lead_id))
      returning code, lead_id, draft_id, recipient
    ), d as (
      update drafts set status = 'sending', sending_at = now(), error = null
      where id = (select draft_id from a)
      returning *
    ), ev as (
      insert into events (lead_id, kind, data)
      select lead_id, 'approval_approved', jsonb_build_object('code', code, 'draft_id', draft_id, 'actor', ${actor}::text) from a
    )
    select d.*, a.recipient from d, a`;
  if (!claimed[0]) throw new ApiError(409, "approval_not_pending", "Approval was consumed or invalidated concurrently");
  const draft = claimed[0] as DraftRow & { recipient: string };

  let sent: SentMessage;
  try {
    sent = await client.send({
      to: draft.recipient,
      subject: draft.subject,
      text: draft.body,
      labels: ["crusonia", draftLabel(draft.id), `variant-${draft.variant.toLowerCase()}`],
    });
    if (!sent.message_id) throw new ProviderError("agentmail", "send returned no message_id", 200, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const ambiguous = err instanceof ProviderError ? err.ambiguous : true;
    if (ambiguous) {
      await sql.transaction([
        sql`update drafts set error = ${message} where id = ${draft.id} and status = 'sending'`,
        sql`insert into events (lead_id, kind, data) values (${draft.lead_id}, 'email_send_unknown', ${JSON.stringify({
          draft_id: draft.id,
          error: message,
        })}::jsonb)`,
      ]);
      return { status: "sending", draft_id: draft.id, note: "AgentMail did not confirm the send; the cron will reconcile it against AgentMail before anything is retried" };
    }
    await sql.transaction([
      sql`update drafts set status = 'send_failed', error = ${message} where id = ${draft.id} and status = 'sending'`,
      sql`insert into events (lead_id, kind, data) values (${draft.lead_id}, 'email_send_failed', ${JSON.stringify({
        draft_id: draft.id,
        error: message,
      })}::jsonb)`,
    ]);
    throw new ApiError(502, "send_failed", message);
  }
  await recordSent(sql, env, draft, sent);
  return { status: "sent", draft_id: draft.id, message_id: sent.message_id, thread_id: sent.thread_id };
}

async function recordSent(sql: Sql, env: Env, draft: DraftRow & { recipient?: string }, sent: SentMessage) {
  const to = draft.recipient ?? (await sql`select email from leads where id = ${draft.lead_id}`)[0]?.email ?? null;
  await sql.transaction([
    sql`update drafts set status = 'sent', provider_message_id = ${sent.message_id}, provider_thread_id = ${sent.thread_id},
          error = null
        where id = ${draft.id} and status = 'sending'`,
    sql`insert into messages (lead_id, direction, provider_message_id, thread_id, from_addr, to_addr, subject, body)
        values (${draft.lead_id}, 'out', ${sent.message_id}, ${sent.thread_id}, ${env.AGENTMAIL_INBOX_ID ?? null}, ${to},
                ${draft.subject}, ${draft.body})
        on conflict (provider_message_id) do nothing`,
    sql`update leads set stage = 'sent', updated_at = now()
        where id = ${draft.lead_id} and stage not in ('replied', 'interested', 'not_interested', 'unsubscribed')`,
    sql`insert into events (lead_id, kind, data) values (${draft.lead_id}, 'email_sent', ${JSON.stringify({
      draft_id: draft.id,
      version: draft.version,
      message_id: sent.message_id,
      thread_id: sent.thread_id,
    })}::jsonb)`,
  ]);
}

/**
 * Cron: settle drafts stuck in 'sending' (an ambiguous AgentMail response, or the Worker died mid-send).
 * Found by draft label -> sent. Still not found 10 minutes after the attempt -> send_failed (the owner can
 * edit the approval to retry, which makes a new version and a new approval).
 */
export async function reconcileSending(sql: Sql, env: Env, fetchFn?: FetchFn): Promise<{ sent: number; failed: number }> {
  if (!env.AGENTMAIL_API_KEY || !env.AGENTMAIL_INBOX_ID) return { sent: 0, failed: 0 };
  const stuck = (await sql`
    select d.*, l.email as recipient from drafts d join leads l on l.id = d.lead_id
    where d.status = 'sending' and d.sending_at < now() - interval '2 minutes'
    order by d.sending_at limit 10`) as (DraftRow & { recipient: string })[];
  const client = new AgentMailClient(env.AGENTMAIL_API_KEY, env.AGENTMAIL_INBOX_ID, fetchFn);
  let sent = 0;
  let failed = 0;
  for (const draft of stuck) {
    try {
      const [found] = await client.listByLabels([draftLabel(draft.id)], 1);
      if (found) {
        await recordSent(sql, env, draft, { message_id: found.message_id, thread_id: found.thread_id });
        sent++;
      } else if (draft.sending_at && Date.now() - new Date(draft.sending_at).getTime() > 10 * 60_000) {
        await sql.transaction([
          sql`update drafts set status = 'send_failed', error = coalesce(error, 'Not found at AgentMail after an unconfirmed send')
              where id = ${draft.id} and status = 'sending'`,
          sql`insert into events (lead_id, kind, data) values (${draft.lead_id}, 'email_send_failed', ${JSON.stringify({
            draft_id: draft.id,
            error: "not found at AgentMail after an unconfirmed send",
          })}::jsonb)`,
        ]);
        failed++;
      }
    } catch (err) {
      console.error(`reconcile draft ${draft.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return { sent, failed };
}
