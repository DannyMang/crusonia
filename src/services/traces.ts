// Agent traces: the full record of every Naive session, kept in our database. naive_session_events holds every Naive
// event (tool calls with their inputs and outputs, messages, confirmations, model requests with token usage and cost;
// huge fields truncated, see storableEvent in ./runs.ts), and our own `events` rows for the session hold what
// Crusonia did (auto-allowed confirmations, approvals, credit debits). The clean timeline (buildSteps) is the default
// view; this is "View full trace" and its JSON export. A finished session's trace is read to the end when it
// finishes and by the minute cron, and kept for TRACE_RETENTION_DAYS (default 180).
import { creditsForUsage } from "../billing/plans.ts";
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import type { Principal } from "../lib/context.ts";
import { ApiError } from "../lib/errors.ts";
import type { FetchFn } from "../providers/http.ts";
import { NaiveClient } from "../providers/naive.ts";
import { MAX_PAGES_FULL_SYNC, microToUsd, syncSessionEvents, toRun, type SessionRow } from "./runs.ts";

export const DEFAULT_TRACE_RETENTION_DAYS = 180;

/** TRACE_RETENTION_DAYS as a whole number of days (at least 1), else 180. */
export function traceRetentionDays(env: Pick<Env, "TRACE_RETENTION_DAYS">): number {
  const n = Number(env.TRACE_RETENTION_DAYS?.trim());
  return env.TRACE_RETENTION_DAYS?.trim() && Number.isInteger(n) && n >= 1 ? n : DEFAULT_TRACE_RETENTION_DAYS;
}

/**
 * Who reads a trace: a member of `workspace` (their own workspace's runs), or a platform admin (`admin`, see
 * src/api/admin.ts): any workspace, read-only (no refresh from Naive), each read audited by the caller.
 */
export type TraceViewer = { principal: Principal; workspace: string; admin?: boolean };

/** The one place trace reads are scoped: the session row if `viewer` may read it, else 404. */
export async function traceSession(sql: Sql, viewer: TraceViewer, sessionId: string): Promise<SessionRow> {
  const admin = viewer.admin === true;
  const [row] = (await sql`
    select id, workspace_id, workflow_version, lead_id, purpose, status, stop_reason, input, consumed_micro_usd, leads_processed,
           events_seq, events_synced_at, last_event_at, created_at, updated_at
    from naive_sessions where id = ${sessionId} and (${admin}::boolean or workspace_id = ${viewer.workspace})`) as SessionRow[];
  if (!row) throw new ApiError(404, "not_found", `No workflow run with session id ${sessionId}`);
  return row;
}

/** Reads the rest of the trace from Naive (free) when ours may be behind. Never fails the read: says why instead. */
async function refresh(
  sql: Sql,
  env: Env,
  row: SessionRow,
  fetchFn?: FetchFn,
  viewer?: TraceViewer,
): Promise<{ ok: boolean; complete?: boolean; error?: string; skipped?: string }> {
  if (viewer?.admin) return { ok: true, skipped: "read-only view: stored events only" };
  if (!env.NAIVE_API_KEY) return { ok: true, skipped: "NAIVE_API_KEY is not set; showing stored events only" };
  const finished = row.status === "done" || row.status === "error";
  if (finished && row.events_synced_at && new Date(row.events_synced_at).getTime() >= new Date(row.updated_at).getTime()) {
    return { ok: true, complete: true, skipped: "trace is complete" };
  }
  try {
    const res = await syncSessionEvents(sql, new NaiveClient(env.NAIVE_API_KEY, fetchFn), row, { maxPages: MAX_PAGES_FULL_SYNC });
    return { ok: true, complete: finished && res.complete };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const TRACE_PAGE_MAX = 1000;

async function sessionContext(sql: Sql, ws: string, sessionId: string, leadId: string | null, since: Date | string) {
  const [audit, approvals, ledger, apify] = await sql.transaction(
    [
      sql`select id::text, lead_id, kind, data, created_at from events where workspace_id = ${ws} and data->>'session_id' = ${sessionId} order by id limit 5000`,
      sql`select code, kind, status, summary, tool_call_id, payload, answer, decided_via, decided_at, expires_at, created_at
          from approvals where workspace_id = ${ws}
             and (naive_session_id = ${sessionId}
                  or (${leadId}::text is not null and lead_id = ${leadId} and kind = 'send' and created_at >= ${since}::timestamptz))
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
      // Naive's own total for the session, the credits it was debited, and the Apify runs it started (attributed
      // when it was the only active session).
      naive_usd: null as number | null,
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
  fetchFn?: FetchFn,
) {
  let row = await traceSession(sql, viewer, sessionId);
  const sync = await refresh(sql, env, row, fetchFn, viewer);
  row = await traceSession(sql, viewer, sessionId);
  const limit = Math.min(Math.max(page.limit ?? 200, 1), TRACE_PAGE_MAX);
  const after = Math.max(page.afterSeq ?? 0, 0);
  const [events, ctx] = await Promise.all([
    sql`select seq, type, data, created_at from naive_session_events
        where workspace_id = ${row.workspace_id} and session_id = ${sessionId} and seq > ${after} order by seq limit ${limit + 1}`,
    sessionContext(sql, row.workspace_id, sessionId, row.lead_id, row.created_at),
  ]);
  const hasMore = events.length > limit;
  const pageEvents = events.slice(0, limit) as { seq: number }[];
  ctx.spend.naive_usd = microToUsd(row.consumed_micro_usd);
  ctx.spend.credits += creditsForUsage(Number(row.consumed_micro_usd ?? 0));
  return {
    workspace_id: row.workspace_id,
    run: toRun(row, false),
    events: pageEvents,
    has_more: hasMore,
    next_after_seq: hasMore ? pageEvents[pageEvents.length - 1]!.seq : null,
    ...ctx,
    retention_days: traceRetentionDays(env),
    sync,
  };
}

const EXPORT_MAX_EVENTS = 20_000;

/** GET /api/workflows/runs/:id/trace/export: the whole trace as one JSON document. */
export async function exportTrace(sql: Sql, env: Env, viewer: TraceViewer, sessionId: string, fetchFn?: FetchFn) {
  let row = await traceSession(sql, viewer, sessionId);
  const sync = await refresh(sql, env, row, fetchFn, viewer);
  row = await traceSession(sql, viewer, sessionId);
  const [events, ctx] = await Promise.all([
    sql`select seq, type, data, created_at from naive_session_events
        where workspace_id = ${row.workspace_id} and session_id = ${sessionId} order by seq limit ${EXPORT_MAX_EVENTS}`,
    sessionContext(sql, row.workspace_id, sessionId, row.lead_id, row.created_at),
  ]);
  ctx.spend.naive_usd = microToUsd(row.consumed_micro_usd);
  ctx.spend.credits += creditsForUsage(Number(row.consumed_micro_usd ?? 0));
  return {
    format: "crusonia.trace.v1",
    exported_at: new Date().toISOString(),
    run: toRun(row, false),
    events,
    truncated: events.length >= EXPORT_MAX_EVENTS,
    ...ctx,
    sync,
  };
}

/**
 * Cron: read finished sessions' traces to the end (a free Naive read), so the trace is complete even when nobody
 * opened the run. A few sessions per minute.
 */
export async function syncFinishedTraces(sql: Sql, env: Env, fetchFn?: FetchFn): Promise<number> {
  if (!env.NAIVE_API_KEY) return 0;
  const rows = (await sql`
    select id, workspace_id, events_seq from naive_sessions
    where status in ('done', 'error') and (events_synced_at is null or events_synced_at < updated_at)
      and created_at > now() - make_interval(days => ${traceRetentionDays(env)}::int)
    order by updated_at limit 3`) as Pick<SessionRow, "id" | "workspace_id" | "events_seq">[];
  const client = new NaiveClient(env.NAIVE_API_KEY, fetchFn);
  let synced = 0;
  for (const row of rows) {
    try {
      await syncSessionEvents(sql, client, row, { maxPages: MAX_PAGES_FULL_SYNC });
      synced++;
    } catch (err) {
      console.error(`trace sync ${row.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return synced;
}

/** Cron: drop the stored events of sessions older than TRACE_RETENTION_DAYS (the run row and audit trail stay). */
export async function pruneTraces(sql: Sql, env: Env): Promise<number> {
  const rows = await sql`
    delete from naive_session_events e
    where e.ctid in (
      select e2.ctid from naive_session_events e2 join naive_sessions s on s.id = e2.session_id
      where s.created_at < now() - make_interval(days => ${traceRetentionDays(env)}::int)
      limit 5000
    )
    returning 1`;
  return rows.length;
}
