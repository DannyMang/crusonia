// Approvals: one row per human decision. Kinds:
//   send      a draft email, bound to the exact recipient and draft version (approve runs ./send.ts)
//   tool      a Naive tool call outside the owner's auto-confirm policy (approve = allow, reject = deny)
//   question  an ask_operator question from the agent (answer forwards the owner's answers)
// Drafts and send approvals are created by createDraft (./drafts.ts, shared with the MCP tools).
// Each approval is consumed once: a conditional `status = 'pending'` update claims it before acting.
// Approval codes are unique across the instance, but every lookup is filtered by the caller's workspace.
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { shortCode } from "../ids.ts";
import { ApiError, isUniqueViolation, notConfigured, notFound } from "../lib/errors.ts";
import { ProviderError, type FetchFn } from "../providers/http.ts";
import { NaiveClient, type PendingAction } from "../providers/naive.ts";
import { createDraft } from "./drafts.ts";

export type ApprovalRow = {
  code: string;
  workspace_id: string;
  kind: "send" | "tool" | "question";
  lead_id: string | null;
  draft_id: string | null;
  naive_session_id: string | null;
  tool_call_id: string | null;
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
 * `via`: the channel recorded as `decided_via` and on the audit events ('api' by default, 'imessage' from the bridge).
 */
export type Deps = { sql: Sql; ws: string; env: Env; fetch?: FetchFn; actor: string; sendTtlMinutes: number; via?: DecisionChannel };

export type DecisionChannel = "api" | "imessage";

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "answered", "expired"] as const;

/**
 * Approvals with their draft and lead. `pending` hides rows past expiry that the cron has not closed yet.
 * `texted_at`: when the bridge confirmed the iMessage notice for this approval went out (null if it was not texted).
 */
export async function listApprovals(sql: Sql, ws: string, f: { status: string; kind?: string; lead_id?: string; limit: number }) {
  return sql`
    select a.code, a.kind, a.status, a.summary, a.recipient, a.lead_id, a.draft_id, a.naive_session_id,
           a.tool_call_id, a.payload, a.answer, a.expires_at, a.decided_at, a.decided_via, a.created_at,
           (select o.delivered_at from imessage_outbox o where o.id = 'approval:' || a.code and o.workspace_id = a.workspace_id) as texted_at,
           case when d.id is null then null else jsonb_build_object(
             'id', d.id, 'version', d.version, 'variant', d.variant, 'subject', d.subject, 'body', d.body, 'status', d.status
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

const eventRow = (sql: Sql, ws: string, leadId: string | null, kind: string, data: Record<string, unknown>) =>
  sql`insert into events (workspace_id, lead_id, kind, data) values (${ws}, ${leadId}, ${kind}, ${JSON.stringify(data)}::jsonb)`;

// ---------- reject ----------

export async function rejectApproval(deps: Deps, code: string, reason: string | undefined) {
  const { sql, ws, actor } = deps;
  const via = deps.via ?? "api";
  const approval = await getApproval(sql, ws, code);
  if (approval.kind === "tool") return resolveTool(deps, approval, { decision: "deny", reason });
  if (approval.kind === "question") {
    throw new ApiError(409, "wrong_kind", "Questions cannot be rejected; answer them with POST /api/approvals/:code/answer");
  }
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
  if (approval.kind !== "send") throw new ApiError(409, "wrong_kind", `Only send approvals can be edited (this is ${approval.kind})`);
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

// ---------- tool and question approvals (Naive) ----------

function naive(deps: Deps): NaiveClient {
  if (!deps.env.NAIVE_API_KEY) throw notConfigured("NAIVE_API_KEY");
  return new NaiveClient(deps.env.NAIVE_API_KEY, deps.fetch);
}

function providerFailure(err: unknown): ApiError {
  if (err instanceof ProviderError) return new ApiError(502, `${err.provider}_error`, err.message);
  return err instanceof ApiError ? err : new ApiError(502, "provider_error", String(err));
}

export type ToolDecision = { decision: "allow" | "deny"; reason?: string; scope?: "call" | "session" };

export async function resolveTool(deps: Deps, approval: ApprovalRow, decision: ToolDecision) {
  const { sql, ws, actor } = deps;
  const via = deps.via ?? "api";
  if (approval.kind !== "tool") throw new ApiError(409, "wrong_kind", `This is a ${approval.kind} approval`);
  if (approval.workspace_id !== ws) throw notFound("Approval");
  const client = naive(deps);
  const status = decision.decision === "allow" ? "approved" : "rejected";
  const claimed = await sql`
    update approvals set status = ${status}, decided_at = now(), decided_via = ${via}, answer = ${JSON.stringify(decision)}
    where workspace_id = ${ws} and code = ${approval.code} and status = 'pending' and expires_at > now()
    returning *`;
  if (!claimed[0]) throw notPending(approval);
  try {
    await client.confirmTool(approval.naive_session_id!, {
      tool_call_id: approval.tool_call_id!,
      decision: decision.decision,
      ...(decision.reason ? { reason: decision.reason } : {}),
      ...(decision.decision === "allow" && decision.scope ? { scope: decision.scope } : {}),
    });
  } catch (err) {
    // Release the claim so the owner can retry; the provider never recorded a decision.
    await sql`update approvals set status = 'pending', decided_at = null, decided_via = null, answer = null
              where workspace_id = ${ws} and code = ${approval.code} and status = ${status}`;
    throw providerFailure(err);
  }
  await sql.transaction([
    sql`update naive_sessions set status = 'running', updated_at = now() where workspace_id = ${ws} and id = ${approval.naive_session_id}`,
    eventRow(sql, ws, approval.lead_id, "naive_tool_decided", {
      via,
      code: approval.code,
      session_id: approval.naive_session_id,
      tool: approval.payload?.name,
      decision: decision.decision,
      actor,
    }),
  ]);
  return { approval: claimed[0] as ApprovalRow };
}

export async function answerQuestion(deps: Deps, approval: ApprovalRow, answers: Record<string, string | string[]>) {
  const { sql, ws, actor } = deps;
  const via = deps.via ?? "api";
  if (approval.kind !== "question") throw new ApiError(409, "wrong_kind", `This is a ${approval.kind} approval`);
  if (approval.workspace_id !== ws) throw notFound("Approval");
  const fields = ((approval.payload?.question as PendingAction["question"])?.fields ?? []) as { key: string; multiple?: boolean }[];
  const keys = new Set(fields.map((f) => f.key));
  const unknown = Object.keys(answers).filter((k) => !keys.has(k));
  const missing = [...keys].filter((k) => answers[k] === undefined || answers[k] === "");
  if (unknown.length || missing.length) {
    throw new ApiError(400, "invalid_answers", "answers must have exactly one entry per question field", { fields: [...keys], unknown, missing });
  }
  for (const f of fields) {
    if (Array.isArray(answers[f.key]) && !f.multiple) throw new ApiError(400, "invalid_answers", `Field ${f.key} takes a single string`);
  }
  const client = naive(deps);
  const claimed = await sql`
    update approvals set status = 'answered', decided_at = now(), decided_via = ${via}, answer = ${JSON.stringify(answers)}
    where workspace_id = ${ws} and code = ${approval.code} and status = 'pending' and expires_at > now()
    returning *`;
  if (!claimed[0]) throw notPending(approval);
  try {
    await client.answer(approval.naive_session_id!, { tool_call_id: approval.tool_call_id!, answers });
  } catch (err) {
    await sql`update approvals set status = 'pending', decided_at = null, decided_via = null, answer = null
              where workspace_id = ${ws} and code = ${approval.code} and status = 'answered'`;
    throw providerFailure(err);
  }
  await sql.transaction([
    sql`update naive_sessions set status = 'running', updated_at = now() where workspace_id = ${ws} and id = ${approval.naive_session_id}`,
    eventRow(sql, ws, approval.lead_id, "naive_question_answered", { via, code: approval.code, session_id: approval.naive_session_id, actor }),
  ]);
  return { approval: claimed[0] as ApprovalRow };
}

/**
 * Creates a 'tool' or 'question' approval for a parked Naive action. Idempotent per (session, tool_call_id).
 * `ttlMinutes` is TOOL_APPROVAL_TTL_MINUTES: the session is blocked until it is decided or expires.
 */
export async function createAgentApproval(
  sql: Sql,
  input: { workspaceId: string; sessionId: string; leadId: string | null; action: PendingAction; ttlMinutes: number },
): Promise<string | null> {
  const { action } = input;
  const kind = action.kind === "question" ? "question" : "tool";
  const argsJson = JSON.stringify(action.args ?? {});
  // Agent-supplied content is untrusted: stored as data (args truncated) and shown to the owner as such.
  const payload =
    kind === "question"
      ? { name: action.name, question: action.question ?? { prompt: "", fields: [] } }
      : { name: action.name, args: argsJson.length > 4000 ? { truncated: argsJson.slice(0, 4000) } : (action.args ?? {}) };
  const summary =
    kind === "question"
      ? `Agent asks: ${(action.question?.prompt ?? "").slice(0, 200)}`
      : `Agent wants to run ${action.name}${argsJson === "{}" ? "" : ` with ${argsJson.slice(0, 160)}`}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const rows = await sql`
        with ins as (
          insert into approvals (code, workspace_id, kind, lead_id, naive_session_id, tool_call_id, summary, payload, expires_at)
          values (${shortCode()}, ${input.workspaceId}, ${kind}, ${input.leadId}, ${input.sessionId}, ${action.tool_call_id}, ${summary},
                  ${JSON.stringify(payload)}::jsonb, now() + make_interval(mins => ${input.ttlMinutes}::int))
          on conflict (naive_session_id, tool_call_id) where tool_call_id is not null do nothing
          returning code, workspace_id, lead_id
        ), ev as (
          insert into events (workspace_id, lead_id, kind, data)
          select workspace_id, lead_id, 'approval_requested',
                 jsonb_build_object('via', 'naive', 'code', code, 'kind', ${kind}::text, 'session_id', ${input.sessionId}::text,
                                    'tool', ${action.name}::text)
          from ins
        )
        select code from ins`;
      return (rows[0]?.code as string | undefined) ?? null;
    } catch (err) {
      if (attempt < 4 && isUniqueViolation(err, "approvals_pkey")) continue; // 4-char code collision
      throw err;
    }
  }
}

// ---------- expiry (cron) ----------

export async function expireStaleApprovals(sql: Sql, env: Env, fetchFn?: FetchFn) {
  const expired = (await sql`
    with x as (
      update approvals set status = 'expired', decided_at = now(), decided_via = 'timeout'
      where status = 'pending' and expires_at <= now()
      returning code, workspace_id, kind, lead_id, draft_id, naive_session_id, tool_call_id
    ), d as (
      update drafts set status = 'draft'
      where id in (select draft_id from x where kind = 'send') and status = 'pending_approval'
    ), ev as (
      insert into events (workspace_id, lead_id, kind, data)
      select workspace_id, lead_id, 'approval_expired', jsonb_build_object('code', code, 'kind', kind) from x
    )
    select * from x`) as Pick<ApprovalRow, "code" | "kind" | "lead_id" | "naive_session_id" | "tool_call_id">[];

  // Fail closed: a tool call nobody approved in time is denied, so the session does not hang forever.
  const tools = expired.filter((a) => a.kind === "tool" && a.naive_session_id && a.tool_call_id);
  if (tools.length && env.NAIVE_API_KEY) {
    const client = new NaiveClient(env.NAIVE_API_KEY, fetchFn);
    for (const a of tools) {
      try {
        await client.confirmTool(a.naive_session_id!, {
          tool_call_id: a.tool_call_id!,
          decision: "deny",
          reason: "The owner did not approve this tool call before the approval expired.",
        });
      } catch (err) {
        console.error(`deny after expiry failed for ${a.code}:`, err instanceof Error ? err.message : err);
      }
    }
  }
  return expired.length;
}
