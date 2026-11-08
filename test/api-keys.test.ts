// API keys: format and hashing, and that /api and /mcp accept them next to MCP_TOKEN. The database lookup
// is replaced by an in-memory one, so no database or network is needed.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { describePrincipal } from "../src/api/dashboard.ts";
import { authenticate } from "../src/api/auth.ts";
import { bearerAuth, resolveBearer, type McpEnv } from "../src/auth.ts";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";
import { actorOf } from "../src/lib/context.ts";
import { ApiError } from "../src/lib/errors.ts";
import { API_KEY_PREFIX, generateApiKey, hashApiKey, isApiKey, type ApiKeyLookup } from "../src/services/api-keys.ts";

const env = (over: Partial<Env> = {}): Env => ({ PUBLIC_URL: "https://example.test", MCP_TOKEN: "owner-token", ...over });

/** In-memory key store keyed by hash, like the api_keys table. Records every lookup. Key i belongs to ws_<i>. */
async function store(...active: string[]) {
  const byHash = new Map<string, { id: string; name: string; workspace_id: string; kind: "user" | "agent" }>();
  for (const [i, key] of active.entries()) {
    byHash.set(await hashApiKey(key), { id: `key_${i}`, name: `agent ${i}`, workspace_id: `ws_${i}`, kind: "user" });
  }
  const calls: string[] = [];
  const lookup: ApiKeyLookup = async (token) => {
    calls.push(token);
    return byHash.get(await hashApiKey(token)) ?? null;
  };
  return { lookup, calls, revoke: async (key: string) => byHash.delete(await hashApiKey(key)) };
}

async function failure(p: Promise<unknown>) {
  const err = await p.then(() => undefined, (e) => e);
  expect(err).toBeInstanceOf(ApiError);
  return `${(err as ApiError).status} ${(err as ApiError).code}`;
}

describe("key format and hashing", () => {
  test("crs_live_ + 32 random bytes as hex; prefix is the first 8 hex chars; hash is SHA-256 hex", async () => {
    const a = await generateApiKey();
    const b = await generateApiKey();
    expect(a.key).toMatch(/^crs_live_[0-9a-f]{64}$/);
    expect(a.key).not.toBe(b.key);
    expect(a.prefix).toBe(a.key.slice(0, API_KEY_PREFIX.length + 8));
    expect(a.hash).toBe(createHash("sha256").update(a.key).digest("hex"));
    expect(a.hash).not.toContain(a.key.slice(API_KEY_PREFIX.length));
    expect(await hashApiKey(a.key)).toBe(a.hash);
  });

  test("isApiKey only accepts the exact format", async () => {
    const { key } = await generateApiKey();
    expect(isApiKey(key)).toBe(true);
    expect(isApiKey(key.toUpperCase())).toBe(false);
    expect(isApiKey(key.slice(0, -1))).toBe(false);
    expect(isApiKey(`${key}0`)).toBe(false);
    expect(isApiKey(key.replace("crs_live_", "crs_test_"))).toBe(false);
    expect(isApiKey("owner-token")).toBe(false);
  });
});

describe("/api auth with API keys", () => {
  test("an active key authenticates as api_key; the audit actor names the key", async () => {
    const { key } = await generateApiKey();
    const s = await store(key);
    const principal = await authenticate(env(), `Bearer ${key}`, { lookupApiKey: s.lookup });
    expect(principal).toEqual({ kind: "api_key", keyId: "key_0", name: "agent 0", workspaceId: "ws_0", agent: false });
    expect(actorOf(principal)).toBe("api_key:key_0");
  });

  test("unknown and revoked keys are 401 invalid_token", async () => {
    const [{ key }, { key: other }] = [await generateApiKey(), await generateApiKey()];
    const s = await store(key);
    expect(await failure(authenticate(env(), `Bearer ${other}`, { lookupApiKey: s.lookup }))).toBe("401 invalid_token");
    await s.revoke(key);
    expect(await failure(authenticate(env(), `Bearer ${key}`, { lookupApiKey: s.lookup }))).toBe("401 invalid_token");
  });

  test("MCP_TOKEN still works and is checked before any lookup; non-key tokens never hit the key store", async () => {
    const s = await store();
    expect(await authenticate(env(), "Bearer owner-token", { lookupApiKey: s.lookup })).toEqual({ kind: "owner_token" });
    expect(await failure(authenticate(env(), "Bearer something-else", { lookupApiKey: s.lookup }))).toBe("401 invalid_token");
    expect(s.calls).toEqual([]);
  });

  test("keys work without MCP_TOKEN; without a database there is nothing to check them against", async () => {
    const { key } = await generateApiKey();
    const s = await store(key);
    expect(await resolveBearer(env({ MCP_TOKEN: undefined }), key, s.lookup)).toEqual({
      agentRole: null,
      kind: "api_key",
      keyId: "key_0",
      name: "agent 0",
      workspaceId: "ws_0",
      agent: false,
    });
    expect(await resolveBearer(env(), "owner-token")).toEqual({ kind: "owner_token", workspaceId: "ws_owner" });
    expect(await resolveBearer(env({ MCP_TOKEN: undefined }), key)).toBeNull(); // no DATABASE_URL, no lookup
  });

  test("/api/me describes token principals without any network call", async () => {
    expect(await describePrincipal(env(), { kind: "owner_token" })).toEqual({ user: { id: "owner", name: "Owner (MCP_TOKEN)" }, auth: "token" });
    expect(await describePrincipal(env(), { kind: "api_key", keyId: "key_1", name: "Claude Code", workspaceId: "ws_1" })).toEqual({
      user: { id: "api_key:key_1", name: "Claude Code" },
      auth: "token",
      key: { id: "key_1", name: "Claude Code" },
    });
    // Clerk without CLERK_SECRET_KEY: only what the token carried.
    expect(await describePrincipal(env(), { kind: "clerk", userId: "user_1", sessionId: null, email: "o@example.com" })).toEqual({
      user: { id: "user_1", email: "o@example.com" },
      auth: "clerk",
    });
  });
});

describe("/mcp bearer middleware", () => {
  async function app(lookup?: ApiKeyLookup) {
    const a = new Hono<McpEnv>();
    a.use("*", bearerAuth(lookup));
    a.post("/", (c) => c.json({ ok: true, workspace: c.get("workspace").id }));
    return a;
  }
  const post = async (a: Hono<McpEnv>, token: string | null, e: Env = env(), path = "/") =>
    a.request(path, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {} }, e);

  test("accepts MCP_TOKEN and active keys, rejects unknown and revoked keys with WWW-Authenticate", async () => {
    const { key } = await generateApiKey();
    const { key: unknown } = await generateApiKey();
    const s = await store(key);
    const a = await app(s.lookup);
    expect((await post(a, "owner-token")).status).toBe(200);
    expect((await post(a, key)).status).toBe(200);
    const bad = await post(a, unknown);
    expect(bad.status).toBe(401);
    expect(bad.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
    await s.revoke(key);
    expect((await post(a, key)).status).toBe(401);
    expect((await post(a, null)).status).toBe(401);
  });

  test("the token decides the workspace; a ?ws= that names another workspace is 403", async () => {
    const [{ key: a0 }, { key: a1 }] = [await generateApiKey(), await generateApiKey()];
    const a = await app((await store(a0, a1)).lookup);
    expect(await (await post(a, a0)).json()).toEqual({ ok: true, workspace: "ws_0" });
    expect(await (await post(a, a1)).json()).toEqual({ ok: true, workspace: "ws_1" });
    expect(await (await post(a, "owner-token")).json()).toEqual({ ok: true, workspace: "ws_owner" });
    expect((await post(a, a0, env(), "/?ws=ws_0")).status).toBe(200);
    expect((await post(a, a0, env(), "/?ws=ws_1")).status).toBe(403);
    expect((await post(a, a1, env(), "/?ws=ws_owner")).status).toBe(403);
    expect((await post(a, "owner-token", env(), "/?ws=ws_0")).status).toBe(403);
  });

  test("keys alone (no MCP_TOKEN) are enough to enable /mcp", async () => {
    const { key } = await generateApiKey();
    const a = await app((await store(key)).lookup);
    expect((await post(a, key, env({ MCP_TOKEN: undefined }))).status).toBe(200);
  });

  test("fails closed with 503 when neither MCP_TOKEN nor a database is configured", async () => {
    const res = await post(await app(), "anything", env({ MCP_TOKEN: undefined }));
    expect(res.status).toBe(503);
  });

  test("the real /mcp route: a key-shaped token without a database is a clean 401, not a 500", async () => {
    const { key } = await generateApiKey();
    const res = await worker.fetch(
      new Request("https://example.test/mcp", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: "{}" }),
      env(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });
});
