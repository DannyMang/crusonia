// /api/settings/pause (the workspace's kill switch) and /api/suppressions (its do-not-contact list).
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, parseJson, parseQuery, sqlFor, wsOf, type AppEnv } from "../lib/context.ts";
import { ApiError } from "../lib/errors.ts";
import { addSuppression, isPaused, listSuppressions, removeSuppression, setPaused } from "../services/settings.ts";

export const settings = new Hono<AppEnv>();

// Paused: no sends (checked again at send time), no new research sessions, no auto-allowed tools.
settings.get("/pause", async (c) => c.json({ paused: await isPaused(sqlFor(c.env), wsOf(c)) }));

settings.put("/pause", async (c) => {
  const body = await parseJson(c, z.object({ paused: z.boolean() }));
  return c.json({ paused: await setPaused(sqlFor(c.env), wsOf(c), body.paused, actorOf(c.get("principal"))) });
});

export const suppressions = new Hono<AppEnv>();

const ListQuery = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().max(320).optional(),
});

suppressions.get("/", async (c) => {
  const q = parseQuery(c, ListQuery);
  return c.json(await listSuppressions(sqlFor(c.env), wsOf(c), { q: q.q, limit: q.limit, after: q.cursor }));
});

suppressions.post("/", async (c) => {
  const body = await parseJson(c, z.object({ email: z.string().trim().max(320), reason: z.string().trim().min(1).max(200).default("manual") }));
  const result = await addSuppression(sqlFor(c.env), wsOf(c), body.email, body.reason, actorOf(c.get("principal")));
  return c.json(result, result.created ? 201 : 200);
});

suppressions.delete("/:email", async (c) => {
  const removed = await removeSuppression(sqlFor(c.env), wsOf(c), decodeURIComponent(c.req.param("email")), actorOf(c.get("principal")));
  if (!removed) throw new ApiError(404, "not_found", "That email is not suppressed");
  return c.body(null, 204);
});
