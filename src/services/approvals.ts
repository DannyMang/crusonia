// Approvals: one row per human decision. The only kind is `send`: a draft email, bound to the exact recipient and
// draft version (approve runs ./send.ts). Drafts and send approvals are created by createDraft (./drafts.ts, shared
// with the MCP tools). Each approval is consumed once: a conditional `status = 'pending'` update claims it before acting.
// Approval codes are unique across the instance, but every lookup is filtered by the caller's workspace.
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { ApiError, notFound } from "../lib/errors.ts";
import type { FetchFn } from "../providers/http.ts";
import { createDraft } from "./drafts.ts";

export type ApprovalRow = {
  code: string;
  workspace_id: string;
  kind: "send";
  lead_id: string | null;
  draft_id: string | null;
  recipient: string | null;
  summary: string;
  payload: Record<string, unknown>;
  status: string;
  answer: string | null;
  decided_via: string | null;
  expires_at: Date;
  decided_at: Date | null;
  created_at: Date;
};

/**
 * `ws`: the caller's workspace. `sendTtlMinutes`: lifetime of the send approval an edit opens (SEND_APPROVAL_TTL_HOURS).
 * `via`: the channel recorded as `decided_via` and on the audit events ('api').
 */
export type Deps = { sql: Sql; ws: string; env: Env; fetch?: FetchFn; actor: string; sendTtlMinutes: number; via?: DecisionChannel };

export type DecisionChannel = "api";

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "answered", "expired"] as const;

/** Approvals with their draft and lead. `pending` hides rows past expiry that the cron has not closed yet. */
export async function listApprovals(sql: Sql, ws: string, f: { status: string; kind?: string; lead_id?: string; limit: number }) {
  return sql`
    select a.code, a.kind, a.status, a.summary, a.recipient, a.lead_id, a.draft_id, a.payload, a.answer, a.expires_at, a.decided_at, a.decided_via, a.created_at,
           case when d.id is null then null else jsonb_build_object(
             'id', d.id, 'version', d.version, 'variant', d.variant, 'subject', d.subject, 'body', d.body, 'status', d.status,
             'scheduled_for', d.scheduled_for
           ) end as draft,
           case when l.id is null then null else jsonb_build_object(
             'id', l.id, 'email', l.email, 'name', l.name, 'company', l.company, 'stage', l.stage,
             'has_consent', l.consent_at is not null
           ) end as lead
    from approvals a
    left join drafts d on d.id = a.draft_id
    left join leads l on l.id = a.lead_id
    where a.workspace_id = ${ws} and a.status = ${f.status}
      and (${f.status} <> 'pending' or a.expires_at > now())
      and (${f.kind ?? null}::text is null or a.kind = ${f.kind ?? null})
      and (${f.lead_id ?? null}::text is null or a.lead_id = ${f.lead_id ?? null})
    order by a.created_at desc
    limit ${f.limit}`;
}

export async function getApproval(sql: Sql, ws: string, code: string): Promise<ApprovalRow> {
  const rows = await sql`select * from approvals where workspace_id = ${ws} and code = ${code.toUpperCase()}`;
  if (!rows[0]) throw notFound("Approval");
  return rows[0] as ApprovalRow;
}

function notPending(a: ApprovalRow): ApiError {
  if (a.status === "pending" && new Date(a.expires_at) <= new Date()) return new ApiError(410, "approval_expired", "Approval has expired");
  return new ApiError(409, "approval_not_pending", `Approval is ${a.status}${a.decided_via ? ` (${a.decided_via})` : ""}`);
}

// ---------- reject ----------

export async function rejectApproval(deps: Deps, code: string, reason: string | undefined) {
  const { sql, ws, actor } = deps;
  const via = deps.via ?? "api";
  const approval = await getApproval(sql, ws, code);
  const rows = await sql`
    with a as (
      update approvals set status = 'rejected', decided_at = now(), decided_via = ${via}, answer = ${reason ?? null}
      where workspace_id = ${ws} and code = ${approval.code} and status = 'pending'
      returning *
    ), d as (
      update drafts set status = 'rejected' where id = (select draft_id from a) and status = 'pending_approval'
    ), ev as (
      insert into events (workspace_id, lead_id, kind, data)
      select workspace_id, lead_id, 'approval_rejected',
             jsonb_build_object('via', ${via}::text, 'code', code, 'draft_id', draft_id, 'reason', ${reason ?? null}::text, 'actor', ${actor}::text)
      from a
    )
    select * from a`;
  if (!rows[0]) throw notPending(approval);
  return { approval: rows[0] as ApprovalRow };
}

// ---------- edit ----------

/**
 * Edit = a new immutable draft version plus a new approval (createDraft closes the old one). Also the way
 * to retry: allowed on pending, expired and rejected approvals, and on approved ones whose send failed.
 * Never on a draft that was sent or is sending, and only for the lead's latest version.
 */
export async function editApproval(deps: Deps, code: string, edit: { subject?: string; body?: string }) {
  const { sql, ws } = deps;
  const approval = await getApproval(sql, ws, code);
  const [draft] = await sql`
    select d.subject, d.body, d.status, d.version,
           (select max(version) from drafts where lead_id = d.lead_id) as latest_version
    from drafts d where d.workspace_id = ${ws} and d.id = ${approval.draft_id}`;
  if (!draft) throw new ApiError(409, "draft_missing", "The draft for this approval no longer exists");
  if (draft.version !== draft.latest_version) {
    throw new ApiError(409, "draft_superseded", `Draft v${draft.version} was superseded by v${draft.latest_version}; edit the newest approval`);
  }
  const editable =
    ["pending", "expired", "rejected"].includes(approval.status) ||
    (approval.status === "approved" && draft.status === "send_failed");
  if (!editable) throw new ApiError(409, "not_editable", `Approval is ${approval.status} and its draft is ${draft.status}`);
  return createDraft(
    sql,
    ws,
    { lead_id: approval.lead_id!, subject: edit.subject ?? draft.subject, body: edit.body ?? draft.body },
    { ttlMinutes: deps.sendTtlMinutes, via: deps.via ?? "api", actor: deps.actor },
  );
}

// ---------- expiry (cron) ----------

export async function expireStaleApprovals(sql: Sql) {
  const expired = await sql`
    with x as (
      update approvals set status = 'expired', decided_at = now(), decided_via = 'timeout'
      where status = 'pending' and expires_at <= now()
      returning code, workspace_id, kind, lead_id, draft_id
    ), d as (
      update drafts set status = 'draft'
      where id in (select draft_id from x where kind = 'send') and status = 'pending_approval'
    ), ev as (
      insert into events (workspace_id, lead_id, kind, data)
      select workspace_id, lead_id, 'approval_expired', jsonb_build_object('code', code, 'kind', kind) from x
    )
    select code from x`;
  return expired.length;
}
