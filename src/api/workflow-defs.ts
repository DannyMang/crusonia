// /api/workflow-definitions: versioned qualification workflows (src/services/workflow-defs.ts), runs and run history
// (src/services/workflow-runs.ts). Separate from GET /api/workflows, the per-purpose aggregates Home shows.
import { Hono } from "hono";
import { z } from "zod";
import { requireCredits } from "../billing/accounts.ts";
import { actorOf, parseJson, parseQuery, sqlFor, wsOf, type AppEnv, type Principal } from "../lib/context.ts";
import {
  createDefinition,
  createVersion,
  definitionInputSchema,
  definitionPatchSchema,
  getDefinition,
  listDefinitions,
  patchDefinition,
  versionInputSchema,
  type WorkflowSource,
} from "../services/workflow-defs.ts";
import { MAX_TEST_LEADS, listRuns, resumeWorkflow, runWorkflow } from "../services/workflow-runs.ts";
import { MAX_RESEARCH_BATCH } from "../services/workflows.ts";

export const workflowDefs = new Hono<AppEnv>();

/** A person in the web app creates 'user' workflows; an agent (API key or the owner token) creates 'claude_code' ones. */
const sourceOf = (p: Principal): WorkflowSource => (p.kind === "clerk" ? "user" : "claude_code");

workflowDefs.get("/", async (c) => c.json({ data: await listDefinitions(sqlFor(c.env), wsOf(c)) }));

workflowDefs.post("/", async (c) => {
  const body = await parseJson(c, definitionInputSchema);
  const principal = c.get("principal");
  const out = await createDefinition(sqlFor(c.env), wsOf(c), body, { actor: actorOf(principal), source: sourceOf(principal) });
  return c.json(out, 201);
});

workflowDefs.get("/:id", async (c) => c.json(await getDefinition(sqlFor(c.env), wsOf(c), c.req.param("id"))));

workflowDefs.patch("/:id", async (c) => {
  const body = await parseJson(c, definitionPatchSchema);
  const principal = c.get("principal");
  const sql = sqlFor(c.env);
  const out = await patchDefinition(sql, wsOf(c), c.req.param("id"), body, actorOf(principal));
  if (!body.resume) return c.json(out);
  await requireCredits(c.env, principal, wsOf(c));
  const resumed = await resumeWorkflow(sql, c.env, wsOf(c), out.workflow.id, actorOf(principal));
  return c.json({ ...(await getDefinition(sql, wsOf(c), out.workflow.id)), resumed });
});

workflowDefs.post("/:id/versions", async (c) => {
  const body = await parseJson(c, versionInputSchema.extend({ name: z.string().trim().min(1).max(200).optional() }));
  const out = await createVersion(sqlFor(c.env), wsOf(c), c.req.param("id"), body, { actor: actorOf(c.get("principal")) });
  return c.json(out, 201);
});

const RunBody = z
  .object({
    version: z.number().int().min(1).optional(),
    test_leads: z.number().int().min(1).max(MAX_TEST_LEADS).optional(),
    cohort: z.string().trim().min(1).max(200).optional(),
    lead_ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_RESEARCH_BATCH).optional(),
  })
  .strict()
  .refine((b) => !(b.cohort && b.lead_ids), { message: "Pass cohort or lead_ids, not both" });

// Starts a paid run: one research session per lead (402 insufficient_credits when billing is enforced and empty).
workflowDefs.post("/:id/run", async (c) => {
  const body = await parseJson(c, RunBody);
  const principal = c.get("principal");
  await requireCredits(c.env, principal, wsOf(c)); // 402 insufficient_credits when the workspace's balance is <= 0
  const out = await runWorkflow(sqlFor(c.env), c.env, wsOf(c), c.req.param("id"), body, actorOf(principal));
  return c.json(out, 202);
});

const RunsQuery = z.object({
  version: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

workflowDefs.get("/:id/runs", async (c) => {
  const q = parseQuery(c, RunsQuery);
  return c.json(await listRuns(sqlFor(c.env), wsOf(c), c.req.param("id"), { version: q.version, limit: q.limit }));
});
