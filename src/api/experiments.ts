// /api/experiments: A/B experiments over lead variants, with per-arm stats (src/services/experiments.ts).
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, parseJson, parseQuery, sqlFor, type AppEnv } from "../lib/context.ts";
import {
  createExperiment,
  enrollLeads,
  experimentInputSchema,
  getExperiment,
  listExperiments,
  stopExperiment,
} from "../services/experiments.ts";

export const experiments = new Hono<AppEnv>();

const ListQuery = z.object({ status: z.enum(["running", "stopped"]).optional() });

experiments.get("/", async (c) => {
  const q = parseQuery(c, ListQuery);
  return c.json({ data: await listExperiments(sqlFor(c.env), q) });
});

experiments.post("/", async (c) => {
  const body = await parseJson(c, experimentInputSchema);
  return c.json(await createExperiment(sqlFor(c.env), body, actorOf(c.get("principal"))), 201);
});

experiments.get("/:id", async (c) => c.json(await getExperiment(sqlFor(c.env), c.req.param("id"))));

// Only stopping is supported: a stopped experiment keeps its stats; new drafts no longer count toward it.
experiments.patch("/:id", async (c) => {
  await parseJson(c, z.object({ status: z.literal("stopped") }).strict());
  return c.json({ experiment: await stopExperiment(sqlFor(c.env), c.req.param("id"), actorOf(c.get("principal"))) });
});

// Enroll more leads (each keeps its own variant). Leads in another running experiment are skipped.
experiments.post("/:id/leads", async (c) => {
  const body = await parseJson(c, z.object({ lead_ids: z.array(z.string().trim().min(1).max(64)).min(1).max(1000) }).strict());
  return c.json(await enrollLeads(sqlFor(c.env), c.req.param("id"), body.lead_ids, actorOf(c.get("principal"))));
});
