// The qualification workflow: what research must establish before a lead is scored. The ICP comes from the Company
// summary; this adds the research questions, the evidence requirements and the completion criteria. Research sessions
// get it in their first message (and the get_workflow MCP tool).
//
// Workflows are versioned definitions (./workflow-defs.ts). A lead run under a workflow version follows that version;
// any other lead follows the workspace's default definition. GET/PUT /api/workflows/qualification and the functions
// below read and write that default definition (every save is a new version). With none saved, research works as
// before (score against the Company summary).
//
// Pause on missing evidence: a lead whose evidence doesn't cover every required requirement is never scored. It moves
// to `needs_review` with a `review_question` (the agent's, or one naming the missing evidence), and the run goes on.
import { z } from "zod";
import type { Sql } from "../db.ts";
import { ServiceError } from "./errors.ts";
import { getProfile, type Profile } from "./profile.ts";
import {
  OWNER_WORKSPACE_ID,
  createDefinition,
  createVersion,
  defaultDefinition,
  defaultQualification,
  getDefinition,
  listDefinitions,
  loadVersion,
  researchBriefs,
  toQualification,
} from "./workflow-defs.ts";

const text = (max: number) => z.string().trim().min(1).max(max);
const slug = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "lowercase letters, digits, - and _ (e.g. 'hiring_signal')");

export const qualificationWorkflowSchema = z
  .object({
    name: text(200).default("Qualification"),
    research_questions: z
      .array(z.object({ id: slug, question: text(500) }))
      .max(20)
      .default([])
      .describe("What research should answer for each lead, e.g. 'Who owns outbound today?'"),
    evidence_requirements: z
      .array(z.object({ id: slug, description: text(500), required: z.boolean().default(true) }))
      .max(20)
      .default([])
      .describe("Facts a lead needs sourced evidence for. A lead missing a required one goes to needs_review, never scored."),
    completion_criteria: z.array(text(500)).max(20).default([]).describe("When research of a lead is done."),
  })
  .strict();
export type QualificationWorkflowInput = z.input<typeof qualificationWorkflowSchema>;
export type QualificationWorkflow = z.infer<typeof qualificationWorkflowSchema> & { version: number; updated_at: string };

export async function getQualificationWorkflow(sql: Sql, ws: string = OWNER_WORKSPACE_ID): Promise<QualificationWorkflow | null> {
  return defaultQualification(sql, ws);
}

/** Saves a new version of the default definition (creating it on the first save). Older versions stay. */
export async function saveQualificationWorkflow(
  sql: Sql,
  input: QualificationWorkflowInput,
  actor: string,
  ws: string = OWNER_WORKSPACE_ID,
): Promise<QualificationWorkflow> {
  const def = qualificationWorkflowSchema.parse(input);
  const content = {
    research_questions: def.research_questions.map((q) => q.question),
    evidence_required: def.evidence_requirements.map((r) => r.description),
    done_when: def.completion_criteria.join("\n") || null,
  };
  // Keep the caller's ids and optional flags: the agent tags evidence with them.
  const storedContent = { research_questions: def.research_questions, evidence_required: def.evidence_requirements };
  const current = await defaultDefinition(sql, ws);
  if (current) await createVersion(sql, ws, current.def.id, { ...content, name: def.name, steps: current.version.steps, variants: current.version.variants }, { actor, storedContent });
  else await createDefinition(sql, ws, { ...content, name: def.name, trigger: { kind: "manual", label: "Run manually" } }, { actor, source: "user", isDefault: true, storedContent });
  return (await defaultQualification(sql, ws))!;
}

export type RequirementGap = { id: string; description: string };

/** Required evidence requirements not covered by `covered` (requirement ids on the lead's evidence). Pure. */
export function missingRequirements(workflow: Pick<QualificationWorkflow, "evidence_requirements"> | null, covered: Iterable<string | null | undefined>): RequirementGap[] {
  if (!workflow) return [];
  const have = new Set([...covered].filter((c): c is string => Boolean(c)));
  return workflow.evidence_requirements.filter((r) => r.required !== false && !have.has(r.id)).map((r) => ({ id: r.id, description: r.description }));
}

/** The review question when the agent didn't write one. */
export function missingEvidenceQuestion(gaps: RequirementGap[]): string {
  return `Missing required evidence: ${gaps.map((g) => g.description).join("; ")}. Can you confirm it, or should this lead be dropped?`.slice(0, 500);
}

/** The workflow as the research message carries it (owner configuration, fenced as data for the agent to follow). */
export function workflowBrief(workflow: QualificationWorkflow | null): string | null {
  if (!workflow) return null;
  const lines = [`Qualification workflow "${workflow.name}" v${workflow.version} (the owner's; follow it):`];
  if (workflow.research_questions.length) {
    lines.push("Research questions:", ...workflow.research_questions.map((q) => `- [${q.id}] ${q.question}`));
  }
  if (workflow.evidence_requirements.length) {
    lines.push(
      "Evidence requirements (tag each evidence item with its requirement id; a required one you cannot source means review, not a guess):",
      ...workflow.evidence_requirements.map((r) => `- [${r.id}]${r.required === false ? " (optional)" : " (required)"} ${r.description}`),
    );
  }
  if (workflow.completion_criteria.length) lines.push("Completion criteria:", ...workflow.completion_criteria.map((c) => `- ${c}`));
  return lines.join("\n");
}

/**
 * MCP get_workflow: the qualification workflow a lead's research follows (its workflow run's version, else the default
 * definition), or a given definition's version, with the ICP it scores against (from the Company summary) and, when
 * it comes from a definition, the definition itself. Without arguments: the default plus the list of definitions.
 */
export async function getWorkflowForAgent(
  sql: Sql,
  opts: { lead_id?: string; workflow_id?: string; version?: number } = {},
  ws: string = OWNER_WORKSPACE_ID,
) {
  const profile = await getProfile(sql);
  const icp: Pick<Profile, "sells" | "icp_description" | "segments" | "signals"> | null = profile
    ? { sells: profile.sells, icp_description: profile.icp_description, segments: profile.segments, signals: profile.signals }
    : null;
  if (opts.workflow_id) {
    const { workflow, versions } = await getDefinition(sql, ws, opts.workflow_id);
    const version = opts.version ?? workflow.latest_version;
    const row = await loadVersion(sql, workflow.id, version);
    return { workflow: toQualification(workflow, row), icp, definition: workflow, version: versions.find((v) => v.version === version) ?? null };
  }
  if (opts.lead_id) {
    const brief = (await researchBriefs(sql, ws, [opts.lead_id])).get(opts.lead_id);
    if (!brief) throw new ServiceError("not_found", `No lead with id ${opts.lead_id}.`);
    return { workflow: brief.workflow, icp, workflow_id: brief.workflow_id, variant: brief.variant, angle: brief.angle };
  }
  const [workflow, definitions] = await Promise.all([defaultQualification(sql, ws), listDefinitions(sql, ws)]);
  return {
    workflow,
    icp,
    definitions: definitions.map((d) => ({ id: d.id, name: d.name, latest_version: d.latest_version, is_default: d.is_default, source: d.source })),
  };
}
