// GET /api/summary: the dashboard Home in one call.
// Every count is the caller's workspace's.
import { creditsToUsd } from "../billing/plans.ts";
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { listApprovals } from "./approvals.ts";
import { spendStatus } from "./limits.ts";
import { listReplies } from "./replies.ts";
import { listWorkflows, microToUsd } from "./runs.ts";

export type Pipeline = {
  found: number;
  researched: number;
  /** Cumulative pipeline only: scored as qualified, or any later step. */
  qualified?: number;
  drafted: number;
  awaiting_approval: number;
  sent: number;
  replied: number;
  meetings: number;
};

/** How many leads ever reached each step (a lead that reached a later step counts in every earlier one). */
export type FunnelCounts = { found: number; researched: number; qualified?: number; drafted: number; sent: number; replied: number; meetings: number };

/**
 * The funnel, cumulative: found >= researched >= qualified >= drafted >= sent >= replied >= meetings, so each number reads as
 * "how many got this far". `awaiting_approval` is not a funnel step: it is how many leads have an email waiting for
 * the owner right now.
 *   found: every lead                       researched: scored, or any later step
 *   qualified: scored as qualified, or any later step
 *   drafted: has a draft (any channel), or any later step
 *   sent: an outbound message (email, or a manual task marked sent), or any later step
 *   replied: an inbound reply or a reply stage, or a meeting        meetings: meeting_booked
 */
export function cumulativePipeline(c: FunnelCounts, awaitingWithOpenApproval: number): Pipeline {
  const meetings = Math.max(0, c.meetings);
  const replied = Math.max(c.replied, meetings);
  const sent = Math.max(c.sent, replied);
  const drafted = Math.max(c.drafted, sent);
  const qualified = Math.max(c.qualified ?? 0, drafted);
  const researched = Math.max(c.researched, qualified);
  const found = Math.max(c.found, researched);
  return { found, researched, qualified, drafted, awaiting_approval: Math.max(0, awaitingWithOpenApproval), sent, replied, meetings };
}

/**
 * Where leads are now (the previous `pipeline`, kept as `pipeline_now`): every lead counts in at most one bucket
 * (unsubscribed leads in none).
 *   found: new, no_consent, researching          researched: qualified, disqualified, needs_review
 *   drafted: awaiting_approval with no open send approval (rejected, expired or failed draft)
 *   awaiting_approval: awaiting_approval with an open send approval
 *   sent: sent    replied: replied, interested, not_interested    meetings: meeting_booked
 */
export function pipelineFromStages(byStage: Record<string, number>, awaitingWithOpenApproval: number): Pipeline {
  const n = (...stages: string[]) => stages.reduce((sum, s) => sum + (byStage[s] ?? 0), 0);
  const awaiting = Math.min(awaitingWithOpenApproval, n("awaiting_approval"));
  return {
    found: n("new", "no_consent", "researching"),
    researched: n("qualified", "disqualified", "needs_review"),
    drafted: n("awaiting_approval") - awaiting,
    awaiting_approval: awaiting,
    sent: n("sent"),
    replied: n("replied", "interested", "not_interested"),
    meetings: n("meeting_booked"),
  };
}

/** A row of listApprovals (approvals.ts), as far as the summary reads it. */
type ApprovalListItem = {
  code: string;
  kind: string;
  lead_id: string | null;
  lead: { name: string | null; company: string | null } | null;
  draft: { subject: string } | null;
  [key: string]: unknown;
};

export function weeklyBudgetUsd(env: Env): number | null {
  const n = Number(env.WEEKLY_BUDGET_USD);
  return env.WEEKLY_BUDGET_USD && Number.isFinite(n) && n >= 0 ? n : null;
}

/** The Home dashboard of workspace `ws`. */
export async function getSummary(sql: Sql, env: Env, ws: string) {
  const [[counts], [funnel], approvals, replies, today] = await Promise.all([
    sql`select
          (select coalesce(jsonb_object_agg(stage, n), '{}'::jsonb)
             from (select stage, count(*)::int as n from leads where workspace_id = ${ws} group by stage) s) as by_stage,
          (select count(*)::int from leads l
             where l.workspace_id = ${ws} and l.stage = 'awaiting_approval'
               and exists (select 1 from approvals a where a.workspace_id = ${ws} and a.lead_id = l.id and a.kind = 'send'
                           and a.status = 'pending' and a.expires_at > now())) as awaiting_open,
          (select count(*)::int from approvals where workspace_id = ${ws} and status = 'pending' and expires_at > now()) as pending_total,
          (select count(*)::int from drafts d join leads l on l.id = d.lead_id
             where d.workspace_id = ${ws} and d.channel <> 'email' and d.status = 'open' and l.stage <> 'unsubscribed') as tasks_open,
          (select count(*)::int from approvals where workspace_id = ${ws} and status = 'pending' and expires_at > now() and kind = 'send') as pending_sends,
          -- Credits charged in the last 7 days (agent sessions and Apify runs, at the usage markup).
          (select coalesce(-sum(amount), 0)::text from credit_ledger
             where workspace_id = ${ws} and reason = 'usage' and created_at >= now() - interval '7 days') as week_credits,
          -- Raw provider cost behind it: Naive's running totals and Apify run usage.
          (select sum(consumed_micro_usd)::text from naive_sessions
             where workspace_id = ${ws} and coalesce(last_event_at, updated_at) >= now() - interval '7 days') as week_naive_micro,
          (select sum(usage_micro_usd)::text from apify_runs where workspace_id = ${ws} and created_at >= now() - interval '7 days') as week_apify_micro,
          coalesce((select paused from workspaces where id = ${ws}), false) as paused`,
    sql`with base as (
          select l.stage, l.score, l.qualified,
                 exists (select 1 from messages m where m.lead_id = l.id and m.direction = 'in') as has_in,
                 exists (select 1 from messages m where m.lead_id = l.id and m.direction = 'out') as has_out,
                 exists (select 1 from drafts d where d.lead_id = l.id) as has_draft
          from leads l
          where l.workspace_id = ${ws}
        ),
        flags as (
          select stage, score, qualified, has_draft,
                 stage = 'meeting_booked' as meeting,
                 (stage in ('replied', 'interested', 'not_interested', 'meeting_booked') or has_in) as replied,
                 (stage in ('sent', 'replied', 'interested', 'not_interested', 'meeting_booked') or has_in or has_out) as sent
          from base
        )
        select count(*)::int as found,
               (count(*) filter (where score is not null or stage in ('qualified', 'disqualified', 'needs_review', 'awaiting_approval')
                                   or has_draft or sent))::int as researched,
               (count(*) filter (where qualified is true or has_draft or stage = 'awaiting_approval' or sent))::int as qualified,
               (count(*) filter (where has_draft or stage = 'awaiting_approval' or sent))::int as drafted,
               (count(*) filter (where sent))::int as sent,
               (count(*) filter (where replied))::int as replied,
               (count(*) filter (where meeting))::int as meetings
        from flags`,
    listApprovals(sql, ws, { status: "pending", limit: 5 }),
    listReplies(sql, ws, { limit: 5 }),
    spendStatus(sql, env, ws),
  ]);
  const paused = counts?.paused === true;
  const workflows = await listWorkflows(sql, ws, { recentRuns: 3, paused });
  const byStage = (counts?.by_stage ?? {}) as Record<string, number>;
  const weekCredits = Number(counts?.week_credits ?? 0);
  const naiveUsd = microToUsd(counts?.week_naive_micro);
  const apifyUsd = microToUsd(counts?.week_apify_micro);
  const providerUsd = naiveUsd === null && apifyUsd === null ? null : Math.round(((naiveUsd ?? 0) + (apifyUsd ?? 0)) * 1_000_000) / 1_000_000;
  return {
    // Cumulative: how many leads got at least this far.
    pipeline: cumulativePipeline((funnel ?? {}) as FunnelCounts, counts?.awaiting_open ?? 0),
    // Where leads are now (each lead in at most one bucket).
    pipeline_now: pipelineFromStages(byStage, counts?.awaiting_open ?? 0),
    pipeline_by_stage: byStage,
    tasks_open: counts?.tasks_open ?? 0,
    total_leads: Object.values(byStage).reduce((a, b) => a + b, 0),
    pending_approvals: (approvals as ApprovalListItem[]).map((a) => ({
      ...a,
      lead_name: a.lead?.name ?? null,
      company: a.lead?.company ?? null,
      subject: a.draft?.subject ?? null,
    })),
    pending_approvals_total: counts?.pending_total ?? 0,
    // Drafts (send approvals) only; the rest are tool calls and agent questions.
    pending_sends_total: counts?.pending_sends ?? 0,
    active_workflows: workflows.filter((w) => w.active_runs > 0),
    recent_replies: replies.data,
    // week_usd is what the last 7 days cost in credits (usage at the markup), not raw provider cost: null until
    // anything was charged or reported. provider_usd is the raw Naive + Apify cost behind it.
    spend: {
      week_usd: weekCredits > 0 ? creditsToUsd(weekCredits) : providerUsd === null ? null : 0,
      week_credits: weekCredits,
      provider_usd: providerUsd,
      budget_usd: weeklyBudgetUsd(env),
      // The per-workspace daily cap (src/services/limits.ts): Naive spend of sessions started in the last 24 hours.
      day_usd: microToUsd(today.spent_micro_usd),
      daily_cap_usd: microToUsd(today.cap_micro_usd),
    },
    paused,
  };
}
