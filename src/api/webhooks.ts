// Provider webhooks. Not behind /api auth: each request is authenticated by its signature over the raw
// body (checked before anything else, including the database), then deduped by the provider's event id.
// Each event maps back to one workspace through the row it is about: AgentMail through the draft or thread
// (src/services/inbound.ts), Naive through the session, Stripe through the customer (src/billing/webhook.ts).
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Env } from "../env.ts";
import { sqlFor } from "../lib/context.ts";
import { errorBody } from "../lib/errors.ts";
import { handleStripeEvent, StripeEventSchema } from "../billing/webhook.ts";
import { BRIDGE_SIGNATURE_HEADER, BRIDGE_TIMESTAMP_HEADER, verifyBridge, verifyNaive, verifyStripe, verifySvix } from "../lib/signatures.ts";
import {
  BridgePollSchema,
  handleBridgePoll,
  handlePhotonEvent,
  imessageConfig,
  normalizeHandle,
  PHOTON_POLL_PATH,
  PHOTON_WEBHOOK_PATH,
  PhotonEventSchema,
} from "../services/imessage.ts";
import { AgentMailEventSchema, handleAgentMailEvent } from "../services/inbound.ts";
import { claimWebhookEvent, releaseWebhookEvent } from "../services/webhook-events.ts";
import { handleSessionIdle } from "../services/workflows.ts";
import { OWNER_WORKSPACE_ID } from "../services/workspaces.ts";

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
    // The session's workspace (deliveries for sessions we don't know are audited in the owner workspace).
    await sql`insert into events (workspace_id, lead_id, kind, data)
              values (coalesce((select workspace_id from naive_sessions where id = ${sessionId ?? null}), ${OWNER_WORKSPACE_ID}),
                      (select lead_id from naive_sessions where id = ${sessionId ?? null}), 'naive_webhook',
                      ${JSON.stringify({ type: delivery.type, session_id: sessionId ?? null })}::jsonb)`;
  }
  return c.json({ ok: true });
});

// Stripe (Crusonia's own account): checkout, invoices, subscriptions, refunds -> billing accounts and the credit
// ledger (src/billing/webhook.ts). The signature is always verified (no secret, no processing); events are deduped
// by id, and a failed handler releases the claim and answers 5xx so Stripe retries.
webhooks.post("/stripe", async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return c.json(errorBody("not_configured", "STRIPE_WEBHOOK_SECRET is not set"), 503);
  const raw = await c.req.text();
  const verified = await verifyStripe({ secret, header: c.req.header("stripe-signature"), body: raw, now: nowSeconds() });
  if (!verified.ok) return c.json(errorBody("invalid_signature", verified.reason), 401);
  const event = parseBody(c, raw, StripeEventSchema);
  if (event instanceof Response) return event;

  const sql = sqlFor(c.env);
  if (!(await claimWebhookEvent(sql, "stripe", event.id))) return c.json({ ok: true, duplicate: true });
  try {
    const result = await handleStripeEvent(sql, c.env, event);
    return c.json({ ok: true, type: event.type, ...result });
  } catch (err) {
    await releaseWebhookEvent(sql, event.id).catch(() => {});
    throw err;
  }
});

// iMessage bridge (bridge/, Photon Spectrum). Both routes are signed with BRIDGE_SECRET over
// `${timestamp}.${path}.${body}` (5 minute window). See src/services/imessage.ts.
async function verifiedBridgeBody(c: Context<{ Bindings: Env }>, path: string): Promise<string | Response> {
  const secret = c.env.BRIDGE_SECRET;
  if (!secret) return c.json(errorBody("not_configured", "BRIDGE_SECRET is not set"), 503);
  const raw = await c.req.text();
  const verified = await verifyBridge({
    secret,
    path,
    signature: c.req.header(BRIDGE_SIGNATURE_HEADER),
    timestamp: c.req.header(BRIDGE_TIMESTAMP_HEADER),
    body: raw,
    now: nowSeconds(),
  });
  if (!verified.ok) return c.json(errorBody("invalid_signature", verified.reason), 401);
  return raw;
}

// The bridge's poll (every ~5 s): delivery acks + its status in, notices to text the owner out.
webhooks.post("/photon/poll", async (c) => {
  const raw = await verifiedBridgeBody(c, PHOTON_POLL_PATH);
  if (raw instanceof Response) return raw;
  const poll = parseBody(c, raw, BridgePollSchema);
  if (poll instanceof Response) return poll;
  return c.json(await handleBridgePoll(() => sqlFor(c.env), c.env, poll));
});

// One owner command from iMessage, already parsed by the bridge. The reply text goes back to the owner.
webhooks.post("/photon", async (c) => {
  const raw = await verifiedBridgeBody(c, PHOTON_WEBHOOK_PATH);
  if (raw instanceof Response) return raw;
  const event = parseBody(c, raw, PhotonEventSchema);
  if (event instanceof Response) return event;
  if (!imessageConfig(c.env).enabled) {
    return c.json({ ok: false, reply: "iMessage approvals are switched off in Crusonia (IMESSAGE_ENABLED). Use the app for now." });
  }
  // Defense in depth: the bridge already drops every other sender.
  if (c.env.OWNER_PHONE && normalizeHandle(event.from) !== normalizeHandle(c.env.OWNER_PHONE)) {
    console.warn("photon: command from a handle that is not OWNER_PHONE refused");
    return c.json(errorBody("forbidden_sender", "Only the owner can send commands"), 403);
  }
  return c.json(await handlePhotonEvent(sqlFor(c.env), c.env, event));
});
