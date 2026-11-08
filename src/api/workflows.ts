// /api/workflows: start agent work and inspect it. Research runs one Naive session per lead (NAIVE_AGENT_ID);
// the agent works through our MCP tools and can never send email. Workflows are naive_sessions grouped by
// purpose; a run is one session (src/services/runs.ts).
import { Hono } from "hono";
import { z } from "zod";
import { requireCredits } from "../billing/accounts.ts";
import { actorOf, parseJson, parseQuery, sqlFor, wsOf, type AppEnv } from "../lib/context.ts";
import { LEAD_STAGES } from "../services/crm.ts";
import { getRunDetail, listWorkflows } from "../services/runs.ts";
import { getQualificationWorkflow, qualificationWorkflowSchema, saveQualificationWorkflow } from "../services/qualification.ts";
import { exportTrace, getTrace } from "../services/traces.ts";
import { MAX_RESEARCH_BATCH, startResearch } from "../services/workflows.ts";

export const workflows = new Hono<AppEnv>();

const ListQuery = z.object({ runs: z.coerce.number().int().min(0).max(50).default(10) });

workflows.get("/", async (c) => {
  const q = parseQuery(c, ListQuery);
  return c.json({ data: await listWorkflows(sqlFor(c.env), wsOf(c), { recentRuns: q.runs }) });
});

// Steps come from cached Naive events (refreshed from Naive's free events API) plus our audit events.
workflows.get("/runs/:session_id", async (c) => c.json(await getRunDetail(sqlFor(c.env), c.env, wsOf(c), c.req.param("session_id"))));

// The qualification workflow research follows: research questions, evidence requirements, completion criteria. PUT
// saves a new version; research sessions started afterwards get it.
workflows.get("/qualification", async (c) => c.json({ workflow: await getQualificationWorkflow(sqlFor(c.env), wsOf(c)) }));

workflows.put("/qualification", async (c) => {
  const body = await parseJson(c, qualificationWorkflowSchema);
  return c.json({ workflow: await saveQualificationWorkflow(sqlFor(c.env), wsOf(c), body, actorOf(c.get("principal"))) });
});

// The full trace ("View full trace"): every stored event, paginated by Naive seq, plus audit events, approvals and spend.
const TraceQuery = z.object({
  after_seq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

workflows.get("/runs/:session_id/trace", async (c) => {
  const q = parseQuery(c, TraceQuery);
  const viewer = { principal: c.get("principal"), workspace: wsOf(c) };
  return c.json(await getTrace(sqlFor(c.env), c.env, viewer, c.req.param("session_id"), { afterSeq: q.after_seq, limit: q.limit }));
});

// The whole trace as one JSON file.
workflows.get("/runs/:session_id/trace/export", async (c) => {
  const id = c.req.param("session_id");
  const trace = await exportTrace(sqlFor(c.env), c.env, { principal: c.get("principal"), workspace: wsOf(c) }, id);
  const file = `crusonia-trace-${id.replace(/[^a-zA-Z0-9_-]/g, "")}.json`;
  return new Response(JSON.stringify(trace, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${file}"`, "Cache-Control": "no-store" },
  });
});

const ResearchBody = z
  .object({
    lead_ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_RESEARCH_BATCH).optional(),
    cohort: z
      .object({
        stage: z.enum(LEAD_STAGES).optional(),
        source: z.string().max(100).optional(),
        min_score: z.number().int().min(0).max(100).optional(),
        limit: z.number().int().min(1).max(MAX_RESEARCH_BATCH).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((b) => Boolean(b.lead_ids) !== Boolean(b.cohort), { message: "Pass exactly one of lead_ids or cohort" });

workflows.post("/research", async (c) => {
  const body = await parseJson(c, ResearchBody);
  const principal = c.get("principal");
  await requireCredits(c.env, principal, wsOf(c)); // 402 insufficient_credits when the workspace's balance is <= 0
  const result = await startResearch(sqlFor(c.env), c.env, wsOf(c), body, actorOf(principal));
  return c.json(result, result.started.length ? 202 : 200);
});
