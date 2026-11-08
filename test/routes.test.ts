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

describe("web app routes without a database", () => {
  const auth = { Authorization: "Bearer owner-token" };
  const json = (body: unknown) => ({ method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const code = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

  test("every new endpoint needs auth", async () => {
    for (const path of ["/api/me", "/api/summary", "/api/status", "/api/profile", "/api/workflows", "/api/replies", "/api/experiments", "/api/keys"]) {
      expect((await call(path)).status).toBe(401);
    }
  });

  test("/api/me with MCP_TOKEN", async () => {
    const res = await call("/api/me", { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { id: "owner", name: "Owner (MCP_TOKEN)" }, auth: "token" });
  });

  test("/api/status works with no keys: get_status data plus inbox_address and the MCP URL", async () => {
    const res = await call("/api/status", { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ inbox_address: null, naive_agent_configured: false, mcp_url: "https://example.test/mcp" });
    expect(Object.keys(body.providers as object)).toContain("agentmail");
    const configured = await call("/api/status", { headers: auth }, env({ AGENTMAIL_API_KEY: "am", AGENTMAIL_INBOX_ID: "crusonia@agentmail.to" }));
    expect(((await configured.json()) as { inbox_address: string }).inbox_address).toBe("crusonia@agentmail.to");
  });

  test("Naive-backed endpoints answer 503 not_configured naming NAIVE_AGENT_ID", async () => {
    const naiveKeyOnly = env({ NAIVE_API_KEY: "nv" });
    for (const [path, init] of [
      ["/api/onboarding/propose", json({ url: "acme.com" })],
      ["/api/onboarding/propose/ses_123", { headers: auth }],
      ["/api/leads/find", json({ count: 10 })],
    ] as const) {
      const res = await call(path, init, naiveKeyOnly);
      expect(res.status).toBe(503);
      const error = await code(res);
      expect(error.code).toBe("not_configured");
      expect(error.message).toContain("NAIVE_AGENT_ID is not set");
    }
    const bare = await call("/api/leads/find", json({}));
    expect((await code(bare)).message).toContain("NAIVE_API_KEY and NAIVE_AGENT_ID are not set");
  });

  test("request bodies are validated first", async () => {
    expect((await call("/api/onboarding/propose", json({}))).status).toBe(400);
    expect((await call("/api/leads/find", json({ count: 51 }))).status).toBe(400);
    expect((await call("/api/keys", json({ name: "" }))).status).toBe(400);
    expect((await call("/api/experiments", json({ hypothesis: "no name" }))).status).toBe(400);
    expect((await call("/api/onboarding/read-website", json({}))).status).toBe(400);
    expect((await call("/api/replies?limit=0", { headers: auth })).status).toBe(400);
    const patch = await call("/api/experiments/exp_1", { ...json({ status: "running" }), method: "PATCH" });
    expect(patch.status).toBe(400);
    const profile = await call("/api/profile", { ...json({ website: "not a url at all" }), method: "PUT" });
    expect(profile.status).toBe(400);
  });

  test("database-backed endpoints are a clean 503 without DATABASE_URL", async () => {
    for (const path of ["/api/summary", "/api/profile", "/api/workflows", "/api/workflows/runs/ses_1", "/api/replies", "/api/experiments", "/api/keys"]) {
      const res = await call(path, { headers: auth });
      expect(res.status).toBe(503);
      expect((await code(res)).code).toBe("not_configured");
    }
  });
});

describe("with a static-assets binding (the SPA)", () => {
  const assets = { fetch: async (req: Request) => new Response(`spa:${new URL(req.url).pathname}`, { status: 200 }) } as unknown as Fetcher;
  const withAssets = env({ ASSETS: assets });

  test("app routes and / are served by ASSETS", async () => {
    expect(await (await call("/", {}, withAssets)).text()).toBe("spa:/");
    // A client-side route gets the SPA shell (index.html, which ASSETS serves at "/").
    const route = await call("/app/leads/lead_1", {}, withAssets);
    expect(route.status).toBe(200);
    expect(await route.text()).toBe("spa:/");
  });

  test("a missing build or media file is a real 404, not the app's HTML", async () => {
    for (const path of ["/assets/index-nope.js", "/assets/x.css", "/media/nope.mp4"]) {
      const res = await call(path, {}, withAssets);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toStartWith("text/plain");
    }
  });

  test("only the production host (PUBLIC_URL) is indexable", async () => {
    const prod = env({ ASSETS: assets, PUBLIC_URL: "https://example.test" });
    expect((await call("/app", {}, prod)).headers.get("x-robots-tag")).toBeNull();
    const preview = env({ ASSETS: assets, PUBLIC_URL: "https://crusonia.example.dev" });
    expect((await call("/app", {}, preview)).headers.get("x-robots-tag")).toBe("noindex");
  });

  test("other methods on an app route are a JSON 404", async () => {
    expect((await call("/app/leads", { method: "POST" }, withAssets)).status).toBe(404);
  });

  test("/health, /api/*, /mcp and /webhooks/* stay on the Worker", async () => {
    expect(await (await call("/health", {}, withAssets)).json()).toMatchObject({ name: "crusonia", ok: true });
    const unknownApi = await call("/api/nope", { headers: { Authorization: "Bearer owner-token" } }, withAssets);
    expect(unknownApi.status).toBe(404);
    expect(((await unknownApi.json()) as { error: { code: string } }).error.code).toBe("not_found");
    expect((await call("/api/me", {}, withAssets)).status).toBe(401);
    expect((await call("/mcp", { method: "POST", body: "{}" }, withAssets)).status).toBe(401);
    expect((await call("/webhooks/nope", { method: "POST" }, withAssets)).status).toBe(404);
    expect((await call("/webhooks/agentmail", { method: "POST", body: "{}" }, withAssets)).status).toBe(503);
  });
});
