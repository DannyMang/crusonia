// /api/workflows: start agent work and inspect it. Research runs one Naive session per lead (NAIVE_AGENT_ID);
// the agent works through our MCP tools and can never send email. Workflows are naive_sessions grouped by
// purpose; a run is one session (src/services/runs.ts).
import { Hono } from "hono";
import { z } from "zod";
import { requireCredits } from "../billing/accounts.ts";
import { actorOf, parseJson, parseQuery, sqlFor, wsOf, type AppEnv } from "../lib/context.ts";
import { LEAD_STAGES } from "../services/crm.ts";
import { getRunDetail, listWorkflows } from "../services/runs.ts";
import { MAX_RESEARCH_BATCH, startResearch } from "../services/workflows.ts";

export const workflows = new Hono<AppEnv>();

const ListQuery = z.object({ runs: z.coerce.number().int().min(0).max(50).default(10) });

workflows.get("/", async (c) => {
  const q = parseQuery(c, ListQuery);
  return c.json({ data: await listWorkflows(sqlFor(c.env), wsOf(c), { recentRuns: q.runs }) });
});

// Steps come from cached Naive events (refreshed from Naive's free events API) plus our audit events.
workflows.get("/runs/:session_id", async (c) => c.json(await getRunDetail(sqlFor(c.env), c.env, wsOf(c), c.req.param("session_id"))));

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
