// GET /api/summary: the dashboard Home in one call.
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

export async function getSummary(sql: Sql, env: Env) {
  const [[counts], approvals, replies] = await Promise.all([
    sql`select
          (select coalesce(jsonb_object_agg(stage, n), '{}'::jsonb)
             from (select stage, count(*)::int as n from leads group by stage) s) as by_stage,
          (select count(*)::int from leads l
             where l.stage = 'awaiting_approval'
               and exists (select 1 from approvals a where a.lead_id = l.id and a.kind = 'send'
                           and a.status = 'pending' and a.expires_at > now())) as awaiting_open,
          (select count(*)::int from approvals where status = 'pending' and expires_at > now()) as pending_total,
          -- Naive's running totals for sessions active in the last 7 days.
          (select sum(consumed_micro_usd)::text from naive_sessions
             where coalesce(last_event_at, updated_at) >= now() - interval '7 days') as week_micro,
          coalesce((select value = 'true'::jsonb from settings where key = 'paused'), false) as paused`,
    listApprovals(sql, { status: "pending", limit: 5 }),
    listReplies(sql, { limit: 5 }),
  ]);
  const paused = counts?.paused === true;
  const workflows = await listWorkflows(sql, { recentRuns: 3, paused });
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
    active_workflows: workflows.filter((w) => w.active_runs > 0),
    recent_replies: replies.data,
    spend: { week_usd: microToUsd(counts?.week_micro), budget_usd: weeklyBudgetUsd(env) },
    paused,
  };
}
