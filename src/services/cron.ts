// The minute cron: expire stale approvals, reconcile Naive sessions that missed a webhook, settle sends
// AgentMail did not confirm, drain the CRM sync queue, debit finished sessions and Apify runs that still owe credits, and expire
// unused plan credits after their rollover month, complete finished agent traces and prune old ones. Each step is
// independent; one failing does not skip the others.
import { expireCredits } from "../billing/expiry.ts";
import { settleApifyUsage, settleUsage } from "../billing/usage.ts";
import { getSql } from "../db.ts";
import type { Env } from "../env.ts";
import type { FetchFn } from "../providers/http.ts";
import { expireStaleApprovals } from "./approvals.ts";
import { runCrmSync } from "./crm-sync.ts";
import { reconcileSending } from "./send.ts";
import { pruneTraces, syncFinishedTraces } from "./traces.ts";
import { reconcileSessions } from "./workflows.ts";

export async function runScheduled(env: Env, fetchFn?: FetchFn): Promise<Record<string, unknown>> {
  if (!env.DATABASE_URL) return { skipped: "DATABASE_URL is not set" };
  const sql = getSql(env.DATABASE_URL);
  const report: Record<string, unknown> = {};
  const steps: [string, () => Promise<unknown>][] = [
    ["expired_approvals", () => expireStaleApprovals(sql, env, fetchFn)],
    ["reconciled_sessions", () => reconcileSessions(sql, env, fetchFn)],
    ["reconciled_sends", () => reconcileSending(sql, env, fetchFn)],
    ["crm_sync", () => runCrmSync(sql, env, fetchFn)],
    // Debit finished Naive sessions that still owe credits (missed or failed debits, spend reported later).
    ["settled_usage", () => settleUsage(sql, env, fetchFn)],
    // Apify Actor runs: pick up final usage, debit what is still owed.
    ["settled_apify", () => settleApifyUsage(sql, env, fetchFn)],
    // Write off included plan credits whose rollover month ended unused.
    ["expired_credits", () => expireCredits(sql)],
    // Agent traces: read finished sessions to the end, and drop traces past TRACE_RETENTION_DAYS.
    ["synced_traces", () => syncFinishedTraces(sql, env, fetchFn)],
    ["pruned_trace_events", () => pruneTraces(sql, env)],
  ];
  for (const [name, step] of steps) {
    try {
      report[name] = await step();
    } catch (err) {
      report[name] = { error: err instanceof Error ? err.message : String(err) };
      console.error(`cron ${name}:`, err);
    }
  }
  return report;
}
