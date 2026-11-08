// Running a workflow definition version (./workflow-defs.ts) on a cohort or a set of leads, and its run history.
//
// A run pins one version. Every lead it starts records the run, the version and its own stable A/B variant
// (workflow_run_leads, and leads.workflow_*), then gets one Naive research session whose first message carries that
// version's research questions, evidence requirements, completion criteria and the variant's angle. Drafts and
// sessions created for the lead afterwards record the run, version and cohort (a trigger in schema.sql).
//
// The history is plain counts per run and per variant arm (leads, researched, qualified, drafted, approved, sent,
// replied): observed outcomes, no statistics, winners or recommendations.
import { creditsSql } from "../billing/credits-sql.ts";
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { newId } from "../ids.ts";
import { ApiError } from "../lib/errors.ts";
import type { FetchFn } from "../providers/http.ts";
import { ServiceError } from "./errors.ts";
import { requireInstanceOpen } from "./instance.ts";
import { isPaused } from "./settings.ts";
import { getDefinition, loadVersion, variantArms } from "./workflow-defs.ts";
import { MAX_RESEARCH_BATCH, startResearch, type ResearchOpts } from "./workflows.ts";

export const MAX_TEST_LEADS = 10;
export const MAX_AGENT_RUN_SESSIONS = 5;

/** `trigger`: what started it (a person when omitted). */
export type RunInput = { version?: number; test_leads?: number; cohort?: string; lead_ids?: string[]; trigger?: "schedule" | "csv_import" | "reply" | "operator" };

type Candidate = { id: string; stage: string; variant: string; cohort: string | null; excluded_at: Date | null };

/** Starts a run: research for each eligible lead under the given (default: latest) version. */
export async function runWorkflow(
  sql: Sql,
  env: Env,
  ws: string,
  workflowId: string,
  input: RunInput,
  actor: string,
  opts: { fetch?: FetchFn; research?: ResearchOpts } = {},
) {
  const { workflow } = await getDefinition(sql, ws, workflowId);
  if (!workflow.enabled) throw new ApiError(409, "workflow_disabled", "This workflow is turned off; enable it first");
  const version = input.version ?? workflow.latest_version;
  await loadVersion(sql, workflow.id, version); // 404 for an unknown version
  if (!env.NAIVE_API_KEY || !env.NAIVE_AGENT_ID) throw new ServiceError("config_missing", "NAIVE_API_KEY and NAIVE_AGENT_ID must be set to run a workflow.");
  if (await isPaused(sql, ws)) throw new ApiError(423, "paused", "Crusonia is paused; no new work starts (PUT /api/settings/pause to resume)");
  await requireInstanceOpen(sql, env, ws); // Before the run exists: a brake must not leave an empty run behind.
  // A per-run cap limits one run: it can't stop the next one that starts by itself.
  const capApplies = !(input.trigger && workflow.spend.period === "run");
  if (capApplies && workflow.spend.cap_usd !== null && workflow.spend.usd >= workflow.spend.cap_usd) {
    throw new ApiError(409, "spend_cap_reached", `This workflow used ${workflow.spend.credits} of its ${workflow.spend.cap_credits} credits ${workflow.spend.period === "week" ? "this week" : "on its last run"}: raise the cap to run it again`);
  }

  // A run nobody started by hand (a schedule, a trigger, an agent's call) stays small, whatever it was asked for.
  const most = input.trigger ? MAX_AGENT_RUN_SESSIONS : input.test_leads ? MAX_TEST_LEADS : MAX_RESEARCH_BATCH;
  const limit = Math.min(input.test_leads ?? MAX_RESEARCH_BATCH, most);
  const candidates = (
    input.lead_ids?.length
      ? await sql`select id, stage, variant, cohort, excluded_at from leads
                  where workspace_id = ${ws} and id = any(${input.lead_ids}::text[]) order by created_at limit ${limit}`
      : input.cohort
        ? await sql`select id, stage, variant, cohort, excluded_at from leads where workspace_id = ${ws} and cohort = ${input.cohort} order by created_at limit ${limit}`
        : workflow.trigger.stale_days
          ? // A re-research workflow: leads last researched long enough ago, oldest first. A lead waiting on the owner or
            // with an open draft stays as it is: research would replace the draft.
            await sql`
              select l.id, l.stage, l.variant, l.cohort, l.excluded_at from leads l
              where l.workspace_id = ${ws} and l.stage in ('qualified', 'disqualified') and l.excluded_at is null
                and exists (select 1 from naive_sessions s where s.lead_id = l.id and s.purpose = 'research')
                and not exists (select 1 from naive_sessions s where s.lead_id = l.id and s.purpose = 'research'
                                and s.created_at > now() - make_interval(days => ${workflow.trigger.stale_days}))
                and not exists (select 1 from drafts d where d.lead_id = l.id and d.status in ('draft', 'pending_approval', 'scheduled', 'open'))
              order by (select max(s.created_at) from naive_sessions s where s.lead_id = l.id and s.purpose = 'research') limit ${limit}`
          : // No cohort or leads given: new leads this workflow has never run on.
          await sql`
            select l.id, l.stage, l.variant, l.cohort, l.excluded_at from leads l
            where l.workspace_id = ${ws} and l.stage in ('new', 'no_consent') and l.excluded_at is null
              and not exists (select 1 from workflow_run_leads rl join workflow_runs r on r.id = rl.run_id
                              where rl.lead_id = l.id and r.workflow_id = ${workflow.id})
            order by l.created_at desc limit ${limit}`
  ) as Candidate[];
  if (!candidates.length) {
    throw new ApiError(409, "no_leads", input.cohort ? `No leads in cohort "${input.cohort}"` : workflow.trigger.stale_days ? `No leads were last researched more than ${workflow.trigger.stale_days} days ago` : "No leads to run on: import leads or pass lead_ids");
  }
  const open = new Set(
    (
      await sql`select lead_id from naive_sessions where workspace_id = ${ws} and purpose in ('research', 'redraft') and status in ('running', 'idle')
                and lead_id = any(${candidates.map((c) => c.id)}::text[])`
    ).map((r) => r.lead_id as string),
  );
  const skipped: { lead_id: string; reason: string }[] = [];
  const eligible: Candidate[] = [];
  for (const c of candidates) {
    const reason = c.stage === "unsubscribed" ? "unsubscribed" : c.excluded_at ? "excluded" : open.has(c.id) ? "session_open" : null;
    if (reason) skipped.push({ lead_id: c.id, reason });
    else eligible.push(c);
  }
  if (!eligible.length) throw new ApiError(409, "no_leads", "Every selected lead is unsubscribed, excluded or already being researched", { skipped });

  const runId = newId("wfr");
  const cohorts = [...new Set(eligible.map((c) => c.cohort))];
  const cohort = input.cohort ?? (cohorts.length === 1 ? cohorts[0] : null) ?? null;
  const ids = eligible.map((c) => c.id);
  // A run that started by itself is tracked until its sessions finish (./autopilot.ts), and is one at a time per workflow.
  const insertRun = sql.transaction([
    sql`insert into workflow_runs (id, workspace_id, workflow_id, version, cohort, test, actor, trigger, phase)
        values (${runId}, ${ws}, ${workflow.id}, ${version}, ${cohort}, ${Boolean(input.test_leads)}, ${actor}, ${input.trigger ?? "manual"}, ${input.trigger ? "researching" : "done"})`,
    // Research sessions and drafts created for these leads from now on record this run (see schema.sql).
    sql`update leads set workflow_id = ${workflow.id}, workflow_version = ${version}, workflow_run_id = ${runId}, updated_at = now()
        where workspace_id = ${ws} and id = any(${ids}::text[])`,
    sql`insert into events (workspace_id, lead_id, kind, data) values (${ws}, null, 'workflow_run_started', ${JSON.stringify({
      run_id: runId,
      workflow_id: workflow.id,
      version,
      cohort,
      leads: ids.length,
      test: Boolean(input.test_leads),
      actor,
    })}::jsonb)`,
  ]);
  await insertRun.catch((err) => {
    if ((err as { code?: string }).code === "23505") throw new ApiError(409, "active_run", "This workflow already has a run going");
    throw err;
  });

  const result = await startResearch(sql, env, ws, { lead_ids: ids }, actor, opts.fetch, opts.research);
  const session = new Map(result.started.map((s) => [s.lead_id, s.session_id]));
  const failed = new Map(result.failed.map((f) => [f.lead_id, f.error]));
  const late = new Map(result.skipped.map((s) => [s.lead_id, s.reason]));
  const rows = [
    ...eligible.map((c) => ({
      lead_id: c.id,
      variant: c.variant,
      cohort: c.cohort,
      session_id: session.get(c.id) ?? null,
      status: session.has(c.id) ? "started" : failed.has(c.id) ? "failed" : "skipped",
      reason: failed.get(c.id) ?? late.get(c.id) ?? null,
    })),
    ...skipped.map((s) => {
      const c = candidates.find((x) => x.id === s.lead_id)!;
      return { lead_id: c.id, variant: c.variant, cohort: c.cohort, session_id: null, status: "skipped", reason: s.reason };
    }),
  ];
  await sql`
    insert into workflow_run_leads (run_id, lead_id, variant, cohort, session_id, status, reason)
    select ${runId}, lead_id, variant, cohort, session_id, status, reason
    from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as x(lead_id text, variant text, cohort text, session_id text, status text, reason text)
    on conflict do nothing`;
  return {
    run: { id: runId, workflow_id: workflow.id, version, cohort, test: Boolean(input.test_leads) },
    started: result.started,
    skipped: [...skipped, ...result.skipped],
    failed: result.failed,
  };
}

/**
 * PATCH { resume: true }: continue the latest run's leads that never finished research (no verdict, no open session),
 * under the same version. Nothing to continue: `resumed` is null.
 */
export async function resumeWorkflow(sql: Sql, env: Env, ws: string, workflowId: string, actor: string, opts: { fetch?: FetchFn } = {}) {
  const [last] = await sql`select id, version from workflow_runs where workflow_id = ${workflowId} and workspace_id = ${ws} order by started_at desc limit 1`;
  if (!last) return null;
  const leads = await sql`
    select rl.lead_id from workflow_run_leads rl join leads l on l.id = rl.lead_id
    where rl.run_id = ${last.id} and l.stage in ('new', 'no_consent', 'researching')
      and not exists (select 1 from naive_sessions s where s.workspace_id = ${ws} and s.lead_id = l.id and s.status in ('running', 'idle'))`;
  if (!leads.length) return null;
  return runWorkflow(sql, env, ws, workflowId, { version: last.version as number, lead_ids: leads.map((r) => r.lead_id as string) }, actor, opts);
}

// ---------- history ----------

type RunRow = {
  id: string;
  trigger: string;
  phase: string;
  actor: string | null;
  version: number;
  cohort: string | null;
  test: boolean;
  started_at: Date;
  found: number;
  researched: number;
  qualified: number;
  drafted: number;
  sent: number;
  open_sessions: number;
  error_sessions: number;
  sessions: number;
  needs_review: number;
  waiting: number;
  cost_micro: string | number | null;
  cost_credits: string | number | null;
  trace_steps: number;
  session_ids: string[] | null;
};

type ArmRow = { variant: string; leads: number; researched: number; qualified: number; drafted: number; approved: number; sent: number; replied: number };

// A lead counts as researched once research produced a verdict or a review question, or it moved past that.
const RESEARCHED = ["qualified", "disqualified", "needs_review", "awaiting_approval", "sent", "replied", "interested", "not_interested", "meeting_booked"];
const REPLY_STAGES = ["replied", "interested", "not_interested", "meeting_booked", "unsubscribed"];

const TIMELINE_KINDS = [
  "workflow_run_started",
  "lead_added",
  "research_started",
  "lead_scored",
  "lead_needs_review",
  "draft_created",
  "approval_approved",
  "approval_rejected",
  "email_sent",
  "followup_scheduled",
  "email_received",
  "reply_classified",
  "followups_stopped",
  "task_sent",
];

function timelineText(kind: string, d: Record<string, unknown>, who: string | null): string {
  const lead = who ? ` (${who})` : "";
  switch (kind) {
    case "workflow_run_started":
      if (d.finding) return `Run started by itself: finding up to ${d.finding} leads, version ${d.version}`;
      return `Run started on ${d.leads} lead${d.leads === 1 ? "" : "s"}${d.cohort ? ` from ${d.cohort}` : ""}, version ${d.version}`;
    case "lead_added":
      return `Found${lead}`;
    case "research_started":
      return `Research started${lead}`;
    case "lead_scored":
      return `Scored ${d.score ?? ""}${d.qualified === true ? ", qualified" : d.qualified === false ? ", not qualified" : ""}${lead}`.replace("Scored ,", "Scored,");
    case "lead_needs_review":
      return `Paused for review: ${typeof d.question === "string" ? d.question.slice(0, 160) : "missing evidence"}${lead}`;
    case "draft_created":
      return `${d.channel && d.channel !== "email" ? `Manual ${d.channel} task` : "Email draft"} v${d.version ?? ""} ready${d.approval_code ? ` for approval ${d.approval_code}` : ""}${lead}`;
    case "approval_approved":
      return `Approved ${d.code ?? ""} via ${d.via ?? "web"}${lead}`;
    case "approval_rejected":
      return `Rejected ${d.code ?? ""}${lead}`;
    case "email_sent":
      return `Email sent${lead}`;
    case "followup_scheduled":
      return `Follow-up scheduled${lead}`;
    case "email_received":
      return `Reply received${lead}`;
    case "reply_classified":
      return `Reply labelled ${d.label ?? ""}${lead}`;
    case "followups_stopped":
      return `Pending follow-ups stopped (${d.reason ?? "reply"})${lead}`;
    case "task_sent":
      return `Manual task marked sent${lead}`;
    default:
      return kind;
  }
}

const usd = (micro: string | number | null | undefined) => Math.round(Number(micro ?? 0) / 10_000) / 100;

// A run's plain tally: what its agents did, and the times a person stepped in.
const AGENT_TIMELINE_KINDS = new Set(["lead_added", "research_started", "lead_scored", "lead_needs_review", "draft_created", "followup_scheduled"]);
const OWNER_TIMELINE_KINDS = new Set(["approval_approved", "approval_rejected", "task_sent"]);

/** GET /api/workflow-definitions/:id/runs: runs (newest first), per-variant counts for one version, leads paused for review. */
export async function listRuns(sql: Sql, ws: string, workflowId: string, opts: { version?: number; limit?: number } = {}) {
  const { workflow } = await getDefinition(sql, ws, workflowId);
  const limit = Math.min(opts.limit ?? 20, 100);
  const paused = await isPaused(sql, ws);
  const runs = (await sql`
    select r.id, r.trigger, r.phase, r.actor, r.version, r.cohort, r.test, r.started_at,
      count(rl.lead_id) filter (where rl.status in ('started', 'found', 'queued'))::int as found,
      count(rl.lead_id) filter (where rl.status = 'started' and (l.score is not null or l.stage = any(${RESEARCHED}::text[])))::int as researched,
      count(rl.lead_id) filter (where rl.status = 'started' and l.qualified is true)::int as qualified,
      count(rl.lead_id) filter (where rl.status = 'started' and l.stage = 'needs_review' and l.workflow_run_id = r.id)::int as needs_review,
      (select count(distinct d.lead_id)::int from drafts d where d.workflow_run_id = r.id) as drafted,
      (select count(distinct d.lead_id)::int from drafts d where d.workflow_run_id = r.id and d.status = 'sent') as sent,
      (select count(*)::int from approvals a join drafts d on d.id = a.draft_id
        where d.workflow_run_id = r.id and a.kind = 'send' and a.status = 'pending' and a.expires_at > now()) as waiting,
      (select count(*)::int from naive_sessions s where s.workflow_run_id = r.id) as sessions,
      (select count(*)::int from naive_sessions s where s.workflow_run_id = r.id and s.status in ('running', 'idle')) as open_sessions,
      (select count(*)::int from naive_sessions s where s.workflow_run_id = r.id and s.status = 'error') as error_sessions,
      (select coalesce(sum(s.consumed_micro_usd), 0) + coalesce(sum((select sum(a.usage_micro_usd) from apify_runs a where a.session_id = s.id)), 0)
         from naive_sessions s where s.workflow_run_id = r.id) as cost_micro,
      (select coalesce(sum(${creditsSql(sql, "s.consumed_micro_usd")}), 0) + coalesce(sum((select sum(${creditsSql(sql, "a.usage_micro_usd")}) from apify_runs a where a.session_id = s.id)), 0)
         from naive_sessions s where s.workflow_run_id = r.id) as cost_credits,
      (select count(*)::int from naive_session_events e join naive_sessions s on s.id = e.session_id where s.workflow_run_id = r.id) as trace_steps,
      (select array_agg(s.id order by s.created_at) from naive_sessions s where s.workflow_run_id = r.id) as session_ids
    from workflow_runs r
    left join workflow_run_leads rl on rl.run_id = r.id
    left join leads l on l.id = rl.lead_id
    where r.workflow_id = ${workflow.id}
    group by r.id
    order by r.started_at desc
    limit ${limit}`) as RunRow[];

  const runIds = runs.map((r) => r.id);
  const events = runIds.length
    ? ((await sql`
        select rl.run_id, e.kind, e.data, e.created_at, coalesce(l.company, l.name, l.domain, l.email) as who
        from workflow_run_leads rl
        join workflow_runs r on r.id = rl.run_id
        join events e on e.workspace_id = r.workspace_id and e.lead_id = rl.lead_id and e.created_at >= r.started_at
        left join leads l on l.id = rl.lead_id
        where rl.run_id = any(${runIds}::text[]) and rl.status in ('started', 'found', 'queued') and e.kind = any(${TIMELINE_KINDS}::text[])
          -- Events after a later run of the same lead belong to that run.
          and not exists (select 1 from workflow_run_leads rl2 join workflow_runs r2 on r2.id = rl2.run_id
                          where rl2.lead_id = rl.lead_id and r2.started_at > r.started_at and r2.started_at <= e.created_at)
        union all
        select (e.data->>'run_id') as run_id, e.kind, e.data, e.created_at, null as who
        from events e where e.workspace_id = ${ws} and e.kind = 'workflow_run_started' and e.data->>'run_id' = any(${runIds}::text[])
        order by created_at`) as { run_id: string; kind: string; data: Record<string, unknown>; created_at: Date; who: string | null }[])
    : [];
  const timeline = new Map<string, { at: Date; text: string }[]>();
  const steppedIn = new Map<string, number>();
  const agentDid = new Map<string, number>();
  for (const e of events) {
    const list = timeline.get(e.run_id) ?? [];
    list.push({ at: e.created_at, text: timelineText(e.kind, e.data ?? {}, e.who) });
    timeline.set(e.run_id, list);
    const tally = OWNER_TIMELINE_KINDS.has(e.kind) ? steppedIn : AGENT_TIMELINE_KINDS.has(e.kind) ? agentDid : null;
    if (tally) tally.set(e.run_id, (tally.get(e.run_id) ?? 0) + 1);
  }

  // Variants: one version's runs, counted per arm over the distinct leads they started.
  const [latestRun] = await sql`select version from workflow_runs where workflow_id = ${workflow.id} order by started_at desc limit 1`;
  const version = opts.version ?? (latestRun?.version as number | undefined) ?? workflow.latest_version;
  const versionRow = await loadVersion(sql, workflow.id, version);
  const arms = (await sql`
    with v as (
      select distinct on (rl.lead_id) rl.lead_id, rl.variant, r.started_at
      from workflow_run_leads rl join workflow_runs r on r.id = rl.run_id
      where r.workflow_id = ${workflow.id} and r.version = ${version} and rl.status = 'started'
      order by rl.lead_id, r.started_at
    )
    select v.variant,
      count(*)::int as leads,
      count(*) filter (where l.score is not null or l.stage = any(${RESEARCHED}::text[]))::int as researched,
      count(*) filter (where l.qualified is true)::int as qualified,
      count(*) filter (where exists (select 1 from drafts d where d.lead_id = v.lead_id and d.workflow_id = ${workflow.id} and d.workflow_def_version = ${version}))::int as drafted,
      count(*) filter (where exists (
        select 1 from drafts d where d.lead_id = v.lead_id and d.workflow_id = ${workflow.id} and d.workflow_def_version = ${version}
          and (d.status in ('scheduled', 'sending', 'sent') or exists (select 1 from approvals a where a.draft_id = d.id and a.status = 'approved'))))::int as approved,
      count(*) filter (where exists (select 1 from drafts d where d.lead_id = v.lead_id and d.workflow_id = ${workflow.id} and d.workflow_def_version = ${version} and d.status = 'sent'))::int as sent,
      count(*) filter (where exists (select 1 from messages m where m.lead_id = v.lead_id and m.direction = 'in' and m.created_at >= v.started_at))::int as replied
    from v join leads l on l.id = v.lead_id
    group by v.variant`) as ArmRow[];
  const [versionRuns] = await sql`select count(*)::int as n from workflow_runs where workflow_id = ${workflow.id} and version = ${version}`;

  const needsReview = (await sql`
    select l.id as lead_id, coalesce(l.company, l.name, l.domain, l.email) as company, l.review_question as question,
           coalesce((select max(e.created_at) from events e where e.lead_id = l.id and e.kind = 'lead_needs_review'), l.updated_at) as paused_at
    from leads l
    where l.workspace_id = ${ws} and l.workflow_id = ${workflow.id} and l.stage = 'needs_review'
    order by paused_at desc limit 50`) as { lead_id: string; company: string | null; question: string | null; paused_at: Date }[];

  const zero = { leads: 0, researched: 0, qualified: 0, drafted: 0, approved: 0, sent: 0, replied: 0 };
  return {
    runs: runs.map((r) => ({
      id: r.id,
      version: r.version,
      cohort: r.cohort,
      test: r.test,
      started_at: r.started_at,
      // What started it: schedule, csv_import, reply, operator, or a person (manual).
      trigger: r.trigger,
      agent_actions: agentDid.get(r.id) ?? 0,
      owner_actions: steppedIn.get(r.id) ?? 0,
      // running | paused | waiting (drafts wait for approval) | error (every session failed) | done
      status:
        r.open_sessions > 0 || r.phase !== "done" ? (paused ? "paused" : "running") : r.waiting > 0 ? "waiting" : r.sessions > 0 && r.error_sessions === r.sessions ? "error" : "done",
      needs_review: r.needs_review,
      cost_usd: usd(r.cost_micro),
      cost_credits: Number(r.cost_credits ?? 0),
      counts: { found: r.found, researched: r.researched, qualified: r.qualified, drafted: r.drafted, sent: r.sent },
      timeline: timeline.get(r.id) ?? [],
      trace_steps: r.trace_steps,
      // Each session's trace: GET /api/workflows/runs/:session_id/trace.
      session_ids: r.session_ids ?? [],
    })),
    variants: {
      version,
      runs: (versionRuns?.n as number) ?? 0,
      arms: variantArms(versionRow).map((arm) => {
        const row = arms.find((a) => a.variant === arm.key);
        const { variant: _v, ...counts } = row ?? { variant: arm.key, ...zero };
        return { key: arm.key, label: arm.label, angle: arm.angle, counts };
      }),
    },
    needs_review: needsReview,
  };
}

export { REPLY_STAGES };
