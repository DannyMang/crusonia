// GET /api/summary: the dashboard Home in one call.
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { listApprovals } from "./approvals.ts";
import { spendStatus } from "./limits.ts";
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

/**
 * Where leads are now: every lead counts in at most one bucket (unsubscribed leads in none).
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
  const [[counts], approvals, replies, today] = await Promise.all([
    sql`select
          (select coalesce(jsonb_object_agg(stage, n), '{}'::jsonb)
             from (select stage, count(*)::int as n from leads where workspace_id = ${ws} group by stage) s) as by_stage,
          (select count(*)::int from leads l
             where l.workspace_id = ${ws} and l.stage = 'awaiting_approval'
               and exists (select 1 from approvals a where a.workspace_id = ${ws} and a.lead_id = l.id and a.kind = 'send'
                           and a.status = 'pending' and a.expires_at > now())) as awaiting_open,
          (select count(*)::int from approvals where workspace_id = ${ws} and status = 'pending' and expires_at > now()) as pending_total,
          (select count(*)::int from approvals where workspace_id = ${ws} and status = 'pending' and expires_at > now() and kind = 'send') as pending_sends,
          -- Naive's running totals for sessions active in the last 7 days.
          (select sum(consumed_micro_usd)::text from naive_sessions
             where workspace_id = ${ws} and coalesce(last_event_at, updated_at) >= now() - interval '7 days') as week_micro,
          coalesce((select paused from workspaces where id = ${ws}), false) as paused`,
    listApprovals(sql, ws, { status: "pending", limit: 5 }),
    listReplies(sql, ws, { limit: 5 }),
    spendStatus(sql, env, ws),
  ]);
  const paused = counts?.paused === true;
  const workflows = await listWorkflows(sql, ws, { recentRuns: 3, paused });
  const byStage = (counts?.by_stage ?? {}) as Record<string, number>;
  return {
    pipeline: pipelineFromStages(byStage, counts?.awaiting_open ?? 0),
    pipeline_by_stage: byStage,
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
    spend: {
      week_usd: microToUsd(counts?.week_micro),
      budget_usd: weeklyBudgetUsd(env),
      // The per-workspace daily cap (src/services/limits.ts): spend of sessions started in the last 24 hours.
      day_usd: microToUsd(today.spent_micro_usd),
      daily_cap_usd: microToUsd(today.cap_micro_usd),
    },
    paused,
  };
}
