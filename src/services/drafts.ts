// Email drafts and the approvals that gate them. Nothing here sends anything: a send happens only after
// a human approves the approval row (iMessage / dashboard), in the backend.
import { z } from "zod";
import type { Approval, Draft, Sql } from "../db.ts";
import { newId, shortCode } from "../ids.ts";
import { ServiceError } from "./errors.ts";

/** How long a send approval stays open before the cron marks it expired. */
export const APPROVAL_TTL_HOURS = 48;

// Creating a draft moves the lead to awaiting_approval only from these stages; leads further along
// (sent, replied, ...) keep their stage so a follow-up draft doesn't hide where the conversation is.
const PRE_SEND_STAGES = ["new", "researching", "qualified", "needs_review", "awaiting_approval"];

const text = (max: number) => z.string().trim().min(1).max(max);

export const draftInputSchema = z.object({
  lead_id: text(64).describe("Lead id to write to. The lead must have opted in (has_consent: true)."),
  subject: text(200).describe("Email subject line."),
  body: text(10000).describe("Plain-text email body, ready to send as written. No placeholders like {first_name}."),
});
export type DraftInput = z.infer<typeof draftInputSchema>;

export type CreatedDraft = { draft: Draft; approval: Approval; superseded_approval_codes: string[] };

/**
 * Stores a new immutable draft version for the lead and opens a pending `send` approval for it.
 * Older open drafts become `superseded` and their pending approvals `expired`.
 */
export async function createDraft(sql: Sql, input: DraftInput): Promise<CreatedDraft> {
  const leads = await sql`
    select l.id, l.email, l.name, l.stage, l.consent_at,
           exists (select 1 from suppressions s where s.email = l.email) as suppressed
    from leads l where l.id = ${input.lead_id}`;
  const lead = leads[0];
  if (!lead) throw new ServiceError("not_found", `No lead with id ${input.lead_id}. Use list_leads to find lead ids.`);
  if (!lead.email) throw new ServiceError("invalid", `Lead ${input.lead_id} has no email address, so there is nothing to send to.`);
  if (!lead.consent_at) {
    throw new ServiceError(
      "invalid",
      `Lead ${input.lead_id} has no recorded consent (agent-found leads never do). Crusonia only emails people who opted in, so drafts are only for leads with has_consent: true.`,
    );
  }
  if (lead.suppressed || lead.stage === "unsubscribed") {
    throw new ServiceError("invalid", `Lead ${input.lead_id} unsubscribed or is on the suppression list: do not contact.`);
  }

  const who = lead.name ? `${lead.name} <${lead.email}>` : String(lead.email);
  const summary = `Send "${input.subject}" to ${who}`;

  // Retry on a unique violation: the 4-char approval code collided, or a concurrent draft took the version.
  for (let attempt = 1; ; attempt++) {
    try {
      const rows = await sql`
        with lead as (select id, variant from leads where id = ${input.lead_id}),
        next as (select coalesce(max(version), 0) + 1 as version from drafts where lead_id = ${input.lead_id}),
        superseded as (
          update drafts set status = 'superseded'
          where lead_id = ${input.lead_id} and status in ('draft', 'pending_approval')
          returning id
        ),
        expired as (
          update approvals set status = 'expired', decided_at = now(), decided_via = 'superseded'
          where status = 'pending' and draft_id in (select id from superseded)
          returning code
        ),
        draft as (
          insert into drafts (id, lead_id, version, variant, subject, body, status)
          select ${newId("draft")}, lead.id, next.version, lead.variant, ${input.subject}, ${input.body}, 'pending_approval'
          from lead, next
          returning *
        ),
        approval as (
          insert into approvals (code, kind, lead_id, draft_id, summary, expires_at)
          select ${shortCode()}, 'send', lead_id, id, ${summary}, now() + make_interval(hours => ${APPROVAL_TTL_HOURS}::int)
          from draft
          returning *
        ),
        stage as (
          update leads set stage = case when stage = any(${PRE_SEND_STAGES}::text[]) then 'awaiting_approval' else stage end,
                           updated_at = now()
          where id in (select lead_id from draft)
        ),
        ev as (
          insert into events (lead_id, kind, data)
          select d.lead_id, 'draft_created',
                 jsonb_build_object('via', 'mcp', 'draft_id', d.id, 'version', d.version, 'approval_code', a.code,
                                    'superseded_drafts', (select coalesce(jsonb_agg(id), '[]'::jsonb) from superseded))
          from draft d, approval a
        )
        select to_jsonb(d) as draft, to_jsonb(a) as approval,
               (select coalesce(jsonb_agg(code), '[]'::jsonb) from expired) as superseded_approval_codes
        from draft d, approval a`;
      if (!rows[0]) throw new ServiceError("not_found", `No lead with id ${input.lead_id}.`);
      return rows[0] as CreatedDraft;
    } catch (err) {
      if (attempt < 4 && (err as { code?: string }).code === "23505") continue;
      throw err;
    }
  }
}

export type PendingApproval = Pick<Approval, "code" | "kind" | "summary" | "lead_id" | "draft_id" | "expires_at" | "created_at"> & {
  lead_name: string | null;
  lead_email: string | null;
  lead_company: string | null;
  draft_version: number | null;
  draft_subject: string | null;
  draft_body: string | null;
};

/** Open approvals (pending and not yet expired), oldest first. Read-only: deciding happens elsewhere. */
export async function listPendingApprovals(sql: Sql, limit = 50): Promise<PendingApproval[]> {
  const rows = await sql`
    select a.code, a.kind, a.summary, a.lead_id, a.draft_id, a.expires_at, a.created_at,
           l.name as lead_name, l.email as lead_email, l.company as lead_company,
           d.version as draft_version, d.subject as draft_subject, d.body as draft_body
    from approvals a
    left join leads l on l.id = a.lead_id
    left join drafts d on d.id = a.draft_id
    where a.status = 'pending' and a.expires_at > now()
    order by a.created_at
    limit ${Math.min(Math.max(limit, 1), 200)}`;
  return rows as PendingApproval[];
}
