// The minute cron: expire stale approvals, close agent runs past their limits, settle sends
// AgentMail did not confirm, send approved follow-ups that are due, drain the CRM sync queue, debit finished sessions and Apify runs that still owe credits, expire
// unused plan credits after their rollover month, and prune old agent traces.
// Each step is independent; one failing does not skip the others.
import { expireCredits } from "../billing/expiry.ts";
import { settleApifyUsage, settleUsage } from "../billing/usage.ts";
import { getSql } from "../db.ts";
import type { Env } from "../env.ts";
import type { FetchFn } from "../providers/http.ts";
import { expireRuns } from "./agent-runs.ts";
import { expireStaleApprovals } from "./approvals.ts";
import { runAutopilot } from "./autopilot.ts";
import { runCrmSync } from "./crm-sync.ts";
import { sendDueFollowUps } from "./followups.ts";
import { reconcileSending } from "./send.ts";
import { pruneTraces } from "./traces.ts";

export async function runScheduled(env: Env, fetchFn?: FetchFn): Promise<Record<string, unknown>> {
  if (!env.DATABASE_URL) return { skipped: "DATABASE_URL is not set" };
  const sql = getSql(env.DATABASE_URL);
  const report: Record<string, unknown> = {};
  const steps: [string, () => Promise<unknown>][] = [
    ["expired_approvals", () => expireStaleApprovals(sql)],
    // Runs past their deadline, and queued runs no agent claimed in time.
    ["expired_runs", () => expireRuns(sql, env)],
    ["reconciled_sends", () => reconcileSending(sql, env, fetchFn)],
    // Approved follow-ups whose send time came (cancelled instead if the lead replied meanwhile).
    ["followups", () => sendDueFollowUps(sql, env, fetchFn)],
    ["crm_sync", () => runCrmSync(sql, env, fetchFn)],
    // Debit finished agent runs that still owe credits (missed or failed debits, spend reported later).
    ["settled_usage", () => settleUsage(sql)],
    // Apify Actor runs: pick up final usage, debit what is still owed.
    ["settled_apify", () => settleApifyUsage(sql, env, fetchFn)],
    // Write off included plan credits whose rollover month ended unused.
    ["expired_credits", () => expireCredits(sql)],
    // Agent traces past TRACE_RETENTION_DAYS.
    ["pruned_trace_events", () => pruneTraces(sql, env)],
    // Work that starts by itself: schedules, new imports and replies, the Operator (off unless AUTOPILOT_WORKSPACES is set).
    ["autopilot", () => runAutopilot(sql, env)],
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
