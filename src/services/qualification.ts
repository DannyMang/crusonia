// The qualification workflow: what research must establish before a lead is scored. The ICP comes from the Company
// summary; this adds the research questions, the evidence requirements and the completion criteria. Research sessions
// get it in their first message (and the get_workflow MCP tool). One per workspace, saved under settings key
// `qualification_workflow:<workspace id>`, versioned: every save is a new version. Nothing is hardcoded: with no workflow saved, research works as before.
//
// Pause on missing evidence: a lead whose evidence doesn't cover every required requirement is never scored. It moves
// to `needs_review` with a `review_question` (the agent's, or one naming the missing evidence), and the run goes on.
import { z } from "zod";
import type { Sql } from "../db.ts";
import { getProfile, type Profile } from "./profile.ts";

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

const keyOf = (ws: string) => `qualification_workflow:${ws}`;

export async function getQualificationWorkflow(sql: Sql, ws: string): Promise<QualificationWorkflow | null> {
  const [row] = await sql`select value from settings where key = ${keyOf(ws)}`;
  return (row?.value as QualificationWorkflow | undefined) ?? null;
}

/** Saves a new version (the previous one stays in the audit trail). */
export async function saveQualificationWorkflow(sql: Sql, ws: string, input: QualificationWorkflowInput, actor: string): Promise<QualificationWorkflow> {
  const def = qualificationWorkflowSchema.parse(input);
  const rows = await sql`
    with prev as (select value from settings where key = ${keyOf(ws)}),
    up as (
      insert into settings (key, value)
      values (${keyOf(ws)}, ${JSON.stringify(def)}::jsonb
              || jsonb_build_object('version', coalesce(((select value from prev)->>'version')::int, 0) + 1, 'updated_at', now()))
      on conflict (key) do update set value = excluded.value
      returning value
    ),
    ev as (
      insert into events (workspace_id, lead_id, kind, data)
      select ${ws}, null, 'qualification_workflow_saved', jsonb_build_object('version', value->'version', 'actor', ${actor}::text, 'workflow', value) from up
    )
    select value from up`;
  return rows[0]!.value as QualificationWorkflow;
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

/** MCP get_workflow: the qualification workflow and the ICP it scores against (from the Company summary). */
export async function getWorkflowForAgent(
  sql: Sql,
  ws: string,
): Promise<{ workflow: QualificationWorkflow | null; icp: Pick<Profile, "sells" | "icp_description" | "segments" | "signals"> | null }> {
  const [workflow, profile] = await Promise.all([getQualificationWorkflow(sql, ws), getProfile(sql, ws)]);
  return {
    workflow,
    icp: profile ? { sells: profile.sells, icp_description: profile.icp_description, segments: profile.segments, signals: profile.signals } : null,
  };
}
