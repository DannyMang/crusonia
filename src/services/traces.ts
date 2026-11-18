// Agent traces: the record of every agent run, kept in our database. agent_run_events holds what Crusonia saw of the
// run (its tool calls with their inputs and outputs, and how it ended; huge fields truncated), and our own `events`
// rows for the run hold what Crusonia did (starts, credit debits). The clean timeline (buildSteps) is the default
// view; this is "View full trace" and its JSON export. Traces are kept for TRACE_RETENTION_DAYS (default 180).
import { creditsForUsage } from "../billing/plans.ts";
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import type { Principal } from "../lib/context.ts";
import { ApiError } from "../lib/errors.ts";
import { microToUsd, toRun, type SessionRow } from "./runs.ts";

export const DEFAULT_TRACE_RETENTION_DAYS = 180;

/** TRACE_RETENTION_DAYS as a whole number of days (at least 1), else 180. */
export function traceRetentionDays(env: Pick<Env, "TRACE_RETENTION_DAYS">): number {
  const n = Number(env.TRACE_RETENTION_DAYS?.trim());
  return env.TRACE_RETENTION_DAYS?.trim() && Number.isInteger(n) && n >= 1 ? n : DEFAULT_TRACE_RETENTION_DAYS;
}

/**
 * Who reads a trace: a member of `workspace` (their own workspace's runs), or a platform admin (`admin`, see
 * src/api/admin.ts): any workspace, each read audited by the caller.
 */
export type TraceViewer = { principal: Principal; workspace: string; admin?: boolean };

/** The one place trace reads are scoped: the session row if `viewer` may read it, else 404. */
export async function traceSession(sql: Sql, viewer: TraceViewer, sessionId: string): Promise<SessionRow> {
  const admin = viewer.admin === true;
  const [row] = (await sql`
    select id, workspace_id, workflow_version, lead_id, purpose, status, stop_reason, input, consumed_micro_usd, leads_processed,
           events_seq, last_event_at, created_at, updated_at
    from agent_runs where id = ${sessionId} and (${admin}::boolean or workspace_id = ${viewer.workspace})`) as SessionRow[];
  if (!row) throw new ApiError(404, "not_found", `No workflow run with session id ${sessionId}`);
  return row;
}

const TRACE_PAGE_MAX = 1000;

async function sessionContext(sql: Sql, ws: string, sessionId: string, leadId: string | null, since: Date | string) {
  const [audit, approvals, ledger, apify] = await sql.transaction(
    [
      sql`select id::text, lead_id, kind, data, created_at from events where workspace_id = ${ws} and data->>'session_id' = ${sessionId} order by id limit 5000`,
      sql`select code, kind, status, summary, payload, answer, decided_via, decided_at, expires_at, created_at
          from approvals where workspace_id = ${ws}
             and ${leadId}::text is not null and lead_id = ${leadId} and kind = 'send' and created_at >= ${since}::timestamptz
          order by created_at`,
      sql`select amount::text, source, data, created_at from credit_ledger where workspace_id = ${ws} and session_id = ${sessionId} order by id`,
      sql`select run_id, actor, status, usage_micro_usd, max_charge_usd, debited_credits, created_at, finished_at
          from apify_runs where workspace_id = ${ws} and session_id = ${sessionId} order by created_at`,
    ],
    { readOnly: true },
  );
  const credits = (ledger as { amount: string }[]).reduce((sum, r) => sum - Number(r.amount), 0);
  return {
    audit,
    approvals,
    spend: {
      // The run's model spend, the credits it was debited, and the Apify runs it started (attributed when it was
      // the only open run).
      agent_usd: null as number | null,
      credits_debited: credits,
      // The session's whole cost: its agent time (filled in by the caller) plus these Apify runs.
      credits: (apify as { usage_micro_usd: string | null }[]).reduce((sum, r) => sum + creditsForUsage(Number(r.usage_micro_usd ?? 0)), 0),
      ledger,
      apify_runs: (apify as { usage_micro_usd: string | null }[]).map((r) => ({ ...r, usage_usd: microToUsd(r.usage_micro_usd) })),
    },
  };
}

/**
 * GET /api/workflows/runs/:id/trace: the stored events after `after_seq`, oldest first, `limit` per page (max 1000),
 * plus (on every page) the run, our audit events, approvals and spend for the session.
 */
export async function getTrace(
  sql: Sql,
  env: Env,
  viewer: TraceViewer,
  sessionId: string,
  page: { afterSeq?: number; limit?: number } = {},
) {
  const row = await traceSession(sql, viewer, sessionId);
  const limit = Math.min(Math.max(page.limit ?? 200, 1), TRACE_PAGE_MAX);
  const after = Math.max(page.afterSeq ?? 0, 0);
  const [events, ctx] = await Promise.all([
    sql`select seq, type, data, created_at from agent_run_events
        where workspace_id = ${row.workspace_id} and session_id = ${sessionId} and seq > ${after} order by seq limit ${limit + 1}`,
    sessionContext(sql, row.workspace_id, sessionId, row.lead_id, row.created_at),
  ]);
  const hasMore = events.length > limit;
  const pageEvents = events.slice(0, limit) as { seq: number }[];
  ctx.spend.agent_usd = microToUsd(row.consumed_micro_usd);
  ctx.spend.credits += creditsForUsage(Number(row.consumed_micro_usd ?? 0));
  return {
    workspace_id: row.workspace_id,
    run: toRun(row, false),
    events: pageEvents,
    has_more: hasMore,
    next_after_seq: hasMore ? pageEvents[pageEvents.length - 1]!.seq : null,
    ...ctx,
    retention_days: traceRetentionDays(env),
  };
}

const EXPORT_MAX_EVENTS = 20_000;

/** GET /api/workflows/runs/:id/trace/export: the whole trace as one JSON document. */
export async function exportTrace(sql: Sql, viewer: TraceViewer, sessionId: string) {
  const row = await traceSession(sql, viewer, sessionId);
  const [events, ctx] = await Promise.all([
    sql`select seq, type, data, created_at from agent_run_events
        where workspace_id = ${row.workspace_id} and session_id = ${sessionId} order by seq limit ${EXPORT_MAX_EVENTS}`,
    sessionContext(sql, row.workspace_id, sessionId, row.lead_id, row.created_at),
  ]);
  ctx.spend.agent_usd = microToUsd(row.consumed_micro_usd);
  ctx.spend.credits += creditsForUsage(Number(row.consumed_micro_usd ?? 0));
  return {
    format: "crusonia.trace.v1",
    exported_at: new Date().toISOString(),
    run: toRun(row, false),
    events,
    truncated: events.length >= EXPORT_MAX_EVENTS,
    ...ctx,
  };
}

/** Cron: drop the stored events of sessions older than TRACE_RETENTION_DAYS (the run row and audit trail stay). */
export async function pruneTraces(sql: Sql, env: Env): Promise<number> {
  const rows = await sql`
    delete from agent_run_events e
    where e.ctid in (
      select e2.ctid from agent_run_events e2 join agent_runs s on s.id = e2.session_id
      where s.created_at < now() - make_interval(days => ${traceRetentionDays(env)}::int)
      limit 5000
    )
    returning 1`;
  return rows.length;
}
