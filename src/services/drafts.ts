// Drafts, the approvals that gate email drafts, and manual-channel tasks. Nothing here sends anything: an email
// goes out only after a human approves its approval row (web / iMessage), in the backend; a manual draft (LinkedIn,
// X, intro, the owner's own mailbox) is a task the owner sends personally. Channel rules: ./channels.ts.
import { z } from "zod";
import type { Approval, Draft, Sql } from "../db.ts";
import { newId, shortCode } from "../ids.ts";
import {
  CHANNEL_LABEL,
  DRAFT_CHANNELS,
  checkChannel,
  citationProblems,
  citationSchema,
  isManualChannel,
  taskTitle,
  type Citation,
  type DraftChannel,
} from "./channels.ts";
import { ServiceError } from "./errors.ts";

// Creating an email draft moves the lead to awaiting_approval only from these stages; leads further along
// (sent, replied, ...) keep their stage so a follow-up draft doesn't hide where the conversation is.
// Manual drafts never change the stage: marking the task sent does (./tasks.ts).
const PRE_SEND_STAGES = ["new", "researching", "qualified", "needs_review", "awaiting_approval"];

const text = (max: number) => z.string().trim().min(1).max(max);

export const draftInputSchema = z
  .object({
    lead_id: text(64).describe("Lead id to write to."),
    channel: z
      .enum(DRAFT_CHANNELS)
      .default("email")
      .describe(
        "email: AgentMail, only for opted-in leads (has_consent: true), sent only after the owner approves. email_manual: the owner sends it from their own mailbox (lead has an email, no consent needed). linkedin, x: the owner sends it on that network (needs the person's profile URL). intro: a short forwardable blurb asking for a warm introduction. Manual channels are tasks for the owner and need a qualified lead.",
      ),
    subject: text(200).nullish().describe("Subject line. Required for email and email_manual; optional for the other channels."),
    body: text(10000).describe("Plain-text message, ready to send as written. No placeholders like {first_name}."),
    profile_url: z
      .httpUrl()
      .max(2048)
      .nullish()
      .describe("linkedin / x: the person's profile URL from a page you read (linkedin defaults to the lead's linkedin_url). intro: optional, the profile of the person you would ask."),
    citations: z
      .array(citationSchema)
      .max(10)
      .default([])
      .describe("For every factual sentence: the phrase from the body and the source_url of the lead's saved evidence that supports it. Required (at least one) for manual channels."),
  })
  .refine((d) => !(d.channel === "email" || d.channel === "email_manual") || Boolean(d.subject), {
    message: "subject is required for email and email_manual",
    path: ["subject"],
  });

/** What createDraft accepts (REST and approval edits pass only lead_id, subject and body: an email draft). */
export type DraftInput = {
  lead_id: string;
  subject?: string | null;
  body: string;
  channel?: DraftChannel;
  profile_url?: string | null;
  citations?: Citation[];
};

export type CreatedDraft = { draft: Draft; approval: Approval; superseded_approval_codes: string[] };
/** A manual-channel draft: a task in the owner's queue, never an approval. */
export type CreatedTask = { draft: Draft; approval: null; superseded_approval_codes: string[]; task: true; note: string };

type LeadRow = {
  id: string;
  email: string | null;
  name: string | null;
  company: string | null;
  linkedin_url: string | null;
  stage: string;
  consent_at: Date | null;
  qualified: boolean | null;
  suppressed: boolean;
  evidence_urls: string[];
};

/**
 * Stores a new immutable draft version for the lead. One open draft per lead across channels: older open drafts
 * become `superseded` and their pending approvals `expired`.
 *  - email: opens a pending `send` approval bound to the lead's current email (`recipient`) and this exact version.
 *    `opts.ttlMinutes` is its lifetime (sendApprovalTtlMinutes(env): SEND_APPROVAL_TTL_HOURS, 7 days by default).
 *  - manual channels: status `open`, no approval; the owner marks it sent or skipped (./tasks.ts).
 * `opts.via` labels the event ('mcp' by default, 'api' for REST).
 */
export async function createDraft(sql: Sql, ws: string, input: DraftInput & { channel?: "email" }, opts: DraftOpts): Promise<CreatedDraft>;
export async function createDraft(sql: Sql, ws: string, input: DraftInput, opts: DraftOpts): Promise<CreatedDraft | CreatedTask>;
export async function createDraft(sql: Sql, ws: string, input: DraftInput, opts: DraftOpts): Promise<CreatedDraft | CreatedTask> {
  const { ttlMinutes } = opts;
  const via = opts.via ?? "mcp";
  const channel: DraftChannel = input.channel ?? "email";
  const citations = input.citations ?? [];
  const leads = (await sql`
    select l.id, l.email, l.name, l.company, l.linkedin_url, l.stage, l.consent_at, l.qualified,
           exists (select 1 from suppressions s where s.workspace_id = l.workspace_id and s.email = l.email) as suppressed,
           array(select e.source_url from evidence e where e.workspace_id = l.workspace_id and e.lead_id = l.id) as evidence_urls
    from leads l where l.workspace_id = ${ws} and l.id = ${input.lead_id}`) as LeadRow[];
  const lead = leads[0];
  if (!lead) throw new ServiceError("not_found", `No lead with id ${input.lead_id}. Use list_leads to find lead ids.`);
  const check = checkChannel(lead, { channel, profile_url: input.profile_url });
  if (!check.ok) throw new ServiceError("invalid", check.message);
  const problems = citationProblems(input.body, citations, lead.evidence_urls ?? [], isManualChannel(channel));
  if (problems.length) throw new ServiceError("invalid", `Fix the citations: ${problems.join(" ")}`);

  if (isManualChannel(channel)) {
    const subject = input.subject?.trim() || taskTitle(channel, lead);
    return createTask(sql, ws, {
      lead,
      channel,
      subject,
      body: input.body,
      targetUrl: check.target_url,
      citations,
      via,
      actor: opts.actor,
      sessionId: opts.sessionId ?? null,
      workflowVersion: opts.workflowVersion ?? null,
    });
  }
  if (!input.subject) throw new ServiceError("invalid", "An email draft needs a subject.");
  const subject = input.subject;

  const who = lead.name ? `${lead.name} <${lead.email}>` : String(lead.email);
  const summary = `Send "${subject}" to ${who}`;

  // Retry on a unique violation: the 4-char approval code collided, or a concurrent draft took the version.
  for (let attempt = 1; ; attempt++) {
    try {
      const rows = await sql`
        with lead as (select id, workspace_id, variant from leads where workspace_id = ${ws} and id = ${input.lead_id}),
        next as (select coalesce(max(version), 0) + 1 as version from drafts where lead_id = ${input.lead_id}),
        superseded as (
          update drafts set status = 'superseded'
          where workspace_id = ${ws} and lead_id = ${input.lead_id} and status in ('draft', 'pending_approval', 'open')
          returning id
        ),
        expired as (
          update approvals set status = 'expired', decided_at = now(), decided_via = 'superseded'
          where workspace_id = ${ws} and status = 'pending' and draft_id in (select id from superseded)
          returning code
        ),
        draft as (
          insert into drafts (id, workspace_id, lead_id, version, variant, subject, body, status, channel, citations, session_id, workflow_version)
          select ${newId("draft")}, lead.workspace_id, lead.id, next.version, lead.variant, ${subject}, ${input.body}, 'pending_approval',
                 'email', ${JSON.stringify(citations)}::jsonb, ${opts.sessionId ?? null}, ${opts.workflowVersion ?? null}
          from lead, next
          returning *
        ),
        approval as (
          insert into approvals (code, workspace_id, kind, lead_id, draft_id, recipient, summary, expires_at)
          select ${shortCode()}, workspace_id, 'send', lead_id, id, ${lead.email}, ${summary}, now() + make_interval(mins => ${ttlMinutes}::int)
          from draft
          returning *
        ),
        stage as (
          update leads set stage = case when stage = any(${PRE_SEND_STAGES}::text[]) then 'awaiting_approval' else stage end,
                           updated_at = now()
          where workspace_id = ${ws} and id in (select lead_id from draft)
        ),
        ev as (
          insert into events (workspace_id, lead_id, kind, data)
          select d.workspace_id, d.lead_id, 'draft_created',
                 jsonb_build_object('via', ${via}::text, 'draft_id', d.id, 'version', d.version, 'approval_code', a.code,
                                    'channel', 'email',
                                    'superseded_drafts', (select coalesce(jsonb_agg(id), '[]'::jsonb) from superseded),
                                    'actor', ${opts.actor ?? null}::text)
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

/** `sessionId` / `workflowVersion`: the agent run that wrote the draft and the workflow version it ran (null for a person). */
type DraftOpts = { ttlMinutes: number; via?: string; actor?: string; sessionId?: string | null; workflowVersion?: string | null };

async function createTask(
  sql: Sql,
  ws: string,
  t: {
    lead: LeadRow;
    channel: DraftChannel;
    subject: string;
    body: string;
    targetUrl: string | null;
    citations: Citation[];
    via: string;
    actor?: string;
    sessionId: string | null;
    workflowVersion: string | null;
  },
): Promise<CreatedTask> {
  for (let attempt = 1; ; attempt++) {
    try {
      const rows = await sql`
        with lead as (select id, workspace_id, variant from leads where workspace_id = ${ws} and id = ${t.lead.id}),
        next as (select coalesce(max(version), 0) + 1 as version from drafts where lead_id = ${t.lead.id}),
        superseded as (
          update drafts set status = 'superseded'
          where workspace_id = ${ws} and lead_id = ${t.lead.id} and status in ('draft', 'pending_approval', 'open')
          returning id
        ),
        expired as (
          update approvals set status = 'expired', decided_at = now(), decided_via = 'superseded'
          where workspace_id = ${ws} and status = 'pending' and draft_id in (select id from superseded)
          returning code
        ),
        draft as (
          insert into drafts (id, workspace_id, lead_id, version, variant, subject, body, status, channel, target_url, citations, session_id, workflow_version)
          select ${newId("draft")}, lead.workspace_id, lead.id, next.version, lead.variant, ${t.subject}, ${t.body}, 'open',
                 ${t.channel}, ${t.targetUrl}, ${JSON.stringify(t.citations)}::jsonb, ${t.sessionId}, ${t.workflowVersion}
          from lead, next
          returning *
        ),
        touch as (update leads set updated_at = now() where workspace_id = ${ws} and id in (select lead_id from draft)),
        ev as (
          insert into events (workspace_id, lead_id, kind, data)
          select d.workspace_id, d.lead_id, 'draft_created',
                 jsonb_build_object('via', ${t.via}::text, 'draft_id', d.id, 'version', d.version, 'channel', d.channel,
                                    'task', true, 'target_url', d.target_url,
                                    'superseded_drafts', (select coalesce(jsonb_agg(id), '[]'::jsonb) from superseded),
                                    'actor', ${t.actor ?? null}::text)
          from draft d
        )
        select to_jsonb(d) as draft, (select coalesce(jsonb_agg(code), '[]'::jsonb) from expired) as superseded_approval_codes
        from draft d`;
      if (!rows[0]) throw new ServiceError("not_found", `No lead with id ${t.lead.id}.`);
      const row = rows[0] as { draft: Draft; superseded_approval_codes: string[] };
      return {
        draft: row.draft,
        approval: null,
        superseded_approval_codes: row.superseded_approval_codes,
        task: true,
        note: `Saved as a manual task (${CHANNEL_LABEL[t.channel]}) in the owner's queue. Nothing sends it: the owner sends it personally and marks it sent or skipped.`,
      };
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

/** The workspace's open approvals (pending and not yet expired), oldest first. Read-only: deciding happens elsewhere. */
export async function listPendingApprovals(sql: Sql, ws: string, limit = 50): Promise<PendingApproval[]> {
  const rows = await sql`
    select a.code, a.kind, a.summary, a.lead_id, a.draft_id, a.expires_at, a.created_at,
           l.name as lead_name, l.email as lead_email, l.company as lead_company,
           d.version as draft_version, d.subject as draft_subject, d.body as draft_body
    from approvals a
    left join leads l on l.id = a.lead_id
    left join drafts d on d.id = a.draft_id
    where a.workspace_id = ${ws} and a.status = 'pending' and a.expires_at > now()
    order by a.created_at
    limit ${Math.min(Math.max(limit, 1), 200)}`;
  return rows as PendingApproval[];
}
