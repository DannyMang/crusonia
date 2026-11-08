// AgentMail webhook events: replies, deliveries, bounces and complaints.
// Inbound email is untrusted data. It is stored and pattern-matched for a label, never executed, never
// turned into instructions, and never used to create leads.
import { z } from "zod";
import type { Sql } from "../db.ts";
import { isUniqueViolation } from "../lib/errors.ts";
import { extractEmail } from "./addresses.ts";
import { keywordClassifier, replyText, type ReplyClassifier, type ReplyLabel } from "./classify.ts";

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
function stopFollowUps(sql: Sql, leadId: string, reason: string) {
  return [
    sql`with c as (
          update drafts set status = 'cancelled'
          where lead_id = ${leadId} and status in ('draft', 'pending_approval')
          returning id
        )
        insert into events (lead_id, kind, data)
        select ${leadId}, 'followups_stopped', jsonb_build_object('reason', ${reason}::text, 'drafts', jsonb_agg(id))
        from c having count(*) > 0`,
    sql`with v as (
          update approvals set status = 'expired', decided_at = now(), decided_via = ${reason}
          where lead_id = ${leadId} and kind = 'send' and status = 'pending'
          returning code
        )
        insert into events (lead_id, kind, data)
        select ${leadId}, 'approval_closed', jsonb_build_object('code', code, 'reason', ${reason}::text) from v`,
  ];
}

function suppress(sql: Sql, email: string, reason: string, leadId: string | null) {
  return sql`with s as (
               insert into suppressions (email, reason) values (${email}, ${reason})
               on conflict (email) do nothing returning email
             )
             insert into events (lead_id, kind, data)
             select ${leadId}, 'suppression_added', jsonb_build_object('email', email, 'reason', ${reason}::text) from s`;
}

async function leadForMessage(sql: Sql, providerMessageId: string): Promise<{ id: string; email: string | null } | undefined> {
  const rows = await sql`
    select l.id, l.email from drafts d join leads l on l.id = d.lead_id where d.provider_message_id = ${providerMessageId}
    union all
    select l.id, l.email from messages m join leads l on l.id = m.lead_id where m.provider_message_id = ${providerMessageId}
    limit 1`;
  return rows[0] as { id: string; email: string | null } | undefined;
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
  type MatchedLead = { id: string; email: string | null; stage: string };
  let lead = (
    await sql`select l.id, l.email, l.stage from leads l
              where l.id = (select lead_id from drafts where provider_thread_id = ${m.thread_id} limit 1)
                 or l.id = (select lead_id from messages where thread_id = ${m.thread_id} and lead_id is not null limit 1)
              limit 1`
  )[0] as MatchedLead | undefined;
  if (lead) matchedBy = "thread";
  else if (from) {
    lead = (await sql`select id, email, stage from leads where lower(email) = ${from}`)[0] as MatchedLead | undefined;
    if (lead) matchedBy = "sender";
  }

  const duplicate: InboundResult = { handled: true, detail: { duplicate_message: true } };
  if ((await sql`select 1 from messages where provider_message_id = ${m.message_id}`)[0]) return duplicate;

  const text = replyText(m);
  const label = await classifier.classify({ subject: m.subject, text });
  const body = (m.text ?? m.extracted_text ?? m.html ?? "").slice(0, MAX_BODY);
  // The message insert and its side effects commit together: if anything fails the webhook is retried
  // and finds no stored message, instead of a stored message whose lead was never updated.
  const insertMessage = sql`
    insert into messages (lead_id, direction, provider_message_id, thread_id, from_addr, to_addr, subject, body, label)
    values (${lead?.id ?? null}, 'in', ${m.message_id}, ${m.thread_id}, ${m.from ?? null}, ${(m.to ?? []).join(", ")},
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
      sql`insert into events (lead_id, kind, data)
          values (null, 'email_received_unmatched', ${JSON.stringify({ message_id: m.message_id, thread_id: m.thread_id, from, label })}::jsonb)`,
    ]);
    return ok ? { handled: true, detail: { matched: false, label } } : duplicate;
  }

  const stage = lead.stage === "unsubscribed" ? "unsubscribed" : STAGE_FOR_LABEL[label];
  const queries = [
    insertMessage,
    sql`update leads set stage = ${stage}, reply_label = ${label}, updated_at = now() where id = ${lead.id}`,
    sql`insert into events (lead_id, kind, data) values (${lead.id}, 'email_received', ${JSON.stringify({
      message_id: m.message_id,
      thread_id: m.thread_id,
      matched_by: matchedBy,
    })}::jsonb)`,
    sql`insert into events (lead_id, kind, data) values (${lead.id}, 'reply_classified', ${JSON.stringify({
      label,
      classifier: "keywords",
      stage_from: lead.stage,
      stage_to: stage,
    })}::jsonb)`,
    ...stopFollowUps(sql, lead.id, "reply_received"),
  ];
  if (label === "unsubscribe") {
    const leadEmail = lead.email?.toLowerCase();
    if (leadEmail) queries.push(suppress(sql, leadEmail, "unsubscribe", lead.id));
    if (from && from !== leadEmail) queries.push(suppress(sql, from, "unsubscribe", lead.id));
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
    returning lead_id`;
  const leadId = (rows[0]?.lead_id as string | undefined) ?? null;
  await sql`insert into events (lead_id, kind, data) values (${leadId}, 'email_delivered', ${JSON.stringify({
    message_id: d.message_id,
    recipients: d.recipients ?? [],
  })}::jsonb)`;
  return { handled: true, detail: { lead_id: leadId } };
}

const recipientAddress = (r: string | { address: string }) => extractEmail(typeof r === "string" ? r : r.address);

async function handleBounced(sql: Sql, event: AgentMailEvent): Promise<InboundResult> {
  const b = event.bounce;
  if (!b) return { handled: false };
  const lead = await leadForMessage(sql, b.message_id);
  const permanent = (b.type ?? "").toLowerCase() === "permanent";
  const addresses = (b.recipients ?? []).flatMap((r) => {
    const status = typeof r === "string" ? undefined : (r as { status?: string }).status;
    const email = recipientAddress(r);
    return email && (status === undefined || status.toLowerCase() === "bounced") ? [email] : [];
  });
  const queries = [
    sql`insert into events (lead_id, kind, data) values (${lead?.id ?? null}, 'email_bounced', ${JSON.stringify({
      message_id: b.message_id,
      type: b.type,
      sub_type: b.sub_type,
      recipients: addresses,
    })}::jsonb)`,
  ];
  // Only a permanent bounce means the address is bad; transient ones (mailbox full, throttling) are logged.
  if (permanent) for (const email of addresses) queries.push(suppress(sql, email, "bounce", lead?.id ?? null));
  await sql.transaction(queries);
  return { handled: true, detail: { lead_id: lead?.id ?? null, permanent, suppressed: permanent ? addresses : [] } };
}

async function handleComplained(sql: Sql, event: AgentMailEvent): Promise<InboundResult> {
  const c = event.complaint;
  if (!c) return { handled: false };
  const lead = await leadForMessage(sql, c.message_id);
  const addresses = (c.recipients ?? []).flatMap((r) => recipientAddress(r) ?? []);
  const leadEmail = lead?.email?.toLowerCase();
  if (leadEmail && !addresses.includes(leadEmail)) addresses.push(leadEmail);
  const queries = [
    sql`insert into events (lead_id, kind, data) values (${lead?.id ?? null}, 'email_complained', ${JSON.stringify({
      message_id: c.message_id,
      type: c.type,
      sub_type: c.sub_type,
    })}::jsonb)`,
    ...addresses.map((email) => suppress(sql, email, "complaint", lead?.id ?? null)),
  ];
  if (lead) {
    queries.push(
      sql`update leads set stage = 'unsubscribed', updated_at = now() where id = ${lead.id}`,
      ...stopFollowUps(sql, lead.id, "complaint"),
    );
  }
  await sql.transaction(queries);
  return { handled: true, detail: { lead_id: lead?.id ?? null, suppressed: addresses } };
}
