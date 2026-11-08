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
import { canSendEmail, type WorkspaceRole } from "../src/services/workspaces.ts";
import { shortCode } from "../src/ids.ts";
import { readFileSync } from "node:fs";
import { safeNext } from "../web/src/lib/safe-next.ts";

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
    const as = c.req.header("x-as") ?? "";
    c.set("principal", PRINCIPALS[as]!);
    c.set("role", (c.req.header("x-role") as WorkspaceRole | undefined) ?? (as === "api_key" ? "admin" : "owner"));
    await next();
  });
  guardHumanRoutes(a);
  // Stub routes echo the body the route itself reads, so a guard that consumed it would show.
  a.all("*", async (c) => c.json({ ok: true, body: c.req.method === "GET" ? null : await c.req.text() }));
  return a;
}

async function call(as: string, method: string, path: string, body?: unknown, role?: WorkspaceRole) {
  const headers = { "x-as": as, "Content-Type": "application/json", ...(role ? { "x-role": role } : {}) };
  const res = await app().request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, json: (await res.json()) as { ok?: boolean; body?: string; error?: { code: string } } };
}

const REFUSED_FOR_KEYS: [string, string, unknown?][] = [
  ["PUT", "/settings/pause", { paused: false }],
  ["PATCH", "/workflow-definitions/wf_1", { cap_usd: 10_000 }],
  ["PATCH", "/workflow-definitions/wf_1", { spend: { cap_usd: 10_000, period: "week" } }],
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
  ["GET", "/team/members"],
  ["GET", "/team/invites"],
  ["POST", "/team/invites", { email: "a@b.co" }],
  ["POST", "/team/invites/inv_1/resend", {}],
  ["DELETE", "/team/invites/inv_1"],
  ["PATCH", "/team/members/user_2", { role: "owner" }],
  ["DELETE", "/team/members/user_2"],
  ["POST", "/team/leave", {}],
  ["POST", "/workspaces", { name: "New" }],
  ["PATCH", "/workspaces/current", { name: "New" }],
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

describe("consent and the do-not-contact list are for owners and admins", () => {
  const ADMIN_ONLY: [string, string, unknown?][] = [
    ["POST", "/leads", { email: "a@b.co", consent: { text: "trust me" } }],
    ["PATCH", "/leads/lead_1", { consent: { text: "trust me" } }],
    ["PATCH", "/leads/lead_1", { consent: null }],
    ["DELETE", "/suppressions/a%40b.co"],
  ];

  test("a member gets 403 forbidden_role", async () => {
    for (const [method, path, body] of ADMIN_ONLY) {
      const res = await call("clerk", method, path, body, "member");
      expect({ method, path, status: res.status, code: res.json.error?.code }).toEqual({ method, path, status: 403, code: "forbidden_role" });
    }
  });

  test("an admin and an owner pass, and the route still reads the body", async () => {
    for (const role of ["admin", "owner"] as const) {
      for (const [method, path, body] of ADMIN_ONLY) {
        const res = await call("clerk", method, path, body, role);
        expect({ role, method, path, status: res.status }).toEqual({ role, method, path, status: 200 });
        if (body !== undefined) expect(res.json.body).toBe(JSON.stringify(body));
      }
    }
  });

  test("a member still adds leads, edits them and adds to the do-not-contact list", async () => {
    const open: [string, string, unknown?][] = [
      ["POST", "/leads", { email: "a@b.co", name: "No consent field" }],
      ["PATCH", "/leads/lead_1", { title: "CTO" }],
      ["POST", "/suppressions", { email: "a@b.co" }],
      ["GET", "/suppressions"],
    ];
    for (const [method, path, body] of open) {
      const res = await call("clerk", method, path, body, "member");
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 200 });
    }
  });
});

describe("the kill switch and spend caps", () => {
  test("anyone may pause; only an owner or admin may resume", async () => {
    for (const as of ["api_key", "clerk", "owner_token"]) expect((await call(as, "PUT", "/settings/pause", { paused: true }, as === "clerk" ? "member" : undefined)).status).toBe(200);
    expect((await call("clerk", "PUT", "/settings/pause", { paused: false }, "member")).json.error?.code).toBe("forbidden_role");
    for (const role of ["admin", "owner"] as const) expect((await call("clerk", "PUT", "/settings/pause", { paused: false }, role)).status).toBe(200);
  });

  test("a member can run and toggle a workflow but not change its spend cap", async () => {
    expect((await call("clerk", "PATCH", "/workflow-definitions/wf_1", { enabled: false }, "member")).status).toBe(200);
    expect((await call("api_key", "PATCH", "/workflow-definitions/wf_1", { enabled: false })).status).toBe(200);
    expect((await call("clerk", "PATCH", "/workflow-definitions/wf_1", { cap_usd: 50 }, "member")).json.error?.code).toBe("forbidden_role");
    expect((await call("clerk", "PATCH", "/workflow-definitions/wf_1", { cap_usd: 50 }, "admin")).status).toBe(200);
  });

  test("the route still reads the body after these guards", async () => {
    const res = await call("clerk", "PATCH", "/workflow-definitions/wf_1", { cap_usd: 50 }, "owner");
    expect(res.json.body).toBe(JSON.stringify({ cap_usd: 50 }));
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

describe("redirect_url after sign-in", () => {
  test("only same-origin paths survive, however a browser would read them", () => {
    for (const ok of ["/app", "/app/leads?x=1", "/invite/inv_abc", "/"]) expect(safeNext(ok)).toBe(ok);
    for (const bad of ["//evil.test", "/\\evil.test", "/\t/evil.test", "/\n/evil.test", "/\r//evil.test", "https://evil.test", "javascript:alert(1)", "evil.test", "", null, undefined]) {
      expect({ bad, next: safeNext(bad) }).toEqual({ bad, next: null });
    }
  });

  test("a signed-in visitor's redirect goes through it too", () => {
    expect(readFileSync("web/src/auth.tsx", "utf8")).toContain("const target = safeNext(next) ?? fallback;");
  });
});

describe("approval codes", () => {
  test("6 characters from the readable alphabet, so one workspace can't use up the shared namespace", () => {
    for (let i = 0; i < 50; i++) expect(shortCode()).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
  });
});
