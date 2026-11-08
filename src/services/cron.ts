// The minute cron: expire stale approvals, reconcile Naive sessions that missed a webhook, settle sends
// AgentMail did not confirm, and drain the CRM sync queue. Each step is independent; one failing does not
// skip the others.
import { getSql } from "../db.ts";
import type { Env } from "../env.ts";
import type { FetchFn } from "../providers/http.ts";
import { expireStaleApprovals } from "./approvals.ts";
import { runCrmSync } from "./crm-sync.ts";
import { reconcileSending } from "./send.ts";
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
