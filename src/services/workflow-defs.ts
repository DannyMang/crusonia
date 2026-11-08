// Qualification workflow definitions: what research must establish for a lead, as named, versioned, immutable
// definitions per workspace. A definition holds the name, trigger and spend cap; each version holds the content:
//   icp                 where the ICP comes from ({source: 'company_summary'} by default: the saved profile)
//   research_questions  what research answers for each lead
//   evidence_required   facts that need a sourced evidence item; a lead missing one goes to needs_review, unscored
//   done_when           completion criteria
//   steps               the builder's step graph (find / research / condition / draft / tasks / approval / notify /
//                       sync_crm / send / end), each with `next` ids
//   variants            A/B arms ({key, label, angle}); a lead's arm is its stable leads.variant, and the angle is
//                       a short instruction the drafting agent receives for leads in that arm
// Editing creates a new version (the table refuses updates). A run (./workflow-runs.ts) pins a version: the leads it
// starts record it, research sessions get its content in their first message and through get_workflow, and the
// missing-evidence gate in save_research checks its requirements.
//
// The workspace's default definition (is_default) is what research follows for leads never run under a workflow,
// and what GET/PUT /api/workflows/qualification read and write (./qualification.ts).
import { z } from "zod";
import type { Sql } from "../db.ts";
import { newId } from "../ids.ts";
import { ServiceError } from "./errors.ts";
import type { QualificationWorkflow } from "./qualification.ts";


export const STEP_KINDS = ["trigger", "find", "research", "condition", "draft", "tasks", "approval", "notify", "sync_crm", "send", "end"] as const;
export const TRIGGER_KINDS = ["schedule", "csv_import", "reply", "manual"] as const;
export const WORKFLOW_SOURCES = ["user", "claude_code", "template"] as const;
export type WorkflowSource = (typeof WORKFLOW_SOURCES)[number];

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "letters, digits, - and _");

export const stepSchema = z.looseObject({
  id,
  kind: z.enum(STEP_KINDS),
  title: text(200),
  provider: z.string().trim().max(64).nullish(),
  branch: z.string().trim().max(64).nullish(),
  next: z.array(id).max(10).default([]),
});
export type WorkflowStep = z.infer<typeof stepSchema>;

/** A new definition's steps when none are given: what a run actually does. */
export const DEFAULT_STEPS: WorkflowStep[] = [
  { id: "trigger", kind: "trigger", title: "CSV import", next: ["research"] },
  { id: "research", kind: "research", title: "Research each lead", provider: "naive", next: ["qualified"] },
  { id: "qualified", kind: "condition", title: "Qualified, with every required evidence item?", next: ["draft", "end"] },
  { id: "draft", kind: "draft", title: "Draft the first message", provider: "naive", branch: "yes", next: ["approval"] },
  { id: "approval", kind: "approval", title: "Owner approves the exact draft", next: ["send"] },
  { id: "send", kind: "send", title: "Send with AgentMail", provider: "agentmail", next: ["sync_crm"] },
  { id: "sync_crm", kind: "sync_crm", title: "Update HubSpot after a reply", provider: "hubspot", next: ["end"] },
  { id: "end", kind: "end", title: "Done", next: [] },
];

const triggerSchema = z.object({ kind: z.enum(TRIGGER_KINDS), label: z.string().trim().max(200).nullish() });
const icpSchema = z
  .object({ source: z.enum(["company_summary", "custom"]).default("company_summary"), text: z.string().trim().max(4000).nullish() })
  .refine((i) => i.source !== "custom" || Boolean(i.text), { message: "icp.text is required when icp.source is 'custom'" });
const variantSchema = z.object({
  key: z.enum(["A", "B"]),
  label: z.string().trim().max(100).nullish(),
  angle: z.string().trim().max(500).nullish().describe("A short instruction for drafts to leads in this arm, e.g. 'Lead with the hiring signal'."),
});
const spendSchema = z.object({
  cap_usd: z.number().min(0).max(10_000).nullish(),
  period: z.enum(["week", "run"]).default("week"),
});

/** The content of a version (POST /api/workflow-definitions and /:id/versions). */
export const versionInputSchema = z.object({
  label: z.string().trim().max(200).nullish(),
  steps: z.array(stepSchema).max(40).optional(),
  icp: icpSchema.default({ source: "company_summary" }),
  research_questions: z.array(text(500)).max(20).default([]),
  evidence_required: z
    .array(text(500))
    .max(20)
    .default([])
    .describe("Facts each lead needs a sourced evidence item for, e.g. 'A dated hiring signal with a source URL'."),
  done_when: z.string().trim().max(1000).nullish(),
  variants: z.array(variantSchema).max(2).default([]),
});

export const definitionInputSchema = versionInputSchema.extend({
  name: text(200),
  trigger: triggerSchema.optional(),
  enabled: z.boolean().optional(),
  spend: spendSchema.optional(),
  /** Only 'template' is taken from the body; otherwise the caller decides (a person: user, an agent: claude_code). */
  source: z.enum(WORKFLOW_SOURCES).optional(),
});
export type DefinitionInput = z.input<typeof definitionInputSchema>;
export type VersionInput = z.input<typeof versionInputSchema> & { name?: string };

export const definitionPatchSchema = z
  .object({
    name: text(200).optional(),
    enabled: z.boolean().optional(),
    trigger: triggerSchema.optional(),
    spend: spendSchema.optional(),
    /** Shorthand for spend.cap_usd ("Raise cap to $N"). */
    cap_usd: z.number().min(0).max(10_000).nullish(),
    /** Turn it on and continue the latest run's unfinished leads (./workflow-runs.ts resumeWorkflow). */
    resume: z.boolean().optional(),
  })
  .strict();

// Stored forms keep a stable id per question and requirement (the evidence gate and the agent key on them).
type StoredQuestion = { id: string; question: string };
type StoredRequirement = { id: string; description: string; required?: boolean };

type DefRow = {
  id: string;
  workspace_id: string;
  name: string;
  source: WorkflowSource;
  enabled: boolean;
  trigger: { kind: (typeof TRIGGER_KINDS)[number]; label?: string | null };
  spend_cap_usd: string | number | null;
  spend_period: "week" | "run";
  latest_version: number;
  is_default: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

export type VersionRow = {
  workflow_id: string;
  version: number;
  label: string | null;
  steps: WorkflowStep[];
  icp: { source: "company_summary" | "custom"; text?: string | null };
  research_questions: (StoredQuestion | string)[];
  evidence_required: (StoredRequirement | string)[];
  done_when: string | null;
  variants: z.infer<typeof variantSchema>[];
  created_by: string | null;
  created_at: Date;
};

const questions = (v: Pick<VersionRow, "research_questions">): StoredQuestion[] =>
  v.research_questions.map((q, i) => (typeof q === "string" ? { id: `q${i + 1}`, question: q } : q));
const requirements = (v: Pick<VersionRow, "evidence_required">): StoredRequirement[] =>
  v.evidence_required.map((r, i) => (typeof r === "string" ? { id: `e${i + 1}`, description: r, required: true } : r));

/** The API's Version shape. */
export function versionView(v: VersionRow) {
  return {
    version: v.version,
    label: v.label ?? null,
    created_at: v.created_at,
    created_by: v.created_by,
    steps: v.steps?.length ? v.steps : DEFAULT_STEPS,
    icp: v.icp,
    research_questions: questions(v).map((q) => q.question),
    evidence_required: requirements(v).map((r) => r.description),
    done_when: v.done_when ?? "",
    variants: variantArms(v),
  };
}
export type VersionView = ReturnType<typeof versionView>;

/** Both arms, with their labels and angles (an arm without a stored entry has no angle). */
export function variantArms(v: Pick<VersionRow, "variants">): { key: "A" | "B"; label: string; angle: string | null }[] {
  return (["A", "B"] as const).map((key) => {
    const arm = (v.variants ?? []).find((a) => a.key === key);
    return { key, label: arm?.label || `Variant ${key}`, angle: arm?.angle || null };
  });
}

/** A version as the research agent reads it: the qualification workflow shape the playbook and the evidence gate use. */
export function toQualification(def: Pick<DefRow, "name">, v: VersionRow): QualificationWorkflow {
  return {
    name: def.name,
    version: v.version,
    updated_at: new Date(v.created_at).toISOString(),
    research_questions: questions(v),
    evidence_requirements: requirements(v).map((r) => ({ id: r.id, description: r.description, required: r.required !== false })),
    completion_criteria: (v.done_when ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

function checkSteps(steps: WorkflowStep[] | undefined) {
  if (!steps) return;
  const ids = new Set<string>();
  for (const s of steps) {
    if (ids.has(s.id)) throw new ServiceError("invalid", `Two steps have the id "${s.id}"; step ids must be unique.`);
    ids.add(s.id);
  }
  for (const s of steps) {
    const missing = s.next.filter((n) => !ids.has(n));
    if (missing.length) throw new ServiceError("invalid", `Step "${s.id}" points to unknown step(s): ${missing.join(", ")}.`);
  }
  if (JSON.stringify(steps).length > 50_000) throw new ServiceError("invalid", "The steps are too large (50 KB at most).");
}

function versionInsert(sql: Sql, workflowId: string, version: number, input: z.infer<typeof versionInputSchema>, actor: string) {
  return sql`
    insert into workflow_def_versions (workflow_id, version, label, steps, icp, research_questions, evidence_required, done_when, variants, created_by)
    values (${workflowId}, ${version}, ${input.label ?? null}, ${JSON.stringify(input.steps ?? DEFAULT_STEPS)}::jsonb, ${JSON.stringify(input.icp)}::jsonb,
            ${JSON.stringify(input.research_questions)}::jsonb, ${JSON.stringify(input.evidence_required)}::jsonb, ${input.done_when ?? null},
            ${JSON.stringify(input.variants)}::jsonb, ${actor})`;
}

/** Creates a definition and its version 1. `source` is the caller's kind (user / claude_code); the body may say template. */
export async function createDefinition(
  sql: Sql,
  ws: string,
  raw: DefinitionInput,
  ctx: { actor: string; source: WorkflowSource; isDefault?: boolean; storedContent?: Pick<VersionRow, "research_questions" | "evidence_required"> },
) {
  const input = definitionInputSchema.parse(raw);
  checkSteps(input.steps);
  const id = newId("wf");
  const source = input.source === "template" ? "template" : ctx.source;
  const trigger = input.trigger ?? { kind: "manual", label: "Run manually" };
  const content = ctx.storedContent ? { ...input, ...ctx.storedContent } : input;
  await sql.transaction([
    sql`insert into workflow_defs (id, workspace_id, name, source, enabled, trigger, spend_cap_usd, spend_period, latest_version, is_default, created_by)
        values (${id}, ${ws}, ${input.name}, ${source}, ${input.enabled ?? true}, ${JSON.stringify(trigger)}::jsonb,
                ${input.spend?.cap_usd ?? null}, ${input.spend?.period ?? "week"}, 1, ${ctx.isDefault ?? false}, ${ctx.actor})`,
    versionInsert(sql, id, 1, content as z.infer<typeof versionInputSchema>, ctx.actor),
    sql`insert into events (workspace_id, lead_id, kind, data) values (${ws}, null, 'workflow_created', ${JSON.stringify({
      workflow_id: id,
      version: 1,
      name: input.name,
      source,
      actor: ctx.actor,
    })}::jsonb)`,
  ]);
  const out = await getDefinition(sql, ws, id);
  return { ...out, version: out.versions.find((v) => v.version === 1)! };
}

/** A new immutable version with the given content; `name` (optional) renames the definition. */
export async function createVersion(
  sql: Sql,
  ws: string,
  id: string,
  raw: VersionInput,
  ctx: { actor: string; storedContent?: Pick<VersionRow, "research_questions" | "evidence_required"> },
) {
  const input = versionInputSchema.parse(raw);
  const name = raw.name === undefined ? undefined : text(200).parse(raw.name);
  checkSteps(input.steps);
  const def = await loadDef(sql, ws, id);
  const content = ctx.storedContent ? { ...input, ...ctx.storedContent } : input;
  let version = 0;
  for (let attempt = 1; ; attempt++) {
    const [latest] = await sql`select coalesce(max(version), 0)::int as v from workflow_def_versions where workflow_id = ${def.id}`;
    version = (latest!.v as number) + 1;
    try {
      await sql.transaction([
        versionInsert(sql, def.id, version, content as z.infer<typeof versionInputSchema>, ctx.actor),
        sql`update workflow_defs set latest_version = greatest(latest_version, ${version}), name = coalesce(${name ?? null}, name), updated_at = now()
            where id = ${def.id}`,
        sql`insert into events (workspace_id, lead_id, kind, data) values (${ws}, null, 'workflow_version_created', ${JSON.stringify({
          workflow_id: def.id,
          version,
          actor: ctx.actor,
        })}::jsonb)`,
      ]);
      break;
    } catch (err) {
      // A concurrent save took this version number: take the next one.
      if (attempt < 4 && (err as { code?: string }).code === "23505") continue;
      throw err;
    }
  }
  const out = await getDefinition(sql, ws, def.id);
  return { ...out, version: out.versions.find((v) => v.version === version)! };
}

export async function patchDefinition(sql: Sql, ws: string, id: string, raw: z.infer<typeof definitionPatchSchema>, actor: string) {
  const def = await loadDef(sql, ws, id);
  const { cap_usd, resume, ...rest } = raw;
  const patch = {
    ...rest,
    ...(resume ? { enabled: true } : {}),
    ...(cap_usd !== undefined ? { spend: { period: rest.spend?.period ?? def.spend_period, cap_usd } } : {}),
  };
  await sql.transaction([
    sql`update workflow_defs set
          name = coalesce(${patch.name ?? null}, name),
          enabled = coalesce(${patch.enabled ?? null}::boolean, enabled),
          trigger = coalesce(${patch.trigger ? JSON.stringify(patch.trigger) : null}::jsonb, trigger),
          spend_cap_usd = case when ${patch.spend !== undefined} then ${patch.spend?.cap_usd ?? null}::numeric else spend_cap_usd end,
          spend_period = coalesce(${patch.spend?.period ?? null}, spend_period),
          updated_at = now()
        where id = ${def.id}`,
    sql`insert into events (workspace_id, lead_id, kind, data) values (${ws}, null, 'workflow_updated', ${JSON.stringify({ workflow_id: def.id, ...patch, resume, actor })}::jsonb)`,
  ]);
  return getDefinition(sql, ws, def.id);
}

async function loadDef(sql: Sql, ws: string, id: string): Promise<DefRow> {
  const [row] = await sql`select * from workflow_defs where id = ${id} and workspace_id = ${ws}`;
  if (!row) throw new ServiceError("not_found", `No workflow with id ${id}. GET /api/workflow-definitions (or get_workflow) lists them.`);
  return row as DefRow;
}

export async function loadVersion(sql: Sql, workflowId: string, version: number): Promise<VersionRow> {
  const [row] = await sql`select * from workflow_def_versions where workflow_id = ${workflowId} and version = ${version}`;
  if (!row) throw new ServiceError("not_found", `Workflow ${workflowId} has no version ${version}.`);
  return row as VersionRow;
}

// ---------- reads ----------

type DefStats = {
  workflow_id: string;
  running: number;
  waiting_drafts: number;
  remaining: number;
  spend_week_micro: string | number | null;
  spend_last_run_micro: string | number | null;
  last_run_id: string | null;
  last_run_started_at: Date | null;
  last_run_running: number | null;
  last_run_errors: number | null;
  last_run_sessions: number | null;
  last_run_found: number | null;
  last_run_researched: number | null;
  last_run_qualified: number | null;
  last_run_drafted: number | null;
  last_run_test: boolean | null;
};

async function statsFor(sql: Sql, ids: string[]): Promise<Map<string, DefStats>> {
  if (!ids.length) return new Map();
  const rows = (await sql`
    with last as (
      select distinct on (workflow_id) workflow_id, id, started_at, test from workflow_runs
      where workflow_id = any(${ids}::text[]) order by workflow_id, started_at desc
    )
    select d.id as workflow_id,
      (select count(*)::int from naive_sessions s join workflow_runs r on r.id = s.workflow_run_id
        where r.workflow_id = d.id and s.status in ('running', 'idle')) as running,
      (select count(*)::int from approvals a join drafts dr on dr.id = a.draft_id
        where dr.workflow_id = d.id and a.kind = 'send' and a.status = 'pending' and a.expires_at > now()) as waiting_drafts,
      (select count(*)::int from workflow_run_leads rl join leads l on l.id = rl.lead_id
        where rl.run_id = last.id and l.stage in ('new', 'no_consent', 'researching')
          and not exists (select 1 from naive_sessions s where s.lead_id = l.id and s.status in ('running', 'idle'))) as remaining,
      (select coalesce(sum(s.consumed_micro_usd), 0) from naive_sessions s join workflow_runs r on r.id = s.workflow_run_id
        where r.workflow_id = d.id and s.created_at > now() - interval '7 days') as spend_week_micro,
      (select coalesce(sum(s.consumed_micro_usd), 0) from naive_sessions s where s.workflow_run_id = last.id) as spend_last_run_micro,
      last.id as last_run_id, last.started_at as last_run_started_at, last.test as last_run_test,
      (select count(*)::int from naive_sessions s where s.workflow_run_id = last.id and s.status in ('running', 'idle')) as last_run_running,
      (select count(*)::int from naive_sessions s where s.workflow_run_id = last.id and s.status = 'error') as last_run_errors,
      (select count(*)::int from naive_sessions s where s.workflow_run_id = last.id) as last_run_sessions,
      (select count(*)::int from workflow_run_leads rl where rl.run_id = last.id and rl.status = 'started') as last_run_found,
      (select count(*)::int from workflow_run_leads rl join leads l on l.id = rl.lead_id where rl.run_id = last.id and rl.status = 'started'
        and (l.score is not null or l.stage in ('qualified', 'disqualified', 'needs_review', 'awaiting_approval', 'sent', 'replied', 'interested', 'not_interested', 'meeting_booked'))) as last_run_researched,
      (select count(*)::int from workflow_run_leads rl join leads l on l.id = rl.lead_id where rl.run_id = last.id and rl.status = 'started' and l.qualified is true) as last_run_qualified,
      (select count(distinct dr.lead_id)::int from drafts dr where dr.workflow_run_id = last.id) as last_run_drafted
    from workflow_defs d left join last on last.workflow_id = d.id
    where d.id = any(${ids}::text[])`) as DefStats[];
  return new Map(rows.map((r) => [r.workflow_id, r]));
}

const usd = (micro: string | number | null | undefined) => Math.round(Number(micro ?? 0) / 10_000) / 100;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The API's Def shape. status: off (turned off) | paused (Crusonia is paused) | running (research sessions open) |
 * budget_paused (the spend cap is reached) | waiting (drafts wait for approval) | error (the last run failed) | done.
 */
function defView(d: DefRow, s: DefStats | undefined, paused: boolean) {
  const spendUsd = usd(d.spend_period === "run" ? s?.spend_last_run_micro : s?.spend_week_micro);
  const capUsd = d.spend_cap_usd === null ? null : Number(d.spend_cap_usd);
  const capped = capUsd !== null && spendUsd >= capUsd;
  const status = !d.enabled
    ? "off"
    : paused
      ? "paused"
      : (s?.running ?? 0) > 0
        ? "running"
        : capped && (s?.remaining ?? 0) > 0
          ? "budget_paused"
          : (s?.waiting_drafts ?? 0) > 0
            ? "waiting"
            : s?.last_run_sessions && s.last_run_errors === s.last_run_sessions
              ? "error"
              : "done";
  const lastStatus = !s?.last_run_id
    ? null
    : (s.last_run_running ?? 0) > 0
      ? paused
        ? "paused"
        : "running"
      : s.last_run_sessions && s.last_run_errors === s.last_run_sessions
        ? "error"
        : "done";
  return {
    id: d.id,
    name: d.name,
    source: d.source,
    enabled: d.enabled,
    is_default: d.is_default,
    trigger: { kind: d.trigger.kind, label: d.trigger.label || TRIGGER_LABEL[d.trigger.kind] },
    latest_version: d.latest_version,
    spend: { usd: spendUsd, cap_usd: capUsd, period: d.spend_period },
    status,
    agent: "Researcher",
    waiting: (s?.waiting_drafts ?? 0) > 0 ? { drafts: s!.waiting_drafts } : null,
    remaining: s?.last_run_id ? (s.remaining ?? 0) : null,
    last_run: s?.last_run_id
      ? {
          id: s.last_run_id,
          started_at: s.last_run_started_at,
          status: lastStatus,
          summary: `${s.last_run_test ? "Test on " : ""}${plural(s.last_run_found ?? 0, "lead")} · ${s.last_run_researched ?? 0} researched · ${s.last_run_qualified ?? 0} qualified · ${s.last_run_drafted ?? 0} drafted`,
          detail: null,
        }
      : null,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}
export type DefView = ReturnType<typeof defView>;

const TRIGGER_LABEL: Record<(typeof TRIGGER_KINDS)[number], string> = {
  schedule: "On a schedule",
  csv_import: "When a CSV is imported",
  reply: "When a lead replies",
  manual: "Run manually",
};

async function isPausedNow(sql: Sql, ws: string): Promise<boolean> {
  const [row] = await sql`select paused from workspaces where id = ${ws}`;
  return row?.paused === true;
}

export async function listDefinitions(sql: Sql, ws: string): Promise<DefView[]> {
  const defs = (await sql`select * from workflow_defs where workspace_id = ${ws} order by is_default desc, updated_at desc`) as DefRow[];
  const [stats, paused] = await Promise.all([statsFor(sql, defs.map((d) => d.id)), isPausedNow(sql, ws)]);
  return defs.map((d) => defView(d, stats.get(d.id), paused));
}

export async function getDefinition(sql: Sql, ws: string, id: string): Promise<{ workflow: DefView; versions: VersionView[] }> {
  const def = await loadDef(sql, ws, id);
  const [versions, stats, paused] = await Promise.all([
    sql`select * from workflow_def_versions where workflow_id = ${def.id} order by version desc`,
    statsFor(sql, [def.id]),
    isPausedNow(sql, ws),
  ]);
  return { workflow: defView(def, stats.get(def.id), paused), versions: (versions as VersionRow[]).map(versionView) };
}

// ---------- the default definition (GET/PUT /api/workflows/qualification) ----------

export async function defaultDefinition(sql: Sql, ws: string): Promise<{ def: DefRow; version: VersionRow } | null> {
  const [row] = await sql`
    select to_jsonb(d) as def, to_jsonb(v) as version from workflow_defs d
    join workflow_def_versions v on v.workflow_id = d.id and v.version = d.latest_version
    where d.workspace_id = ${ws} and d.is_default`;
  return row ? { def: row.def as DefRow, version: row.version as VersionRow } : null;
}

/** The default definition's latest version as a qualification workflow, or null when there is none. */
export async function defaultQualification(sql: Sql, ws: string): Promise<QualificationWorkflow | null> {
  const d = await defaultDefinition(sql, ws);
  return d ? toQualification(d.def, d.version) : null;
}

/** What one lead's research follows: its workflow run's version, else the default definition. */
export type LeadBrief = { workflow: QualificationWorkflow | null; workflow_id: string | null; angle: string | null; variant: string; draft: boolean };

export async function researchBriefs(sql: Sql, ws: string, leadIds: string[]): Promise<Map<string, LeadBrief>> {
  if (!leadIds.length) return new Map();
  const rows = (await sql`
    select l.id, l.variant, to_jsonb(d) as def, to_jsonb(v) as version
    from leads l
    left join workflow_defs d on d.workspace_id = l.workspace_id
      and d.id = coalesce(l.workflow_id, (select id from workflow_defs where workspace_id = ${ws} and is_default))
    left join workflow_def_versions v on v.workflow_id = d.id
      and v.version = case when l.workflow_id is not null then l.workflow_version else d.latest_version end
    where l.workspace_id = ${ws} and l.id = any(${leadIds}::text[])`) as { id: string; variant: string; def: DefRow | null; version: VersionRow | null }[];
  return new Map(
    rows.map((r) => {
      const has = Boolean(r.def && r.version);
      const steps = has && r.version!.steps?.length ? r.version!.steps : DEFAULT_STEPS;
      return [
        r.id,
        {
          workflow: has ? toQualification(r.def!, r.version!) : null,
          workflow_id: r.def?.id ?? null,
          angle: has ? (variantArms(r.version!).find((a) => a.key === r.variant)?.angle ?? null) : null,
          variant: r.variant,
          // A definition without a draft step means research and scoring only.
          draft: steps.some((s) => s.kind === "draft" || s.kind === "tasks"),
        },
      ];
    }),
  );
}

/** The qualification workflow the evidence gate checks for one lead (its run's version, else the default). */
export async function workflowForLead(sql: Sql, ws: string, leadId: string): Promise<QualificationWorkflow | null> {
  return (await researchBriefs(sql, ws, [leadId])).get(leadId)?.workflow ?? null;
}
