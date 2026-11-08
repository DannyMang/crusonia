// /api/keys: per-user API keys for /mcp and /api ("Connect your agent"). The full key is returned once.
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, parseJson, sqlFor, type AppEnv } from "../lib/context.ts";
import { createApiKey, listApiKeys, revokeApiKey } from "../services/api-keys.ts";

export const keys = new Hono<AppEnv>();

keys.get("/", async (c) => c.json({ data: await listApiKeys(sqlFor(c.env)) }));

keys.post("/", async (c) => {
  const body = await parseJson(c, z.object({ name: z.string().trim().min(1).max(100) }).strict());
  const created = await createApiKey(sqlFor(c.env), body.name, actorOf(c.get("principal")));
  // `key` is shown once and never stored; only its SHA-256 hash is.
  c.header("Cache-Control", "no-store");
  return c.json(created, 201);
});

keys.delete("/:id", async (c) => c.json({ api_key: await revokeApiKey(sqlFor(c.env), c.req.param("id"), actorOf(c.get("principal"))) }));
