// /api/autopilot: GET the switch, what the agents are doing, the feed and the tally (Home polls it). PUT {enabled}: turn
// it on or off. On: the default workflow exists, and it runs on its schedule. Off: nothing new starts by itself; sessions
// already open finish.
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, parseJson, parseQuery, sqlFor, wsOf, type AppEnv } from "../lib/context.ts";
import { getAutopilot, setAutopilot } from "../services/autopilot.ts";

export const autopilot = new Hono<AppEnv>();

autopilot.get("/", async (c) => {
  const q = parseQuery(c, z.object({ limit: z.coerce.number().int().min(1).max(200).default(40) }));
  return c.json(await getAutopilot(sqlFor(c.env), c.env, wsOf(c), { limit: q.limit }));
});

autopilot.put("/", async (c) => {
  const body = await parseJson(c, z.object({ enabled: z.boolean() }).strict());
  const sql = sqlFor(c.env);
  await setAutopilot(sql, c.env, wsOf(c), body.enabled, actorOf(c.get("principal")));
  return c.json(await getAutopilot(sql, c.env, wsOf(c)));
});
