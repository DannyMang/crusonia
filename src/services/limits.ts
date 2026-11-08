// Per-workspace guardrails, on top of Naive's own agent budget and the credit check:
//   - a daily Naive spend cap for every workspace: spend of the sessions started in the last 24 hours, against
//     workspaces.daily_cap_micro_usd or WORKSPACE_DAILY_CAP_USD (default $5);
//   - rate limits on paid starts for every workspace but the owner's: PAID_STARTS_PER_HOUR (default 20) and
//     MAX_ACTIVE_SESSIONS (default 5) sessions running at once;
//   - for every workspace but the owner's, the Apify-backed web tools (search_web, read_website) need credits and
//     are limited to WEB_CALLS_PER_HOUR (default 60), since they spend the instance's Apify account;
//   - invite emails go out from the instance's own inbox, so they are limited over the last 24 hours per workspace,
//     per sender, per address and per instance (src/services/invites.ts), and a person can make only so many workspaces.
import { logEvent, type Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { ApiError } from "../lib/errors.ts";
import { isOwnerWorkspace } from "./workspaces.ts";

const positive = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return raw?.trim() && Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const limitsConfig = (env: Env) => ({
  dailyCapMicroUsd: Math.round(positive(env.WORKSPACE_DAILY_CAP_USD, 5) * 1_000_000),
  startsPerHour: Math.trunc(positive(env.PAID_STARTS_PER_HOUR, 20)),
  maxActiveSessions: Math.trunc(positive(env.MAX_ACTIVE_SESSIONS, 5)),
  webCallsPerHour: Math.trunc(positive(env.WEB_CALLS_PER_HOUR, 60)),
  invitesPerWorkspacePerDay: Math.trunc(positive(env.INVITES_PER_WORKSPACE_PER_DAY, 20)),
  invitesPerUserPerDay: Math.trunc(positive(env.INVITES_PER_USER_PER_DAY, 30)),
  invitesPerEmailPerDay: Math.trunc(positive(env.INVITES_PER_EMAIL_PER_DAY, 3)),
  invitesPerInstancePerDay: Math.trunc(positive(env.INVITES_PER_INSTANCE_PER_DAY, 200)),
  maxWorkspacesPerUser: Math.trunc(positive(env.MAX_WORKSPACES_PER_USER, 5)),
});

export type SpendStatus = { spent_micro_usd: number; cap_micro_usd: number; started_last_hour: number; active_sessions: number };

/** The workspace's Naive spend over the last 24 hours and its cap, plus the counts the rate limits use. */
export async function spendStatus(sql: Sql, env: Env, ws: string): Promise<SpendStatus> {
  const [row] = await sql`
    select
      (select coalesce(sum(coalesce(consumed_micro_usd, 0)), 0)::text from naive_sessions
         where workspace_id = ${ws} and created_at > now() - interval '1 day') as spent,
      (select count(*)::int from naive_sessions where workspace_id = ${ws} and created_at > now() - interval '1 hour') as started,
      -- A session out of budget stays 'idle' forever, but it isn't running: it must not use up the limit.
      (select count(*)::int from naive_sessions where workspace_id = ${ws} and status in ('running', 'idle') and coalesce(stop_reason, '') <> 'budget_paused') as active,
      (select daily_cap_micro_usd::text from workspaces where id = ${ws}) as cap`;
  return {
    spent_micro_usd: Number(row?.spent ?? 0),
    cap_micro_usd: row?.cap !== null && row?.cap !== undefined ? Number(row.cap) : limitsConfig(env).dailyCapMicroUsd,
    started_last_hour: Number(row?.started ?? 0),
    active_sessions: Number(row?.active ?? 0),
  };
}

/**
 * How many of `wanted` new Naive sessions the workspace may start now (0..wanted) and, when fewer, why.
 * The daily cap applies to every workspace; the rate limits to every workspace but the owner's.
 */
export async function paidStartAllowance(
  sql: Sql,
  env: Env,
  ws: string,
  wanted: number,
): Promise<{ allowed: number; reason?: "daily_cap_reached" | "rate_limited"; status: SpendStatus }> {
  const status = await spendStatus(sql, env, ws);
  if (status.spent_micro_usd >= status.cap_micro_usd) return { allowed: 0, reason: "daily_cap_reached", status };
  if (isOwnerWorkspace(ws)) return { allowed: wanted, status };
  const cfg = limitsConfig(env);
  const room = Math.max(0, Math.min(cfg.startsPerHour - status.started_last_hour, cfg.maxActiveSessions - status.active_sessions));
  return room >= wanted ? { allowed: wanted, status } : { allowed: room, reason: "rate_limited", status };
}

/** 429 unless the workspace may start `wanted` sessions now. */
export async function requirePaidStart(sql: Sql, env: Env, ws: string, wanted = 1): Promise<void> {
  const a = await paidStartAllowance(sql, env, ws, wanted);
  if (a.allowed >= wanted) return;
  const usd = (micro: number) => Math.round(micro / 10_000) / 100;
  if (a.reason === "daily_cap_reached") {
    throw new ApiError(429, "daily_cap_reached", `This workspace reached its daily agent spend cap ($${usd(a.status.cap_micro_usd)} per 24 hours). Try again later.`, {
      spent_usd: usd(a.status.spent_micro_usd),
      cap_usd: usd(a.status.cap_micro_usd),
    });
  }
  throw new ApiError(429, "rate_limited", "Too many agent runs started in this workspace; wait for some to finish and try again.", {
    started_last_hour: a.status.started_last_hour,
    active_sessions: a.status.active_sessions,
  });
}

/**
 * Before an Apify-backed web call: free for the owner workspace; for any other workspace it needs a positive
 * credit balance and stays under WEB_CALLS_PER_HOUR (each call is recorded as a 'web_call' event).
 */
export async function requireWebCall(sql: Sql, env: Env, ws: string, tool: string): Promise<void> {
  if (isOwnerWorkspace(ws)) return;
  const [row] = await sql`
    select (select coalesce(sum(amount), 0)::text from credit_ledger where workspace_id = ${ws}) as balance,
           (select count(*)::int from events where workspace_id = ${ws} and kind = 'web_call' and created_at > now() - interval '1 hour') as calls`;
  if (Number(row?.balance ?? 0) <= 0) {
    throw new ApiError(402, "insufficient_credits", "Web reads need credits in this workspace. Buy a credit pack in Settings > Billing.");
  }
  if (Number(row?.calls ?? 0) >= limitsConfig(env).webCallsPerHour) {
    throw new ApiError(429, "rate_limited", "Too many web reads from this workspace in the last hour; try again later.");
  }
  await logEvent(sql, ws, null, "web_call", { tool });
}
