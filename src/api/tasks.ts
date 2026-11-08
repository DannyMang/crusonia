// /api/tasks: the manual outreach queue. Drafts on a manual channel (LinkedIn, X, intro, the owner's own mailbox)
// that the owner sends personally, then marks sent or skipped. Nothing here sends anything.
import { Hono } from "hono";
import { z } from "zod";
import { billingOwnerOf, requireCredits } from "../billing/accounts.ts";
import { actorOf, parseJson, parseQuery, sqlFor, type AppEnv } from "../lib/context.ts";
import { MANUAL_CHANNELS } from "../services/channels.ts";
import { getTask, listTasks, markTaskSent, skipTask, TASK_STATUSES } from "../services/tasks.ts";
import { startRedraft } from "../services/workflows.ts";

export const tasks = new Hono<AppEnv>();

const ListQuery = z.object({
  status: z.enum([...TASK_STATUSES, "all"]).default("open"),
  channel: z.enum(MANUAL_CHANNELS).optional(),
  lead_id: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

tasks.get("/", async (c) => c.json(await listTasks(sqlFor(c.env), parseQuery(c, ListQuery))));

tasks.get("/:id", async (c) => c.json({ task: await getTask(sqlFor(c.env), c.req.param("id")) }));

// The owner sent it. `body` records the text actually sent when they edited it before sending.
const SentBody = z.object({ body: z.string().trim().max(10_000).optional(), note: z.string().trim().max(2000).optional() }).strict();

tasks.post("/:id/sent", async (c) => {
  const body = await parseJson(c, SentBody);
  return c.json(await markTaskSent(sqlFor(c.env), c.req.param("id"), body, actorOf(c.get("principal"))));
});

const SkipBody = z.object({ reason: z.string().trim().max(2000).optional() }).strict();

tasks.post("/:id/skip", async (c) => {
  const body = await parseJson(c, SkipBody);
  return c.json(await skipTask(sqlFor(c.env), c.req.param("id"), body, actorOf(c.get("principal"))));
});

// The agent writes a new version (a paid Naive session). Follow it in GET /api/workflows (purpose redraft); the new
// version supersedes this task when it lands.
const RegenerateBody = z.object({ instructions: z.string().trim().min(1).max(2000).optional() }).strict();

tasks.post("/:id/regenerate", async (c) => {
  const body = await parseJson(c, RegenerateBody);
  const principal = c.get("principal");
  await requireCredits(c.env, principal); // 402 insufficient_credits when BILLING_ENFORCED and the balance is <= 0
  const result = await startRedraft(sqlFor(c.env), c.env, { draftId: c.req.param("id"), instructions: body.instructions }, actorOf(principal), undefined, {
    billingOwnerId: billingOwnerOf(principal),
  });
  return c.json(result, 202);
});
