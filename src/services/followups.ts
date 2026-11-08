// Follow-ups: an email draft that follows up on one already sent to the lead, sent at `scheduled_for`.
//
//   1. createFollowUp stores it as a new immutable draft version (followup_of = the sent draft) with its own pending
//      send approval, bound to the lead's address and this exact version like any email draft.
//   2. Approving it (src/services/send.ts) before it's due moves it to 'scheduled'; approving it when due sends it.
//   3. sendDueFollowUps (minute cron) sends due 'scheduled' follow-ups, re-checking in SQL that the lead hasn't replied,
//      unsubscribed or been suppressed, still has consent, and Crusonia isn't paused. Anything else cancels it.
//   4. A real inbound reply cancels every pending or scheduled follow-up of the lead (src/services/inbound.ts).
//      Delivery events never do: delivered is not a reply.
import { z } from "zod";
import type { Draft, Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { newId, shortCode } from "../ids.ts";
import { ApiError, notConfigured } from "../lib/errors.ts";
import { AgentMailClient } from "../providers/agentmail.ts";
import type { FetchFn } from "../providers/http.ts";
import { deliverClaimed } from "./send.ts";

/** Stages where the conversation has an answer: no follow-up is created or sent. */
export const REPLIED_STAGES = ["replied", "interested", "not_interested", "meeting_booked", "unsubscribed"];

export const followupInputSchema = z
  .object({
    draft_id: z.string().min(1).max(64).optional().describe("The sent draft this follows up on (default: the lead's latest sent email)."),
    subject: z.string().trim().min(1).max(200).optional().describe('Default: "Re: <the original subject>".'),
    body: z.string().trim().min(1).max(10_000),
    send_after_days: z.number().min(0).max(60).optional(),
    send_at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((b) => (b.send_after_days === undefined) !== (b.send_at === undefined), { message: "Pass exactly one of send_after_days or send_at" });
export type FollowUpInput = z.infer<typeof followupInputSchema>;

type Parent = Draft & { email: string | null; name: string | null; stage: string; consent_at: Date | null; suppressed: boolean };

/** POST /api/leads/:id/followups. */
export async function createFollowUp(sql: Sql, leadId: string, input: FollowUpInput, opts: { ttlMinutes: number; actor: string; now?: Date }) {
  const parent = (
    (await sql`
      select d.*, l.email, l.name, l.stage, l.consent_at,
             exists (select 1 from suppressions s where s.email = lower(l.email)) as suppressed
      from drafts d join leads l on l.id = d.lead_id
      where d.lead_id = ${leadId} and d.channel = 'email' and d.status in ('sent', 'sending', 'scheduled')
        and (${input.draft_id ?? null}::text is null or d.id = ${input.draft_id ?? null})
      order by d.version desc limit 1`) as Parent[]
  )[0];
  if (!parent) {
    throw new ApiError(409, "nothing_to_follow_up", input.draft_id ? `Draft ${input.draft_id} of this lead was not sent` : "This lead has no sent email to follow up on");
  }
  if (REPLIED_STAGES.includes(parent.stage)) throw new ApiError(409, "already_replied", "The lead already replied; answer them instead of following up");
  if (!parent.email || !parent.consent_at) throw new ApiError(403, "no_consent", "This lead has not opted in to email");
  if (parent.suppressed) throw new ApiError(403, "suppressed", "The recipient is on the suppression list");

  const now = opts.now ?? new Date();
  const sendAt = input.send_at ? new Date(input.send_at) : new Date(now.getTime() + (input.send_after_days ?? 0) * 86_400_000);
  const subject = input.subject ?? (/^re:/i.test(parent.subject) ? parent.subject : `Re: ${parent.subject}`);
  const who = parent.name ? `${parent.name} <${parent.email}>` : parent.email;
  const summary = `Follow-up: send "${subject}" to ${who} on ${sendAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  for (let attempt = 1; ; attempt++) {
    try {
      const [row] = await sql`
        with next as (select coalesce(max(version), 0) + 1 as version from drafts where lead_id = ${leadId}),
        superseded as (
          -- An older follow-up still waiting for approval is replaced by this one.
          update drafts set status = 'superseded'
          where lead_id = ${leadId} and status = 'pending_approval' and followup_of is not null
          returning id
        ),
        expired as (
          update approvals set status = 'expired', decided_at = now(), decided_via = 'superseded'
          where status = 'pending' and draft_id in (select id from superseded)
        ),
        draft as (
          insert into drafts (id, lead_id, version, variant, subject, body, status, channel, followup_of, scheduled_for)
          select ${newId("draft")}, l.id, next.version, l.variant, ${subject}, ${input.body}, 'pending_approval', 'email', ${parent.id}, ${sendAt.toISOString()}::timestamptz
          from leads l, next where l.id = ${leadId}
          returning *
        ),
        approval as (
          insert into approvals (code, kind, lead_id, draft_id, recipient, summary, expires_at)
          select ${shortCode()}, 'send', lead_id, id, ${parent.email}, ${summary}, now() + make_interval(mins => ${opts.ttlMinutes}::int)
          from draft returning *
        ),
        ev as (
          insert into events (lead_id, kind, data)
          select d.lead_id, 'draft_created', jsonb_build_object('via', 'api', 'draft_id', d.id, 'version', d.version, 'approval_code', a.code,
                 'channel', 'email', 'followup_of', ${parent.id}::text, 'send_at', ${sendAt.toISOString()}::text, 'actor', ${opts.actor}::text)
          from draft d, approval a
        )
        select to_jsonb(d) as draft, to_jsonb(a) as approval from draft d, approval a`;
      return row as { draft: Draft & { followup_of: string; scheduled_for: string }; approval: Record<string, unknown> };
    } catch (err) {
      if (attempt < 4 && (err as { code?: string }).code === "23505") continue;
      throw err;
    }
  }
}

/** GET /api/leads/:id/followups: the lead's follow-ups, newest first. */
export async function listFollowUps(sql: Sql, leadId: string) {
  return sql`
    select d.id, d.version, d.subject, d.body, d.status, d.followup_of, d.scheduled_for, d.created_at,
           (select a.code from approvals a where a.draft_id = d.id order by a.created_at desc limit 1) as approval_code,
           (select a.status from approvals a where a.draft_id = d.id order by a.created_at desc limit 1) as approval_status
    from drafts d where d.lead_id = ${leadId} and d.followup_of is not null
    order by d.version desc`;
}

/**
 * Cron: send follow-ups that are scheduled and due, at most `limit` per run. The claim re-asserts in SQL that the
 * lead hasn't replied or unsubscribed, still has consent at the approved address, isn't suppressed, and that
 * Crusonia isn't paused (paused: it waits). A replied or suppressed lead's follow-up is cancelled instead.
 */
export async function sendDueFollowUps(sql: Sql, env: Env, fetchFn?: FetchFn, limit = 5): Promise<{ sent: number; cancelled: number; failed: number }> {
  const cancelled = await sql`
    with c as (
      update drafts d set status = 'cancelled'
      from leads l
      where d.lead_id = l.id and d.status = 'scheduled'
        and (l.stage = any(${REPLIED_STAGES}::text[]) or l.consent_at is null
             or exists (select 1 from suppressions s where s.email = lower(l.email)))
      returning d.id, d.lead_id
    )
    insert into events (lead_id, kind, data)
    select lead_id, 'followups_stopped', jsonb_build_object('reason', 'not_sendable', 'drafts', jsonb_agg(id)) from c group by lead_id
    returning lead_id`;
  const due = await sql`select id from drafts where status = 'scheduled' and scheduled_for <= now() order by scheduled_for limit ${limit}`;
  if (!due.length) return { sent: 0, cancelled: cancelled.length, failed: 0 };
  if (!env.AGENTMAIL_API_KEY) throw notConfigured("AGENTMAIL_API_KEY");
  if (!env.AGENTMAIL_INBOX_ID) throw notConfigured("AGENTMAIL_INBOX_ID");
  const client = new AgentMailClient(env.AGENTMAIL_API_KEY, env.AGENTMAIL_INBOX_ID, fetchFn);
  let sent = 0;
  let failed = 0;
  for (const { id } of due) {
    const claimed = await sql`
      update drafts d set status = 'sending', sending_at = now(), error = null
      where d.id = ${id} and d.status = 'scheduled' and d.scheduled_for <= now()
        and not coalesce((select value = 'true'::jsonb from settings where key = 'paused'), false)
        and exists (select 1 from approvals a join leads l on l.id = a.lead_id
                    where a.draft_id = d.id and a.kind = 'send' and a.status = 'approved'
                      and l.consent_at is not null and lower(l.email) = lower(a.recipient)
                      and not (l.stage = any(${REPLIED_STAGES}::text[]))
                      and not exists (select 1 from suppressions s where s.email = lower(a.recipient)))
      returning d.*, (select a.recipient from approvals a where a.draft_id = d.id and a.status = 'approved' limit 1) as recipient`;
    const draft = claimed[0];
    if (!draft) continue;
    try {
      const result = await deliverClaimed(sql, env, client, draft as Parameters<typeof deliverClaimed>[3]);
      if (result.status === "sent") sent++;
    } catch (err) {
      failed++;
      console.error(`follow-up ${id}:`, err instanceof Error ? err.message : err);
    }
  }
  return { sent, cancelled: cancelled.length, failed };
}
