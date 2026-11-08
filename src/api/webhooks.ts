// Provider webhooks. Not behind /api auth: each request is authenticated by its signature over the raw
// body (checked before anything else, including the database), then deduped by the provider's event id.
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Env } from "../env.ts";
import { sqlFor } from "../lib/context.ts";
import { errorBody } from "../lib/errors.ts";
import { verifyNaive, verifySvix } from "../lib/signatures.ts";
import { AgentMailEventSchema, handleAgentMailEvent } from "../services/inbound.ts";
import { claimWebhookEvent, releaseWebhookEvent } from "../services/webhook-events.ts";
import { handleSessionIdle } from "../services/workflows.ts";

export const webhooks = new Hono<{ Bindings: Env }>();

webhooks.use(bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json(errorBody("payload_too_large", "Body too large"), 413) }));

const nowSeconds = () => Math.floor(Date.now() / 1000);

function parseBody<T extends z.ZodType>(c: Context, raw: string, schema: T): z.infer<T> | Response {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return c.json(errorBody("invalid_json", "Body is not JSON"), 400);
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : c.json(errorBody("invalid_payload", parsed.error.issues.map((i) => i.message).join("; ")), 400);
}

// AgentMail (Svix-signed): message.received / delivered / bounced / complained.
webhooks.post("/agentmail", async (c) => {
  const secret = c.env.AGENTMAIL_WEBHOOK_SECRET;
  if (!secret) return c.json(errorBody("not_configured", "AGENTMAIL_WEBHOOK_SECRET is not set"), 503);
  const raw = await c.req.text();
  const verified = await verifySvix({
    secret,
    id: c.req.header("svix-id"),
    timestamp: c.req.header("svix-timestamp"),
    signature: c.req.header("svix-signature"),
    body: raw,
    now: nowSeconds(),
  });
  if (!verified.ok) return c.json(errorBody("invalid_signature", verified.reason), 401);
  const event = parseBody(c, raw, AgentMailEventSchema);
  if (event instanceof Response) return event;

  const sql = sqlFor(c.env);
  if (!(await claimWebhookEvent(sql, "agentmail", event.event_id))) return c.json({ ok: true, duplicate: true });
  try {
    const result = await handleAgentMailEvent(sql, event);
    return c.json({ ok: true, event_type: event.event_type, ...result });
  } catch (err) {
    // Release the claim and answer 5xx so Svix retries; handlers are safe to re-run.
    await releaseWebhookEvent(sql, event.event_id).catch(() => {});
    throw err;
  }
});

const NaiveDelivery = z.looseObject({
  id: z.string().min(1),
  type: z.string(),
  created_at: z.string().optional(),
  data: z.looseObject({ session_id: z.string().optional(), stop_reason: z.string().nullish() }).optional(),
});

// Naive (vetta.sh): session.idle, budget.exceeded, webhook.test. Answers fast; the work runs in waitUntil.
// If that work fails, the session row stays 'running' and the minute cron reconciles it from the events API.
webhooks.post("/naive", async (c) => {
  const secret = c.env.NAIVE_WEBHOOK_SECRET;
  if (!secret) return c.json(errorBody("not_configured", "NAIVE_WEBHOOK_SECRET is not set"), 503);
  const raw = await c.req.text();
  const verified = await verifyNaive({
    secret,
    signature: c.req.header("vetta-signature"),
    timestamp: c.req.header("vetta-timestamp"),
    body: raw,
    now: nowSeconds(),
  });
  if (!verified.ok) return c.json(errorBody("invalid_signature", verified.reason), 401);
  const delivery = parseBody(c, raw, NaiveDelivery);
  if (delivery instanceof Response) return delivery;

  const sql = sqlFor(c.env);
  if (!(await claimWebhookEvent(sql, "naive", delivery.id))) return c.json({ ok: true, duplicate: true });

  const sessionId = delivery.data?.session_id;
  if (delivery.type === "session.idle" && sessionId) {
    c.executionCtx.waitUntil(
      handleSessionIdle(sql, c.env, { sessionId, stopReason: delivery.data?.stop_reason }).catch((err) =>
        console.error(`naive idle ${sessionId}:`, err instanceof Error ? err.message : err),
      ),
    );
  } else {
    await sql`insert into events (lead_id, kind, data)
              values ((select lead_id from naive_sessions where id = ${sessionId ?? null}), 'naive_webhook',
                      ${JSON.stringify({ type: delivery.type, session_id: sessionId ?? null })}::jsonb)`;
  }
  return c.json({ ok: true });
});
