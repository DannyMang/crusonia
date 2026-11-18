// The agent job queue. Every piece of agent work (onboarding, find_leads, research, redraft, operate) is one row in
// agent_runs: queued when Crusonia or the owner asks for it, running once an agent claims it, then done or error.
// Crusonia does not run the agent itself here: whoever claims the run (an agent connected over MCP, or the built-in
// runner) gets its first message and a run id, and works through the MCP tools with that id.
//
// A run carries its own limits, fixed when it is queued and checked on every tool call that names the run:
//   deadline_at      claimed_at + max_minutes; past it the run is closed and its run id stops working
//   max_tool_calls   tool calls the run may make
//   max_cost_micro_usd  model spend the built-in runner may use (an agent you connect pays for its own model)
// A run nobody claims within RUN_QUEUE_TTL_MINUTES is closed too. Closing is quiet: status 'error' with a stop_reason
// the feed can show (out_of_time, out_of_tool_calls, out_of_budget, unclaimed).
import { settleSessionUsage } from "../billing/usage.ts";
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { newId } from "../ids.ts";

export type RunPurpose = "onboarding" | "find_leads" | "research" | "redraft" | "operate";
export type RunRole = "researcher" | "operator";
export type RunStopReason = "finished" | "failed" | "out_of_time" | "out_of_tool_calls" | "out_of_budget" | "unclaimed";

/** Runs an agent has not finished: waiting for one, or being worked on. */
export const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;

export const roleFor = (purpose: string): RunRole => (purpose === "operate" ? "operator" : "researcher");

export type RunLimits = { minutes: number; toolCalls: number; costMicroUsd: number };

const positive = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return raw?.trim() && Number.isFinite(n) && n > 0 ? n : fallback;
};

/** The limits a new run of `purpose` gets. An Operator cycle decides and delegates, so it gets less of everything. */
export function runLimits(env: Env, purpose: string): RunLimits {
  if (purpose === "operate") {
    return {
      minutes: Math.trunc(positive(env.OPERATOR_MAX_MINUTES, 10)),
      toolCalls: Math.trunc(positive(env.OPERATOR_MAX_TOOL_CALLS, 25)),
      costMicroUsd: Math.round(positive(env.OPERATOR_MAX_COST_USD, 0.25) * 1_000_000),
    };
  }
  return {
    minutes: Math.trunc(positive(env.RUN_MAX_MINUTES, 15)),
    toolCalls: Math.trunc(positive(env.RUN_MAX_TOOL_CALLS, 60)),
    costMicroUsd: Math.round(positive(env.RUN_MAX_COST_USD, 1) * 1_000_000),
  };
}

export const queueTtlMinutes = (env: Env) => Math.trunc(positive(env.RUN_QUEUE_TTL_MINUTES, 60));

export type NewRun = {
  id: string;
  ws: string;
  purpose: RunPurpose;
  leadId?: string | null;
  /** The run's first message: the task, the run id and the Company summary, as the playbook expects it. */
  message: string;
  /** What the run was started with (shown on the run page). */
  input?: Record<string, unknown>;
  /** False leaves the run unbilled. */
  billable?: boolean;
  workflowVersion?: string | null;
  workflow?: { runId: string; workflowId: string; version: number } | null;
};

/** A new run id. The first message is built with it, so make it before the message. */
export const newRunId = () => newId("run");

/**
 * The insert that queues a run, for the caller's transaction (a start usually writes an audit event and a lead stage
 * with it). `input.run_id` repeats the id: older rows kept a separate run id there, and readers still look for it.
 */
export function queueRun(sql: Sql, env: Env, run: NewRun) {
  const limits = runLimits(env, run.purpose);
  return sql`
    insert into agent_runs (id, workspace_id, lead_id, purpose, role, status, message, input, billing_owner_id, workflow_version,
                            workflow_run_id, workflow_id, workflow_def_version, max_minutes, max_tool_calls, max_cost_micro_usd)
    values (${run.id}, ${run.ws}, ${run.leadId ?? null}, ${run.purpose}, ${roleFor(run.purpose)}, 'queued', ${run.message},
            ${JSON.stringify({ ...(run.input ?? {}), run_id: run.id })}::jsonb, ${run.billable === false ? null : run.ws}, ${run.workflowVersion ?? null},
            ${run.workflow?.runId ?? null}, ${run.workflow?.workflowId ?? null}, ${run.workflow?.version ?? null},
            ${limits.minutes}, ${limits.toolCalls}, ${limits.costMicroUsd})`;
}

export type ClaimedRun = {
  id: string;
  workspace_id: string;
  purpose: string;
  role: RunRole;
  lead_id: string | null;
  message: string;
  deadline_at: Date | string;
  max_tool_calls: number;
  max_cost_micro_usd: string | number | null;
};

/**
 * Hands the oldest queued run of the workspace to an agent, or null when nothing waits. `role` limits it to the work
 * that role may do (a researcher never gets an Operator cycle). Two agents asking at once get different runs.
 */
export async function claimRun(sql: Sql, ws: string, by: { role?: RunRole | null; actor: string }): Promise<ClaimedRun | null> {
  const rows = (await sql`
    update agent_runs set status = 'running', claimed_at = now(), claimed_by = ${by.actor},
           deadline_at = now() + make_interval(mins => max_minutes), updated_at = now()
    where id = (
      select id from agent_runs
      where workspace_id = ${ws} and status = 'queued' and (${by.role ?? null}::text is null or role = ${by.role ?? null})
        and not coalesce((select paused from workspaces w where w.id = agent_runs.workspace_id), false)
      order by created_at limit 1 for update skip locked
    )
    returning id, workspace_id, purpose, role, lead_id, message, deadline_at, max_tool_calls, max_cost_micro_usd`) as ClaimedRun[];
  const run = rows[0];
  if (!run) return null;
  await sql`insert into events (workspace_id, lead_id, kind, data)
            values (${run.workspace_id}, ${run.lead_id}, 'run_claimed', ${JSON.stringify({ session_id: run.id, purpose: run.purpose, actor: by.actor })}::jsonb)`;
  return run;
}

const STOP_TEXT: Record<RunStopReason, string> = {
  finished: "Finished",
  failed: "Stopped with an error",
  out_of_time: "Stopped: out of time",
  out_of_tool_calls: "Stopped: out of tool calls",
  out_of_budget: "Stopped: out of budget",
  unclaimed: "No agent picked this up in time",
};
export const stopText = (reason: string | null | undefined) => STOP_TEXT[reason as RunStopReason] ?? reason ?? "Finished";

/**
 * Closes a run that is still open: done when it finished, error otherwise. Idempotent (a closed run stays as it is).
 * A research run that dies gives its lead back ('researching' would otherwise wait forever), and a finished run pays
 * for what it spent.
 */
export async function closeRun(sql: Sql, id: string, reason: RunStopReason, detail?: string): Promise<boolean> {
  const status = reason === "finished" ? "done" : "error";
  const rows = (await sql`
    with r as (
      update agent_runs set status = ${status}::text, stop_reason = ${reason}::text, updated_at = now(), last_event_at = now(), events_seq = events_seq + 1
      where id = ${id} and status in ('queued', 'running')
      returning id, workspace_id, lead_id, purpose, events_seq
    ), e as (
      insert into agent_run_events (workspace_id, session_id, seq, type, data, created_at)
      select workspace_id, id, events_seq, 'run.finished', ${JSON.stringify({ stop_reason: reason, ...(detail ? { error: detail.slice(0, 500) } : {}) })}::jsonb, now() from r
    ), l as (
      update leads set stage = 'new', updated_at = now()
      where ${status}::text = 'error' and id = (select lead_id from r where purpose = 'research') and stage = 'researching'
    ), a as (
      insert into events (workspace_id, lead_id, kind, data)
      select workspace_id, lead_id, 'run_finished', jsonb_build_object('session_id', id, 'purpose', purpose, 'status', ${status}::text, 'stop_reason', ${reason}::text) from r
    )
    select id from r`) as { id: string }[];
  if (!rows.length) return false;
  await settleSessionUsage(sql, id).catch((err) => console.error(`usage debit ${id}:`, err instanceof Error ? err.message : err));
  return true;
}

export type RunCheck = { ok: true; id: string; purpose: string; role: RunRole } | { ok: false; reason: "not_found" | "not_claimed" | "closed" | RunStopReason; message: string };

/**
 * Counts one tool call against the run and says whether it may go ahead. Called for every MCP call that names a run.
 * A run past its time or its tool calls is closed here, so the limit holds whoever is running the agent.
 */
export async function countToolCall(sql: Sql, ws: string, runId: string): Promise<RunCheck> {
  const [ok] = (await sql`
    update agent_runs set tool_calls = tool_calls + 1, updated_at = now(), last_event_at = now()
    where workspace_id = ${ws} and id = ${runId} and status = 'running' and (deadline_at is null or deadline_at > now()) and tool_calls < max_tool_calls
    returning id, purpose, role`) as { id: string; purpose: string; role: RunRole }[];
  if (ok) return { ok: true, ...ok };
  const [row] = (await sql`
    select status, stop_reason, deadline_at <= now() as late, tool_calls >= max_tool_calls as spent
    from agent_runs where workspace_id = ${ws} and id = ${runId}`) as { status: string; stop_reason: string | null; late: boolean | null; spent: boolean | null }[];
  if (!row) return { ok: false, reason: "not_found", message: `No run with id ${runId}.` };
  if (row.status === "queued") return { ok: false, reason: "not_claimed", message: `Run ${runId} has not been claimed yet.` };
  if (row.status !== "running") return { ok: false, reason: "closed", message: `Run ${runId} is closed (${stopText(row.stop_reason).toLowerCase()}). Stop working on it.` };
  const reason: RunStopReason = row.late ? "out_of_time" : "out_of_tool_calls";
  await closeRun(sql, runId, reason);
  return { ok: false, reason, message: `Run ${runId} is ${reason === "out_of_time" ? "out of time" : "out of tool calls"} and is now closed. Stop working on it.` };
}

const MAX_EVENT_CHARS = 64_000;
const clipText = (s: string) => (s.length > MAX_EVENT_CHARS ? `${s.slice(0, MAX_EVENT_CHARS)}… [truncated]` : s);
function clipValue(v: unknown): unknown {
  if (typeof v === "string") return clipText(v);
  if (v && typeof v === "object") {
    const json = JSON.stringify(v);
    return json.length > MAX_EVENT_CHARS ? { truncated: `${json.slice(0, MAX_EVENT_CHARS)}…` } : v;
  }
  return v;
}

/**
 * Writes one finished tool call into the run's trace as a tool.started / tool.completed pair. The output is what the
 * agent got back: untrusted, stored as data and truncated. `leads` adds to leads_processed (an add_leads result).
 */
export async function recordToolCall(
  sql: Sql,
  ws: string,
  runId: string,
  call: { name: string; args: unknown; output: string; isError: boolean; startedAt: Date; leads?: number },
): Promise<void> {
  const callId = newId("call");
  const started = JSON.stringify({ name: call.name, tool_call_id: callId, args: clipValue(call.args) });
  const completed = JSON.stringify({ name: call.name, tool_call_id: callId, output: clipText(call.output), is_error: call.isError });
  await sql`
    with r as (
      update agent_runs set events_seq = events_seq + 2, leads_processed = leads_processed + ${call.leads ?? 0}, last_event_at = now()
      where workspace_id = ${ws} and id = ${runId}
      returning id, workspace_id, events_seq
    )
    insert into agent_run_events (workspace_id, session_id, seq, type, data, created_at)
    select workspace_id, id, events_seq - 1, 'tool.started', ${started}::jsonb, ${call.startedAt.toISOString()}::timestamptz from r
    union all
    select workspace_id, id, events_seq, 'tool.completed', ${completed}::jsonb, now() from r`;
}

/**
 * Cron: close runs past their deadline and queued runs nobody claimed in time, so a stuck run never blocks a lead, a
 * workflow or the Operator's next cycle.
 */
export async function expireRuns(sql: Sql, env: Env): Promise<number> {
  const stale = (await sql`
    select id, case when status = 'queued' then 'unclaimed' else 'out_of_time' end as reason from agent_runs
    where (status = 'running' and deadline_at <= now())
       or (status = 'queued' and created_at <= now() - make_interval(mins => ${queueTtlMinutes(env)}))
    order by created_at limit 50`) as { id: string; reason: RunStopReason }[];
  let closed = 0;
  for (const run of stale) {
    try {
      if (await closeRun(sql, run.id, run.reason)) closed++;
    } catch (err) {
      console.error(`expire run ${run.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return closed;
}
