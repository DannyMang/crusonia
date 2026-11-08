// /api/workflows: start agent work. Research runs one Naive session per lead (NAIVE_AGENT_ID); the
// agent works through our MCP tools and can never send email.
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, parseJson, sqlFor, type AppEnv } from "../lib/context.ts";
import { LEAD_STAGES } from "../services/crm.ts";
import { MAX_RESEARCH_BATCH, startResearch } from "../services/workflows.ts";

export const workflows = new Hono<AppEnv>();

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
  const result = await startResearch(sqlFor(c.env), c.env, body, actorOf(c.get("principal")));
  return c.json(result, result.started.length ? 202 : 200);
});
