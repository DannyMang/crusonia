// A/B experiments. Arms are the lead variants A and B (stable per lead, see ids.variantFor). Leads are
// enrolled explicitly; a draft created while the lead's experiment is running carries the experiment id
// (src/services/drafts.ts), and the per-arm stats are computed from those drafts:
//   sent       drafts sent in the arm (emails, follow-ups included)
//   replies    leads in the arm with an inbound message after their first sent draft
//   positive   of those, leads with a reply labeled 'interested'
//   cost_usd   Naive spend on the arm's leads since the experiment started (null when none is reported)
import { z } from "zod";
import type { Sql } from "../db.ts";
import { newId } from "../ids.ts";
import { ServiceError } from "./errors.ts";
import { microToUsd } from "./runs.ts";

const text = (max: number) => z.string().trim().min(1).max(max);
const variantSchema = z.object({ name: text(200).nullish(), description: text(4000).nullish() }).strict();

export const experimentInputSchema = z
  .object({
    name: text(200),
    hypothesis: text(4000).nullish(),
    segment: text(1000).nullish(),
    metric: text(100).default("positive_reply_rate"),
    stop_rule_sends_per_arm: z.number().int().min(1).max(1_000_000).nullish(),
    stop_rule_days: z.number().int().min(1).max(365).nullish(),
    variants: z.object({ A: variantSchema.optional(), B: variantSchema.optional() }).strict().optional(),
    /** Leads to enroll now (more later with POST /api/experiments/:id/leads). */
    lead_ids: z.array(text(64)).max(1000).optional(),
  })
  .strict();
export type ExperimentInput = z.infer<typeof experimentInputSchema>;

export type ArmStats = { sent: number; replies: number; positive: number; cost_usd: number | null };
export type VariantStats = { A: ArmStats; B: ArmStats };
export type StatsRow = { experiment_id: string; variant: string; sent: number; replies: number; positive: number; cost_micro: string | null };

type ExperimentRow = {
  id: string;
  name: string;
  hypothesis: string | null;
  segment: string | null;
  metric: string;
  stop_rule_sends_per_arm: number | null;
  stop_rule_days: number | null;
  status: "running" | "stopped";
  variants: Record<string, unknown>;
  created_at: Date | string;
  stopped_at: Date | string | null;
  enrolled_a?: number;
  enrolled_b?: number;
};

const emptyArm = (): ArmStats => ({ sent: 0, replies: 0, positive: 0, cost_usd: null });

/** Sums partial stats rows (one per source and arm) into {A, B} per experiment; arms with no rows are zero. */
export function foldVariantStats(rows: StatsRow[], ids: string[]): Map<string, VariantStats> {
  const out = new Map<string, VariantStats>(ids.map((id) => [id, { A: emptyArm(), B: emptyArm() }]));
  for (const r of rows) {
    if (r.variant !== "A" && r.variant !== "B") continue;
    const stats = out.get(r.experiment_id) ?? { A: emptyArm(), B: emptyArm() };
    const arm = stats[r.variant];
    arm.sent += Number(r.sent) || 0;
    arm.replies += Number(r.replies) || 0;
    arm.positive += Number(r.positive) || 0;
    const cost = microToUsd(r.cost_micro);
    if (cost !== null) arm.cost_usd = Math.round(((arm.cost_usd ?? 0) + cost) * 1_000_000) / 1_000_000;
    out.set(r.experiment_id, stats);
  }
  return out;
}

/** Whether a running experiment hit a stop rule (both arms reached the send target, or it ran long enough). */
export function stopRule(
  exp: Pick<ExperimentRow, "status" | "created_at" | "stop_rule_sends_per_arm" | "stop_rule_days">,
  stats: VariantStats,
  now = new Date(),
): { met: boolean; reason: string | null } {
  if (exp.status !== "running") return { met: false, reason: null };
  const n = exp.stop_rule_sends_per_arm;
  if (n && Math.min(stats.A.sent, stats.B.sent) >= n) return { met: true, reason: `Both arms reached ${n} sends` };
  const days = exp.stop_rule_days;
  if (days && now.getTime() - new Date(exp.created_at).getTime() >= days * 86_400_000) return { met: true, reason: `Ran for ${days} days` };
  return { met: false, reason: null };
}

export type DailyPoint = { date: string; A_replies: number; B_replies: number; A_sent: number; B_sent: number };
const MAX_DAYS = 120;
const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

/** One point per UTC day from the start to the end (inclusive, last 120 days at most); empty days are zero. */
export function dailySeries(
  start: Date | string,
  end: Date | string,
  sent: { variant: string; at: Date | string }[],
  replies: { variant: string; at: Date | string }[],
): DailyPoint[] {
  const points = new Map<string, DailyPoint>();
  const first = new Date(`${day(start)}T00:00:00Z`).getTime();
  const last = new Date(`${day(end)}T00:00:00Z`).getTime();
  for (let t = Math.max(first, last - (MAX_DAYS - 1) * 86_400_000); t <= last; t += 86_400_000) {
    const date = day(new Date(t));
    points.set(date, { date, A_replies: 0, B_replies: 0, A_sent: 0, B_sent: 0 });
  }
  for (const s of sent) {
    const p = points.get(day(s.at));
    if (p && (s.variant === "A" || s.variant === "B")) p[`${s.variant}_sent`]++;
  }
  for (const r of replies) {
    const p = points.get(day(r.at));
    if (p && (r.variant === "A" || r.variant === "B")) p[`${r.variant}_replies`]++;
  }
  return [...points.values()];
}

// The rows behind the stats: sent drafts, first reply per lead after its first send, Naive cost per arm.
const SENT_CTE = (sql: Sql, ids: string[]) => sql`
  sent as (
    select d.experiment_id, d.variant, d.lead_id, coalesce(d.delivered_at, d.sending_at, d.created_at) as sent_at
    from drafts d where d.experiment_id = any(${ids}::text[]) and d.status = 'sent'
  ),
  first_sent as (
    select experiment_id, variant, lead_id, min(sent_at) as sent_at from sent group by 1, 2, 3
  ),
  replied as (
    select f.experiment_id, f.variant, f.lead_id, min(m.created_at) as replied_at, bool_or(m.label = 'interested') as positive
    from first_sent f
    join messages m on m.lead_id = f.lead_id and m.direction = 'in' and m.created_at >= f.sent_at
    group by 1, 2, 3
  )`;

async function statsFor(sql: Sql, ids: string[]): Promise<Map<string, VariantStats>> {
  if (!ids.length) return new Map();
  const rows = (await sql`
    with ${SENT_CTE(sql, ids)},
    cost as (
      select l.experiment_id, l.variant, sum(s.consumed_micro_usd)::text as micro
      from naive_sessions s
      join leads l on l.id = s.lead_id
      join experiments e on e.id = l.experiment_id
      where l.experiment_id = any(${ids}::text[]) and s.created_at >= e.created_at
      group by 1, 2
    )
    select experiment_id, variant, count(*)::int as sent, 0 as replies, 0 as positive, null::text as cost_micro from sent group by 1, 2
    union all
    select experiment_id, variant, 0, count(*)::int, (count(*) filter (where positive))::int, null from replied group by 1, 2
    union all
    select experiment_id, variant, 0, 0, 0, micro from cost`) as StatsRow[];
  return foldVariantStats(rows, ids);
}

function present(row: ExperimentRow, stats: VariantStats) {
  const { enrolled_a, enrolled_b, ...exp } = row;
  const rule = stopRule(row, stats);
  return {
    ...exp,
    variants: { A: (row.variants?.A as object) ?? {}, B: (row.variants?.B as object) ?? {} },
    enrolled: { A: enrolled_a ?? 0, B: enrolled_b ?? 0 },
    stats,
    stop_rule_met: rule.met,
    stop_rule_reason: rule.reason,
  };
}
export type Experiment = ReturnType<typeof present>;

const SELECT_EXPERIMENTS = (sql: Sql) => sql`
  select e.*,
         (select count(*)::int from leads l where l.experiment_id = e.id and l.variant = 'A') as enrolled_a,
         (select count(*)::int from leads l where l.experiment_id = e.id and l.variant = 'B') as enrolled_b
  from experiments e`;

export async function listExperiments(sql: Sql, opts: { status?: string } = {}): Promise<Experiment[]> {
  const rows = (await sql`
    ${SELECT_EXPERIMENTS(sql)}
    where (${opts.status ?? null}::text is null or e.status = ${opts.status ?? null})
    order by e.created_at desc, e.id desc limit 200`) as ExperimentRow[];
  const stats = await statsFor(sql, rows.map((r) => r.id));
  return rows.map((r) => present(r, stats.get(r.id)!));
}

async function loadExperiment(sql: Sql, id: string): Promise<ExperimentRow> {
  const row = (await sql`${SELECT_EXPERIMENTS(sql)} where e.id = ${id}`)[0] as ExperimentRow | undefined;
  if (!row) throw new ServiceError("not_found", `No experiment with id ${id}`);
  return row;
}

export async function getExperiment(sql: Sql, id: string): Promise<{ experiment: Experiment; daily: DailyPoint[] }> {
  const row = await loadExperiment(sql, id);
  const [stats, [series]] = await Promise.all([
    statsFor(sql, [id]),
    sql`with ${SENT_CTE(sql, [id])}
        select (select coalesce(jsonb_agg(jsonb_build_object('variant', variant, 'at', sent_at)), '[]'::jsonb) from sent) as sent,
               (select coalesce(jsonb_agg(jsonb_build_object('variant', variant, 'at', replied_at)), '[]'::jsonb) from replied) as replies`,
  ]);
  const end = row.stopped_at ?? new Date();
  return {
    experiment: present(row, stats.get(id)!),
    daily: dailySeries(row.created_at, end, series?.sent ?? [], series?.replies ?? []),
  };
}

/** Enrolls leads that are not in another running experiment. Returns how many were enrolled. */
export async function enrollLeads(sql: Sql, id: string, leadIds: string[], actor: string) {
  const exp = await loadExperiment(sql, id);
  if (exp.status !== "running") throw new ServiceError("conflict", `Experiment ${id} is ${exp.status}; only running experiments take new leads`);
  const unique = [...new Set(leadIds)];
  const rows = await sql`
    with up as (
      update leads set experiment_id = ${id}, updated_at = now()
      where id = any(${unique}::text[])
        and (experiment_id is null or experiment_id = ${id}
             or experiment_id not in (select x.id from experiments x where x.status = 'running'))
      returning id, variant
    ), ev as (
      insert into events (lead_id, kind, data)
      select id, 'experiment_enrolled', jsonb_build_object('experiment_id', ${id}::text, 'variant', variant, 'actor', ${actor}::text) from up
    )
    select id from up`;
  const enrolled = new Set(rows.map((r) => r.id as string));
  return { enrolled: enrolled.size, skipped: unique.filter((l) => !enrolled.has(l)) };
}

export async function createExperiment(sql: Sql, input: ExperimentInput, actor: string) {
  const id = newId("exp");
  await sql`
    with ins as (
      insert into experiments (id, name, hypothesis, segment, metric, stop_rule_sends_per_arm, stop_rule_days, variants)
      values (${id}, ${input.name}, ${input.hypothesis ?? null}, ${input.segment ?? null}, ${input.metric},
              ${input.stop_rule_sends_per_arm ?? null}, ${input.stop_rule_days ?? null}, ${JSON.stringify(input.variants ?? {})}::jsonb)
      returning id, name
    )
    insert into events (lead_id, kind, data)
    select null, 'experiment_created', jsonb_build_object('experiment_id', id, 'name', name, 'actor', ${actor}::text) from ins`;
  const enrollment = input.lead_ids?.length ? await enrollLeads(sql, id, input.lead_ids, actor) : { enrolled: 0, skipped: [] };
  const { experiment } = await getExperiment(sql, id);
  return { experiment, enrollment };
}

/** Stops a running experiment (idempotent). New drafts for its leads no longer count toward it. */
export async function stopExperiment(sql: Sql, id: string, actor: string) {
  await sql`
    with up as (
      update experiments set status = 'stopped', stopped_at = now() where id = ${id} and status = 'running' returning id
    )
    insert into events (lead_id, kind, data)
    select null, 'experiment_stopped', jsonb_build_object('experiment_id', id, 'actor', ${actor}::text) from up`;
  return (await getExperiment(sql, id)).experiment;
}
