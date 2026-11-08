// Routes only a person may call (src/api/guards.ts), and the send gate for workspaces other than the owner's
// (canSendEmail in src/services/workspaces.ts). No database: the guards run on a stub router with the real
// route patterns, and the send gate is checked before approveAndSend touches the database.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { api } from "../src/api/index.ts";
import { guardHumanRoutes } from "../src/api/guards.ts";
import type { Env } from "../src/env.ts";
import type { AppEnv, Principal } from "../src/lib/context.ts";
import { ApiError } from "../src/lib/errors.ts";
import { approveAndSend } from "../src/services/send.ts";
import { canSendEmail } from "../src/services/workspaces.ts";

const PRINCIPALS: Record<string, Principal> = {
  api_key: { kind: "api_key", keyId: "key_1", name: "agent", workspaceId: "ws_a" },
  clerk: { kind: "clerk", userId: "user_1", sessionId: "sess_1" },
  owner_token: { kind: "owner_token" },
};

// The /api router's shape: auth sets the principal, then the guards, then the routes (stubs here).
function app() {
  const a = new Hono<AppEnv>();
  a.onError((err, c) => (err instanceof ApiError ? c.json({ error: { code: err.code } }, err.status) : c.json({ error: String(err) }, 500)));
  a.use("*", async (c, next) => {
    c.set("principal", PRINCIPALS[c.req.header("x-as") ?? ""]!);
    await next();
  });
  guardHumanRoutes(a);
  // Stub routes echo the body the route itself reads, so a guard that consumed it would show.
  a.all("*", async (c) => c.json({ ok: true, body: c.req.method === "GET" ? null : await c.req.text() }));
  return a;
}

async function call(as: string, method: string, path: string, body?: unknown) {
  const res = await app().request(path, { method, headers: { "x-as": as, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, json: (await res.json()) as { ok?: boolean; body?: string; error?: { code: string } } };
}

const REFUSED_FOR_KEYS: [string, string, unknown?][] = [
  ["POST", "/approvals/ABCD/approve"],
  ["POST", "/approvals/ABCD/reject", {}],
  ["POST", "/approvals/ABCD/edit", { body: "new text" }],
  ["POST", "/approvals/ABCD/answer", { decision: "allow" }],
  ["POST", "/keys", { name: "another key" }],
  ["DELETE", "/keys/key_2"],
  ["POST", "/leads", { email: "a@b.co", consent: { text: "trust me" } }],
  ["PATCH", "/leads/lead_1", { consent: { text: "trust me" } }],
  ["PATCH", "/leads/lead_1", { consent: null }],
  ["DELETE", "/suppressions/a%40b.co"],
  ["POST", "/billing/checkout", { pack: "starter" }],
  ["POST", "/billing/portal"],
];

const OPEN_TO_KEYS: [string, string, unknown?][] = [
  ["GET", "/approvals"],
  ["GET", "/approvals/ABCD"],
  ["GET", "/keys"],
  ["POST", "/leads", { email: "a@b.co", name: "No consent field" }],
  ["PATCH", "/leads/lead_1", { title: "CTO" }],
  ["POST", "/leads/lead_1/drafts", { subject: "Hi", body: "Draft only" }],
  ["POST", "/leads/import", { csv: "email\na@b.co\n" }],
  ["POST", "/leads/find", { count: 5 }],
  ["POST", "/suppressions", { email: "a@b.co" }],
  ["GET", "/billing"],
  ["PUT", "/company-summary", { body: "# Acme" }],
];

describe("human-only routes (src/api/guards.ts)", () => {
  test("an API key gets 403 human_required on decisions, keys, consent, unsuppressing and billing", async () => {
    for (const [method, path, body] of REFUSED_FOR_KEYS) {
      const res = await call("api_key", method, path, body);
      expect({ method, path, status: res.status, code: res.json.error?.code }).toEqual({ method, path, status: 403, code: "human_required" });
    }
  });

  test("an API key keeps everything else, and the route still reads the body", async () => {
    for (const [method, path, body] of OPEN_TO_KEYS) {
      const res = await call("api_key", method, path, body);
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 200 });
      if (body !== undefined) expect(res.json.body).toBe(JSON.stringify(body));
    }
  });

  test("a signed-in person and MCP_TOKEN pass every guard", async () => {
    for (const as of ["clerk", "owner_token"]) {
      for (const [method, path, body] of REFUSED_FOR_KEYS) {
        const res = await call(as, method, path, body);
        expect({ as, method, path, status: res.status }).toEqual({ as, method, path, status: 200 });
        if (body !== undefined) expect(res.json.body).toBe(JSON.stringify(body));
      }
    }
  });

  test("malformed JSON from an API key is left to the route (400 there), not guessed", async () => {
    const res = await app().request("/leads/lead_1", { method: "PATCH", headers: { "x-as": "api_key" }, body: "{not json" });
    expect(res.status).toBe(200);
  });

  test("the /api router registers the guards before its routes", () => {
    const paths = api.routes.map((r) => `${r.method} ${r.path}`);
    for (const want of ["POST /approvals/*", "DELETE /keys/*", "POST /keys", "PATCH /leads/:id", "POST /leads", "DELETE /suppressions/*", "POST /billing/*"]) {
      expect(paths).toContain(want);
    }
    const firstGuard = paths.indexOf("POST /approvals/*");
    const firstRoute = paths.findIndex((p) => p.startsWith("POST /approvals/:code"));
    expect(firstGuard).toBeGreaterThan(-1);
    expect(firstGuard).toBeLessThan(firstRoute);
  });
});

describe("sending from the shared inbox (canSendEmail)", () => {
  const env = (over: Partial<Env> = {}): Env => ({ PUBLIC_URL: "https://example.test", AGENTMAIL_API_KEY: "am", AGENTMAIL_INBOX_ID: "it@agentmail.to", ...over });

  test("the owner workspace, plus SEND_WORKSPACE_IDS", () => {
    expect(canSendEmail(env(), "ws_owner")).toBe(true);
    expect(canSendEmail(env(), "ws_signup")).toBe(false);
    expect(canSendEmail(env({ SEND_WORKSPACE_IDS: " ws_partner , ws_signup " }), "ws_signup")).toBe(true);
    expect(canSendEmail(env({ SEND_WORKSPACE_IDS: "ws_partner" }), "ws_signup")).toBe(false);
  });

  test("approveAndSend refuses another workspace before reading or consuming anything", async () => {
    let touched = false;
    const sql = (() => {
      touched = true;
      throw new Error("database touched");
    }) as never;
    const refused = await approveAndSend({ sql, ws: "ws_signup", env: env(), actor: "test" }, "ABCD").catch((e) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect({ status: refused.status, code: refused.code }).toEqual({ status: 403, code: "sending_not_enabled" });
    expect(touched).toBe(false);
    // Listed: it gets past the gate (and here hits the stub database).
    const listed = await approveAndSend({ sql, ws: "ws_signup", env: env({ SEND_WORKSPACE_IDS: "ws_signup" }), actor: "test" }, "ABCD").catch((e) => e);
    expect((listed as Error).message).toBe("database touched");
  });
});
