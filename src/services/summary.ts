// GET /api/summary: the dashboard Home in one call.
// TODO(workspaces): scope every count to the caller's workspace.
import { creditsToUsd } from "../billing/plans.ts";
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { listApprovals } from "./approvals.ts";
import { listReplies } from "./replies.ts";
import { listWorkflows, microToUsd } from "./runs.ts";

export type Pipeline = {
  found: number;
  researched: number;
  drafted: number;
  awaiting_approval: number;
  sent: number;
  replied: number;
  meetings: number;
};

/** How many leads ever reached each step (a lead that reached a later step counts in every earlier one). */
export type FunnelCounts = { found: number; researched: number; drafted: number; sent: number; replied: number; meetings: number };

/**
 * The funnel, cumulative: found >= researched >= drafted >= sent >= replied >= meetings, so each number reads as
 * "how many got this far". `awaiting_approval` is not a funnel step: it is how many leads have an email waiting for
 * the owner right now.
 *   found: every lead                       researched: scored, or any later step
 *   drafted: has a draft (any channel), or any later step
 *   sent: an outbound message (email, or a manual task marked sent), or any later step
 *   replied: an inbound reply or a reply stage, or a meeting        meetings: meeting_booked
 */
export function cumulativePipeline(c: FunnelCounts, awaitingWithOpenApproval: number): Pipeline {
  const meetings = Math.max(0, c.meetings);
  const replied = Math.max(c.replied, meetings);
  const sent = Math.max(c.sent, replied);
  const drafted = Math.max(c.drafted, sent);
  const researched = Math.max(c.researched, drafted);
  const found = Math.max(c.found, researched);
  return { found, researched, drafted, awaiting_approval: Math.max(0, awaitingWithOpenApproval), sent, replied, meetings };
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

export async function getSummary(sql: Sql, env: Env) {
  const [[counts], [funnel], approvals, replies] = await Promise.all([
    sql`select
          (select coalesce(jsonb_object_agg(stage, n), '{}'::jsonb)
             from (select stage, count(*)::int as n from leads group by stage) s) as by_stage,
          (select count(*)::int from leads l
             where l.stage = 'awaiting_approval'
               and exists (select 1 from approvals a where a.lead_id = l.id and a.kind = 'send'
                           and a.status = 'pending' and a.expires_at > now())) as awaiting_open,
          (select count(*)::int from approvals where status = 'pending' and expires_at > now()) as pending_total,
          (select count(*)::int from drafts d join leads l on l.id = d.lead_id
             where d.channel <> 'email' and d.status = 'open' and l.stage <> 'unsubscribed') as tasks_open,
          (select count(*)::int from approvals where status = 'pending' and expires_at > now() and kind = 'send') as pending_sends,
          -- Credits charged in the last 7 days (agent sessions and Apify runs, at the usage markup).
          (select coalesce(-sum(amount), 0)::text from credit_ledger
             where reason = 'usage' and created_at >= now() - interval '7 days') as week_credits,
          -- Raw provider cost behind it: Naive's running totals and Apify run usage.
          (select sum(consumed_micro_usd)::text from naive_sessions
             where coalesce(last_event_at, updated_at) >= now() - interval '7 days') as week_naive_micro,
          (select sum(usage_micro_usd)::text from apify_runs where created_at >= now() - interval '7 days') as week_apify_micro,
          coalesce((select value = 'true'::jsonb from settings where key = 'paused'), false) as paused`,
    sql`with base as (
          select l.stage, l.score,
                 exists (select 1 from messages m where m.lead_id = l.id and m.direction = 'in') as has_in,
                 exists (select 1 from messages m where m.lead_id = l.id and m.direction = 'out') as has_out,
                 exists (select 1 from drafts d where d.lead_id = l.id) as has_draft
          from leads l
        ),
        flags as (
          select stage, score, has_draft,
                 stage = 'meeting_booked' as meeting,
                 (stage in ('replied', 'interested', 'not_interested', 'meeting_booked') or has_in) as replied,
                 (stage in ('sent', 'replied', 'interested', 'not_interested', 'meeting_booked') or has_in or has_out) as sent
          from base
        )
        select count(*)::int as found,
               (count(*) filter (where score is not null or stage in ('qualified', 'disqualified', 'needs_review', 'awaiting_approval')
                                   or has_draft or sent))::int as researched,
               (count(*) filter (where has_draft or stage = 'awaiting_approval' or sent))::int as drafted,
               (count(*) filter (where sent))::int as sent,
               (count(*) filter (where replied))::int as replied,
               (count(*) filter (where meeting))::int as meetings
        from flags`,
    listApprovals(sql, { status: "pending", limit: 5 }),
    listReplies(sql, { limit: 5 }),
  ]);
  const paused = counts?.paused === true;
  const workflows = await listWorkflows(sql, { recentRuns: 3, paused });
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
    },
    paused,
  };
}
