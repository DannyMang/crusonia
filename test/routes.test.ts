// The Hono app in-process, without a database or provider keys: auth, clean config errors, webhook
// signature checks, and the error shape.
import { describe, expect, test } from "bun:test";
import worker from "../src/index.ts";
import type { Env } from "../src/env.ts";
import { signNaive, signSvix } from "../src/lib/signatures.ts";

const env = (over: Partial<Env> = {}): Env => ({ PUBLIC_URL: "https://example.test", MCP_TOKEN: "owner-token", ...over });
const call = (path: string, init: RequestInit = {}, e: Env = env()) =>
  worker.fetch(new Request(`https://example.test${path}`, init), e, {} as ExecutionContext);

describe("routes without a database", () => {
  test("/health works with no keys", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "crusonia", ok: true, database_url_set: false });
  });

  test("/api/* needs auth: 401 with a JSON error", async () => {
    const res = await call("/api/leads");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
  });

  test("an authenticated DB route without DATABASE_URL is a clean 503", async () => {
    const res = await call("/api/leads", { headers: { Authorization: "Bearer owner-token" } });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("not_configured");
    expect(body.error.message).toStartWith("DATABASE_URL is not set");
  });

  test("validation errors are 400 with details, before touching the database", async () => {
    const res = await call("/api/leads?limit=1000", { headers: { Authorization: "Bearer owner-token" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
  });

  test("unknown routes are 404 JSON", async () => {
    const res = await call("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "No route for GET /nope" } });
  });

  test("AgentMail webhook: 503 without a secret, 401 on a bad signature, checked before the database", async () => {
    expect((await call("/webhooks/agentmail", { method: "POST", body: "{}" })).status).toBe(503);
    const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ event_id: "evt_1", event_type: "message.delivered" });
    const bad = await call(
      "/webhooks/agentmail",
      { method: "POST", body, headers: { "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": await signSvix(secret, "msg_1", ts, "{}") } },
      env({ AGENTMAIL_WEBHOOK_SECRET: secret }),
    );
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_signature");
    // A valid signature gets past verification and then needs the database.
    const good = await call(
      "/webhooks/agentmail",
      { method: "POST", body, headers: { "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": await signSvix(secret, "msg_1", ts, body) } },
      env({ AGENTMAIL_WEBHOOK_SECRET: secret }),
    );
    expect(good.status).toBe(503);
  });

  test("Naive webhook: stale timestamps are rejected even with a correct signature", async () => {
    const secret = "whsec_naive";
    const ts = String(Math.floor(Date.now() / 1000) - 600);
    const body = JSON.stringify({ id: "evt_1", type: "session.idle", data: { session_id: "ses_1", stop_reason: "end_turn" } });
    const res = await call(
      "/webhooks/naive",
      { method: "POST", body, headers: { "Vetta-Signature": await signNaive(secret, ts, body), "Vetta-Timestamp": ts } },
      env({ NAIVE_WEBHOOK_SECRET: secret }),
    );
    expect(res.status).toBe(401);
  });
});
