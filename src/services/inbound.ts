// AgentMail webhook events: replies, deliveries, bounces and complaints.
// Inbound email is untrusted data. It is stored and pattern-matched for a label, never executed, never
// turned into instructions, and never used to create leads.
// Workspaces: every event maps to the workspace of the draft or message it is about (the thread or provider message
// id), so a reply, bounce or complaint only touches that workspace's lead and do-not-contact list. A reply matched
// only by its sender address counts only when exactly one workspace has a lead with that address. Mail that matches
// nothing is kept in the owner workspace (the instance's AgentMail inbox belongs to the owner).
import { z } from "zod";
import type { Sql } from "../db.ts";
import { isUniqueViolation } from "../lib/errors.ts";
import { extractEmail } from "./addresses.ts";
import { keywordClassifier, replyText, type ReplyClassifier, type ReplyLabel } from "./classify.ts";
import { OWNER_WORKSPACE_ID } from "./workspaces.ts";

const address = z.string();
const MessageSchema = z.looseObject({
  inbox_id: z.string().optional(),
  thread_id: z.string(),
  message_id: z.string(),
  from: z.string().optional(),
  to: z.array(address).optional(),
  subject: z.string().nullish(),
  text: z.string().nullish(),
  html: z.string().nullish(),
  extracted_text: z.string().nullish(),
  in_reply_to: z.string().nullish(),
});

export const AgentMailEventSchema = z.looseObject({
  event_id: z.string().min(1),
  event_type: z.string(),
  message: MessageSchema.optional(),
  delivery: z.looseObject({ message_id: z.string(), thread_id: z.string().optional(), recipients: z.array(address).optional() }).optional(),
  bounce: z
    .looseObject({
      message_id: z.string(),
      type: z.string().optional(),
      sub_type: z.string().optional(),
      recipients: z.array(z.union([address, z.looseObject({ address: z.string(), status: z.string().optional() })])).optional(),
    })
    .optional(),
  complaint: z
    .looseObject({
      message_id: z.string(),
      type: z.string().optional(),
      sub_type: z.string().optional(),
      recipients: z.array(z.union([address, z.looseObject({ address: z.string() })])).optional(),
    })
    .optional(),
});
export type AgentMailEvent = z.infer<typeof AgentMailEventSchema>;

const STAGE_FOR_LABEL: Record<ReplyLabel, string> = {
  interested: "interested",
  not_interested: "not_interested",
  unsubscribe: "unsubscribed",
  out_of_office: "replied",
  other: "replied",
};

const MAX_BODY = 50_000;

/** Queries that stop pending follow-ups for a lead: open drafts are cancelled, pending send approvals closed. */
function stopFollowUps(sql: Sql, ws: string, leadId: string, reason: string) {
  return [
    sql`with c as (
          update drafts set status = 'cancelled'
          where workspace_id = ${ws} and lead_id = ${leadId} and status in ('draft', 'pending_approval')
          returning id
        )
        insert into events (workspace_id, lead_id, kind, data)
        select ${ws}, ${leadId}, 'followups_stopped', jsonb_build_object('reason', ${reason}::text, 'drafts', jsonb_agg(id))
        from c having count(*) > 0`,
    sql`with v as (
          update approvals set status = 'expired', decided_at = now(), decided_via = ${reason}
          where workspace_id = ${ws} and lead_id = ${leadId} and kind = 'send' and status = 'pending'
          returning code
        )
        insert into events (workspace_id, lead_id, kind, data)
        select ${ws}, ${leadId}, 'approval_closed', jsonb_build_object('code', code, 'reason', ${reason}::text) from v`,
  ];
}

function suppress(sql: Sql, ws: string, email: string, reason: string, leadId: string | null) {
  return sql`with s as (
               insert into suppressions (workspace_id, email, reason) values (${ws}, ${email}, ${reason})
               on conflict (workspace_id, email) do nothing returning email
             )
             insert into events (workspace_id, lead_id, kind, data)
             select ${ws}, ${leadId}, 'suppression_added', jsonb_build_object('email', email, 'reason', ${reason}::text) from s`;
}

type MessageOwner = { workspace_id: string; id: string | null; email: string | null };

/** The workspace (and lead, when known) of a message we sent or stored. Unknown messages belong to the owner workspace. */
async function ownerOfMessage(sql: Sql, providerMessageId: string): Promise<MessageOwner> {
  const rows = await sql`
    select d.workspace_id, l.id, l.email from drafts d join leads l on l.id = d.lead_id where d.provider_message_id = ${providerMessageId}
    union all
    select m.workspace_id, l.id, l.email from messages m left join leads l on l.id = m.lead_id where m.provider_message_id = ${providerMessageId}
    limit 1`;
  return (rows[0] as MessageOwner | undefined) ?? { workspace_id: OWNER_WORKSPACE_ID, id: null, email: null };
}

export type InboundResult = { handled: boolean; detail?: Record<string, unknown> };

export async function handleAgentMailEvent(
  sql: Sql,
  event: AgentMailEvent,
  classifier: ReplyClassifier = keywordClassifier,
): Promise<InboundResult> {
  switch (event.event_type) {
    case "message.received":
      return event.message ? handleReceived(sql, event.message, classifier) : { handled: false };
    case "message.delivered":
      return handleDelivered(sql, event);
    case "message.bounced":
      return handleBounced(sql, event);
    case "message.complained":
      return handleComplained(sql, event);
    default:
      return { handled: false };
  }
}

async function handleReceived(sql: Sql, m: z.infer<typeof MessageSchema>, classifier: ReplyClassifier): Promise<InboundResult> {
  const from = extractEmail(m.from);
  // Match by thread first (the reply is on a thread we started), then by sender address.
  // TODO(auth): sender matching trusts the From header; check AgentMail's authentication_results first.
  let matchedBy: "thread" | "sender" | null = null;
  type MatchedLead = { id: string; email: string | null; stage: string; workspace_id: string };
  let lead = (
    await sql`select l.id, l.email, l.stage, l.workspace_id from leads l
              where l.id = (select lead_id from drafts where provider_thread_id = ${m.thread_id} limit 1)
                 or l.id = (select lead_id from messages where thread_id = ${m.thread_id} and lead_id is not null limit 1)
              limit 1`
  )[0] as MatchedLead | undefined;
  if (lead) matchedBy = "thread";
  else if (from) {
    // Leads we emailed first. The same address may be a lead in several workspaces: then the sender alone
    // does not say whose reply it is, so it stays unmatched rather than guessed. Outside the owner workspace a lead
    // only counts once that workspace has emailed it: the inbox is shared, so adding an address as a lead must not
    // route that person's mail (to the owner, or to another workspace) into the workspace that added it.
    const candidates = (await sql`
      select l.id, l.email, l.stage, l.workspace_id from leads l
      where lower(l.email) = ${from}
        and (l.workspace_id = ${OWNER_WORKSPACE_ID}
             or exists (select 1 from messages o where o.lead_id = l.id and o.workspace_id = l.workspace_id and o.direction = 'out'))
      order by exists (select 1 from messages o where o.lead_id = l.id and o.direction = 'out') desc, l.created_at
      limit 20`) as MatchedLead[];
    if (candidates.length && new Set(candidates.map((c) => c.workspace_id)).size === 1) {
      lead = candidates[0];
      matchedBy = "sender";
    }
  }
  const ws = lead?.workspace_id ?? OWNER_WORKSPACE_ID;

  const duplicate: InboundResult = { handled: true, detail: { duplicate_message: true } };
  if ((await sql`select 1 from messages where provider_message_id = ${m.message_id}`)[0]) return duplicate;

  const text = replyText(m);
  const label = await classifier.classify({ subject: m.subject, text });
  const body = (m.text ?? m.extracted_text ?? m.html ?? "").slice(0, MAX_BODY);
  // The message insert and its side effects commit together: if anything fails the webhook is retried
  // and finds no stored message, instead of a stored message whose lead was never updated.
  const insertMessage = sql`
    insert into messages (workspace_id, lead_id, direction, provider_message_id, thread_id, from_addr, to_addr, subject, body, label)
    values (${ws}, ${lead?.id ?? null}, 'in', ${m.message_id}, ${m.thread_id}, ${m.from ?? null}, ${(m.to ?? []).join(", ")},
            ${m.subject ?? null}, ${body}, ${label})`;
  const run = async (queries: ReturnType<Sql>[]) => {
    try {
      await sql.transaction(queries);
      return true;
    } catch (err) {
      if (isUniqueViolation(err, "messages_provider_message_id_key")) return false; // a concurrent delivery won
      throw err;
    }
  };

  if (!lead) {
    const ok = await run([
      insertMessage,
      sql`insert into events (workspace_id, lead_id, kind, data)
          values (${ws}, null, 'email_received_unmatched', ${JSON.stringify({ message_id: m.message_id, thread_id: m.thread_id, from, label })}::jsonb)`,
    ]);
    return ok ? { handled: true, detail: { matched: false, label } } : duplicate;
  }

  // Unsubscribed is final; a booked meeting stays booked unless the person unsubscribes.
  const stage =
    lead.stage === "unsubscribed"
      ? "unsubscribed"
      : lead.stage === "meeting_booked" && label !== "unsubscribe"
        ? "meeting_booked"
        : STAGE_FOR_LABEL[label];
  const queries = [
    insertMessage,
    sql`update leads set stage = ${stage}, reply_label = ${label}, updated_at = now() where workspace_id = ${ws} and id = ${lead.id}`,
    sql`insert into events (workspace_id, lead_id, kind, data) values (${ws}, ${lead.id}, 'email_received', ${JSON.stringify({
      message_id: m.message_id,
      thread_id: m.thread_id,
      matched_by: matchedBy,
    })}::jsonb)`,
    sql`insert into events (workspace_id, lead_id, kind, data) values (${ws}, ${lead.id}, 'reply_classified', ${JSON.stringify({
      label,
      classifier: "keywords",
      stage_from: lead.stage,
      stage_to: stage,
    })}::jsonb)`,
    ...stopFollowUps(sql, ws, lead.id, "reply_received"),
  ];
  if (label === "unsubscribe") {
    const leadEmail = lead.email?.toLowerCase();
    if (leadEmail) queries.push(suppress(sql, ws, leadEmail, "unsubscribe", lead.id));
    if (from && from !== leadEmail) queries.push(suppress(sql, ws, from, "unsubscribe", lead.id));
  }
  if (!(await run(queries))) return duplicate;
  return { handled: true, detail: { lead_id: lead.id, matched_by: matchedBy, label, stage } };
}

async function handleDelivered(sql: Sql, event: AgentMailEvent): Promise<InboundResult> {
  const d = event.delivery;
  if (!d) return { handled: false };
  const rows = await sql`
    update drafts set delivered_at = coalesce(delivered_at, now())
    where provider_message_id = ${d.message_id}
    returning workspace_id, lead_id`;
  const leadId = (rows[0]?.lead_id as string | undefined) ?? null;
  const ws = (rows[0]?.workspace_id as string | undefined) ?? OWNER_WORKSPACE_ID;
  await sql`insert into events (workspace_id, lead_id, kind, data) values (${ws}, ${leadId}, 'email_delivered', ${JSON.stringify({
    message_id: d.message_id,
    recipients: d.recipients ?? [],
  })}::jsonb)`;
  return { handled: true, detail: { lead_id: leadId } };
}

const recipientAddress = (r: string | { address: string }) => extractEmail(typeof r === "string" ? r : r.address);

async function handleBounced(sql: Sql, event: AgentMailEvent): Promise<InboundResult> {
  const b = event.bounce;
  if (!b) return { handled: false };
  const owner = await ownerOfMessage(sql, b.message_id);
  const ws = owner.workspace_id;
  const lead = owner.id ? owner : undefined;
  const permanent = (b.type ?? "").toLowerCase() === "permanent";
  const addresses = (b.recipients ?? []).flatMap((r) => {
    const status = typeof r === "string" ? undefined : (r as { status?: string }).status;
    const email = recipientAddress(r);
    return email && (status === undefined || status.toLowerCase() === "bounced") ? [email] : [];
  });
  const queries = [
    sql`insert into events (workspace_id, lead_id, kind, data) values (${ws}, ${lead?.id ?? null}, 'email_bounced', ${JSON.stringify({
      message_id: b.message_id,
      type: b.type,
      sub_type: b.sub_type,
      recipients: addresses,
    })}::jsonb)`,
  ];
  // Only a permanent bounce means the address is bad; transient ones (mailbox full, throttling) are logged.
  if (permanent) for (const email of addresses) queries.push(suppress(sql, ws, email, "bounce", lead?.id ?? null));
  await sql.transaction(queries);
  return { handled: true, detail: { lead_id: lead?.id ?? null, permanent, suppressed: permanent ? addresses : [] } };
}

async function handleComplained(sql: Sql, event: AgentMailEvent): Promise<InboundResult> {
  const c = event.complaint;
  if (!c) return { handled: false };
  const owner = await ownerOfMessage(sql, c.message_id);
  const ws = owner.workspace_id;
  const lead = owner.id ? owner : undefined;
  const addresses = (c.recipients ?? []).flatMap((r) => recipientAddress(r) ?? []);
  const leadEmail = lead?.email?.toLowerCase();
  if (leadEmail && !addresses.includes(leadEmail)) addresses.push(leadEmail);
  const queries = [
    sql`insert into events (workspace_id, lead_id, kind, data) values (${ws}, ${lead?.id ?? null}, 'email_complained', ${JSON.stringify({
      message_id: c.message_id,
      type: c.type,
      sub_type: c.sub_type,
    })}::jsonb)`,
    ...addresses.map((email) => suppress(sql, ws, email, "complaint", lead?.id ?? null)),
  ];
  if (lead?.id) {
    queries.push(
      sql`update leads set stage = 'unsubscribed', updated_at = now() where workspace_id = ${ws} and id = ${lead.id}`,
      ...stopFollowUps(sql, ws, lead.id, "complaint"),
    );
  }
  await sql.transaction(queries);
  return { handled: true, detail: { lead_id: lead?.id ?? null, suppressed: addresses } };
}
