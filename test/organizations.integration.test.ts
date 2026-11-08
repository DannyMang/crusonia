// Organizations against a real Postgres (never production), with Clerk's and AgentMail's APIs faked at fetch. Skipped
// unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=<dev branch url> bun test test/organizations.integration.test.ts
// Covers: a user in two workspaces and isolation between them, refusing a spoofed X-Crusonia-Workspace, invite tokens
// (hashing, wrong email, reuse, expiry, revoked, resend), closed sign-ups, role checks, the last owner, what removal
// takes away, rate limits, one free sample per person, and agents staying bound to their key's workspace.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { getBalance } from "../src/billing/accounts.ts";
import { workspaceForOwnerId } from "../src/billing/webhook.ts";
import { getSql, type Sql } from "../src/db.ts";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";
import { limitsConfig } from "../src/services/limits.ts";
import { addSuppression } from "../src/services/settings.ts";
import { createTestWorkspace, deleteTestWorkspaces, testKey } from "./helpers/workspace.ts";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const run = crypto.randomUUID().slice(0, 8);
const ctx = {} as ExecutionContext;
const INBOX = "system@agentmail.test";
const made: string[] = [];
let sql: Sql;

// ---------- Clerk session tokens signed with a key generated here ----------

let keys: CryptoKeyPair;
let pem = "";
const b64url = (d: Uint8Array | string) => Buffer.from(typeof d === "string" ? new TextEncoder().encode(d) : d).toString("base64url");
async function clerkToken(sub: string) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "ins_test" }));
  const body = b64url(JSON.stringify({ sub, sid: "sess_it", iss: "https://clerk.crusonia.dev", iat: now - 10, nbf: now - 10, exp: now + 300 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const env = (over: Partial<Env> = {}): Env => ({
  PUBLIC_URL: "https://app.example.test/",
  DATABASE_URL: url,
  MCP_TOKEN: `it-owner-${run}`,
  CLERK_JWT_KEY: pem,
  CLERK_SECRET_KEY: "sk_test_fake",
  AGENTMAIL_API_KEY: "am_fake",
  AGENTMAIL_INBOX_ID: INBOX,
  // This suite sends more invites than the daily limits allow; each limit has its own test below.
  INVITES_PER_INSTANCE_PER_DAY: "100000",
  INVITES_PER_WORKSPACE_PER_DAY: "100000",
  INVITES_PER_USER_PER_DAY: "100000",
  ...over,
});

// ---------- faked providers ----------

type FakeUser = { name?: string; verified?: string[]; unverified?: string[] };
const clerkUsers = new Map<string, FakeUser>();
let clerkDown = false;
let mailFails = false;
const sent: { inbox: string; to: string; subject: string; text: string; html: string; labels: string[] }[] = [];

const rawUser = (id: string, u: FakeUser) => {
  const emails = [
    ...(u.verified ?? []).map((a, i) => ({ id: `v${i}`, email_address: a, verification: { status: "verified" } })),
    ...(u.unverified ?? []).map((a, i) => ({ id: `u${i}`, email_address: a, verification: { status: "unverified" } })),
  ];
  return { id, first_name: u.name ?? null, primary_email_address_id: emails[0]?.id ?? null, email_addresses: emails };
};

const realFetch = globalThis.fetch;
function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (target.hostname === "api.clerk.com") {
    if (clerkDown) return Promise.resolve(new Response("down", { status: 500 }));
    const one = /^\/v1\/users\/(.+)$/.exec(target.pathname);
    if (one) {
      const id = decodeURIComponent(one[1]!);
      const u = clerkUsers.get(id);
      return Promise.resolve(u ? Response.json(rawUser(id, u)) : new Response("{}", { status: 404 }));
    }
    const ids = target.searchParams.getAll("user_id");
    return Promise.resolve(Response.json(ids.flatMap((id) => (clerkUsers.has(id) ? [rawUser(id, clerkUsers.get(id)!)] : []))));
  }
  if (target.hostname === "api.agentmail.to") {
    if (mailFails) return Promise.resolve(new Response('{"message":"rejected"}', { status: 400 }));
    const inbox = decodeURIComponent(target.pathname.split("/")[3] ?? "");
    sent.push({ inbox, ...(JSON.parse(String(init?.body)) as Omit<(typeof sent)[number], "inbox">) });
    return Promise.resolve(Response.json({ message_id: `<m${sent.length}@test>`, thread_id: `t${sent.length}` }));
  }
  return realFetch(input as Request, init);
}

// ---------- helpers ----------

async function call(token: string | null, method: string, path: string, opts: { body?: unknown; ws?: string; env?: Env } = {}) {
  const res = await worker.fetch(
    new Request(`https://app.example.test${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
        ...(opts.ws === undefined ? {} : { "X-Crusonia-Workspace": opts.ws }),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }),
    opts.env ?? env(),
    ctx,
  );
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any, headers: res.headers };
}

const uid = (label: string) => `user_org_${run}_${label}`;
const mail = (label: string) => `${label}-${run}@it.example.com`;

/** A Clerk user, with a verified address unless told otherwise. */
function person(label: string, u: Partial<FakeUser> = {}) {
  const id = uid(label);
  clerkUsers.set(id, { name: label, verified: [mail(label)], ...u });
  return id;
}

async function workspace(label: string, ownerId?: string) {
  const ws = await createTestWorkspace(sql, `org_${label}_${run}`, ownerId ? { clerkUserId: ownerId } : {});
  made.push(ws);
  return ws;
}

async function join(ws: string, userId: string, role: "owner" | "admin" | "member") {
  await sql`insert into workspace_members (workspace_id, clerk_user_id, role) values (${ws}, ${userId}, ${role})`;
}

const lastToken = () => /\/invite\/(inv_[0-9a-f]{64})/.exec(sent.at(-1)!.text)![1]!;

async function invite(token: string, ws: string, email: string, role: "admin" | "member" = "member", e: Env = env()) {
  const r = await call(token, "POST", "/api/team/invites", { ws, body: { email, role }, env: e });
  expect(r.status).toBe(201);
  return { id: r.body.invite.id as string, token: lastToken() };
}

suite("organizations (database, faked Clerk and AgentMail)", () => {
  beforeAll(async () => {
    sql = getSql(url);
    const params = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
    keys = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
    const spki = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64");
    pem = `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----`;
    globalThis.fetch = fakeFetch as typeof fetch;
  });

  afterEach(() => {
    clerkDown = false;
    mailFails = false;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (!sql) return;
    const created = await sql`select workspace_id from workspace_members where clerk_user_id like ${`user_org_${run}_%`}`;
    await deleteTestWorkspaces(sql, [...new Set([...made, ...created.map((r) => r.workspace_id as string)])]);
    await sql`delete from workspace_members where clerk_user_id like ${`user_org_${run}_%`}`;
  });

  // ---------- the schema ----------

  test("the one-workspace-per-user index is gone, and only known roles can be stored", async () => {
    const idx = (await sql`select indexname from pg_indexes where schemaname = 'public'`).map((r) => r.indexname as string);
    expect(idx).not.toContain("workspace_members_user_uq");
    expect(idx).toContain("workspace_invites_open_uq");
    const ws = await workspace("schema");
    await expect(join(ws, uid("schema"), "superuser" as "owner")).rejects.toThrow();
  });

  // ---------- a user in two workspaces ----------

  describe("a user in two workspaces", () => {
    let A: string;
    let B: string;
    let token: string;
    let leadA: string;
    let leadB: string;

    beforeAll(async () => {
      const u = person("two");
      A = await workspace("two_a", u);
      B = await workspace("two_b");
      await join(B, u, "member");
      token = await clerkToken(u);
      const email = mail("shared-lead");
      leadA = (await call(token, "POST", "/api/leads", { ws: A, body: { email, name: "In A" } })).body.lead.id;
      leadB = (await call(token, "POST", "/api/leads", { ws: B, body: { email, name: "In B" } })).body.lead.id;
    });

    test("the header picks the workspace, and each one shows only its own rows", async () => {
      const inA = await call(token, "GET", "/api/leads?limit=200", { ws: A });
      const inB = await call(token, "GET", "/api/leads?limit=200", { ws: B });
      expect(inA.body.data.map((l: any) => l.id)).toEqual([leadA]);
      expect(inB.body.data.map((l: any) => l.id)).toEqual([leadB]);
      expect(inA.body.data[0].name).toBe("In A");
      expect(inB.body.data[0].name).toBe("In B");
      expect((await call(token, "GET", `/api/leads/${leadB}`, { ws: A })).status).toBe(404);
      expect((await call(token, "PATCH", `/api/leads/${leadA}`, { ws: B, body: { name: "x" } })).status).toBe(404);
      const made = await call(token, "POST", "/api/leads", { ws: B, body: { email: mail("only-b"), name: "Only B" } });
      expect(made.status).toBe(201);
      expect((await call(token, "GET", `/api/leads/${made.body.lead.id}`, { ws: A })).status).toBe(404);
    });

    test("/me and /workspaces say which one, with the role in each", async () => {
      expect((await call(token, "GET", "/api/me", { ws: A })).body.workspace).toMatchObject({ id: A, role: "owner", owner: false });
      expect((await call(token, "GET", "/api/me", { ws: B })).body.workspace).toMatchObject({ id: B, role: "member", owner: false });
      const list = await call(token, "GET", "/api/workspaces", { ws: B });
      expect(list.body.current).toBe(B);
      expect(list.body.data).toEqual([
        { id: A, name: expect.any(String), role: "owner", owner: false },
        { id: B, name: expect.any(String), role: "member", owner: false },
      ]);
    });

    test("without the header: the oldest membership; the instance owner: the owner workspace", async () => {
      expect((await call(token, "GET", "/api/me")).body.workspace.id).toBe(A);
      const e = env({ OWNER_CLERK_USER_ID: uid("two") });
      expect((await call(token, "GET", "/api/me", { env: e })).body.workspace).toMatchObject({ id: "ws_owner", role: "owner", owner: true });
      expect((await call(token, "GET", "/api/me", { env: e, ws: A })).body.workspace.id).toBe(A);
      await sql`delete from workspace_members where workspace_id = 'ws_owner' and clerk_user_id = ${uid("two")}`;
    });

    test("a role in one workspace means nothing in the other", async () => {
      expect((await call(token, "POST", "/api/keys", { ws: B, body: { name: "nope" } })).status).toBe(403);
      const key = await call(token, "POST", "/api/keys", { ws: A, body: { name: "in A" } });
      expect(key.status).toBe(201);
      expect((await call(token, "DELETE", `/api/keys/${key.body.api_key.id}`, { ws: B })).status).toBe(403);
    });

    test("a Stripe object from before workspaces maps to the workspace the user owns, not any they joined", async () => {
      expect(await workspaceForOwnerId(sql, uid("two"))).toBe(A);
    });
  });

  // ---------- a spoofed header ----------

  describe("a spoofed X-Crusonia-Workspace", () => {
    let A: string;
    let B: string;
    let tokenA: string;
    let keyA: string;

    beforeAll(async () => {
      const a = person("spoof_a");
      A = await workspace("spoof_a", a);
      B = await workspace("spoof_b", person("spoof_b"));
      tokenA = await clerkToken(a);
      keyA = await testKey(sql, A, "A key");
      await call(await clerkToken(uid("spoof_b")), "POST", "/api/leads", { ws: B, body: { email: mail("spoof-secret"), name: "Secret" } });
    });

    test("a workspace the user isn't in is refused, the same as one that doesn't exist", async () => {
      const real = await call(tokenA, "GET", "/api/leads", { ws: B });
      const fake = await call(tokenA, "GET", "/api/leads", { ws: `ws_nope_${run}` });
      expect(real).toMatchObject({ status: 403, body: { error: { code: "not_a_member" } } });
      expect(fake.status).toBe(403);
      expect(fake.body).toEqual(real.body);
      for (const [method, path, body] of [
        ["POST", "/api/leads", { email: mail("planted") }],
        ["POST", "/api/keys", { name: "mine now" }],
        ["POST", "/api/team/invites", { email: mail("planted") }],
        ["GET", "/api/billing", undefined],
        ["GET", "/api/team/members", undefined],
      ] as const) {
        expect((await call(tokenA, method, path, { ws: B, ...(body ? { body } : {}) })).status).toBe(403);
      }
      expect(sent.filter((m) => m.to === mail("planted"))).toEqual([]);
    });

    test("it doesn't get someone with no workspace one", async () => {
      const u = person("spoof_new");
      const r = await call(await clerkToken(u), "GET", "/api/me", { ws: B });
      expect(r).toMatchObject({ status: 403, body: { error: { code: "not_a_member" } } });
      expect((await sql`select 1 from workspace_members where clerk_user_id = ${u}`).length).toBe(0);
    });

    test("an API key and MCP_TOKEN are bound to theirs: another is refused, their own is fine", async () => {
      expect(await call(keyA, "GET", "/api/leads", { ws: B })).toMatchObject({ status: 403, body: { error: { code: "workspace_mismatch" } } });
      expect((await call(keyA, "GET", "/api/leads", { ws: A })).status).toBe(200);
      const owner = `it-owner-${run}`;
      expect((await call(owner, "GET", "/api/me", { ws: B })).status).toBe(403);
      expect((await call(owner, "GET", "/api/me", { ws: "ws_owner" })).status).toBe(200);
    });

    test("BLOCKED_USER_IDS stops the keys of a workspace whose owners are all blocked, and only those", async () => {
      const bad = uid("blocked_keys");
      const ws = await createTestWorkspace(sql, `blk_${run}`, { clerkUserId: bad });
      made.push(ws);
      const key = await testKey(sql, ws);
      expect((await call(key, "GET", "/api/leads")).status).toBe(200);
      expect((await call(key, "GET", "/api/leads", { env: env({ BLOCKED_USER_IDS: bad }) })).status).toBe(401);
      expect((await call(keyA, "GET", "/api/leads", { ws: A, env: env({ BLOCKED_USER_IDS: bad }) })).status).toBe(200);
    });

    test("/mcp: the key decides the workspace, whatever the header says", async () => {
      const rpc = (headers: Record<string, string>, path = "/mcp") =>
        worker.fetch(
          new Request(`https://app.example.test${path}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${keyA}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_status", arguments: {} } }),
          }),
          env(),
          ctx,
        );
      expect((await rpc({ "X-Crusonia-Workspace": B })).status).toBe(403);
      expect((await rpc({}, `/mcp?ws=${B}`)).status).toBe(403);
      expect((await rpc({ "X-Crusonia-Workspace": A })).status).toBe(200);
    });

    test("a removed member is out on their next request", async () => {
      const m = person("spoof_gone");
      const ws = await workspace("spoof_gone", person("spoof_gone_owner"));
      await join(ws, m, "member");
      const token = await clerkToken(m);
      expect((await call(token, "GET", "/api/leads", { ws })).status).toBe(200);
      const owner = await clerkToken(uid("spoof_gone_owner"));
      expect((await call(owner, "DELETE", `/api/team/members/${m}`, { ws })).status).toBe(204);
      expect(await call(token, "GET", "/api/leads", { ws })).toMatchObject({ status: 403, body: { error: { code: "not_a_member" } } });
    });
  });

  // ---------- invites ----------

  describe("invite tokens", () => {
    let ws: string;
    let owner: string;
    let ownerId: string;

    beforeAll(async () => {
      ownerId = person("inv_owner", { name: "Dana" });
      ws = await workspace("inv", ownerId);
      await sql`update workspaces set name = ${`<b>Acme</b> ${run}`} where id = ${ws}`;
      owner = await clerkToken(ownerId);
    });

    test("the token only ever exists in the email: from the system inbox, escaped, on PUBLIC_URL", async () => {
      const email = mail("first");
      const r = await call(owner, "POST", "/api/team/invites", { ws, body: { email: email.toUpperCase(), role: "admin" } });
      expect(r.status).toBe(201);
      expect(r.body.invite).toMatchObject({ email, role: "admin", status: "pending", inviter_name: "Dana" });
      const token = lastToken();
      const m = sent.at(-1)!;
      expect(m).toMatchObject({ inbox: INBOX, to: email });
      expect(m.text).toContain(`https://app.example.test/invite/${token}`);
      expect(m.html).toContain("&lt;b&gt;Acme&lt;/b&gt;");
      expect(m.html).not.toContain("<b>Acme");
      expect(m.labels).toEqual(["invite", `invite-${r.body.invite.id}`]);
      // Not in any answer, and only its hash in the database.
      const list = await call(owner, "GET", "/api/team/invites", { ws });
      expect(JSON.stringify([r.body, list.body])).not.toContain(token);
      expect(JSON.stringify(list.body)).not.toContain("hash");
      expect(list.body.data.map((i: any) => i.id)).toContain(r.body.invite.id);
      const [row] = await sql`select to_jsonb(i)::text as raw, token_hash, expires_at from workspace_invites i where id = ${r.body.invite.id}`;
      expect(row!.raw).not.toContain(token);
      expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
      const days = (new Date(row!.expires_at as string).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThanOrEqual(7);
      const audit = await sql`select data from events where workspace_id = ${ws} and kind = 'member_invited' order by id desc limit 1`;
      expect(audit[0]!.data).toMatchObject({ invite_id: r.body.invite.id, email, role: "admin", actor: `clerk:${ownerId}` });
      expect(JSON.stringify(audit[0]!.data)).not.toContain(token);
    });

    test("the link previews with no sign-in; a bad token says nothing", async () => {
      const { token } = await invite(owner, ws, mail("preview"));
      const r = await call(null, "GET", `/api/invites/${token}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.body.invite).toEqual({ workspace_name: expect.stringContaining("Acme"), inviter_name: "Dana", email: mail("preview"), role: "member", expires_at: expect.any(String) });
      expect(await call(null, "GET", `/api/invites/inv_${"0".repeat(64)}`)).toMatchObject({ status: 404, body: { error: { code: "invite_not_found" } } });
      expect(await call(null, "GET", "/api/invites/not-a-token")).toMatchObject({ status: 404, body: { error: { code: "invite_not_found" } } });
    });

    test("accepting: the right verified email joins with the invited role; the token then never works again", async () => {
      const { token } = await invite(owner, ws, mail("right"), "admin");
      const u = person("right");
      const t = await clerkToken(u);
      const r = await call(t, "POST", `/api/invites/${token}/accept`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ workspace: { id: ws, role: "admin" }, already_member: false });
      expect((await sql`select role from workspace_members where workspace_id = ${ws} and clerk_user_id = ${u}`)[0]!.role).toBe("admin");
      expect((await sql`select data from events where workspace_id = ${ws} and kind = 'invite_accepted' order by id desc limit 1`)[0]!.data).toMatchObject({ user: `clerk:${u}`, role: "admin" });
      // Reuse: by them, and by anyone else with the link; the preview goes quiet too.
      expect(await call(t, "POST", `/api/invites/${token}/accept`)).toMatchObject({ status: 410, body: { error: { code: "invite_used" } } });
      const other = await clerkToken(person("reuse", { verified: [mail("right")] }));
      expect(await call(other, "POST", `/api/invites/${token}/accept`)).toMatchObject({ status: 410, body: { error: { code: "invite_used" } } });
      const preview = await call(null, "GET", `/api/invites/${token}`);
      expect(preview).toMatchObject({ status: 410, body: { error: { code: "invite_used" } } });
      expect(JSON.stringify(preview.body)).not.toContain(mail("right"));
    });

    test("two people racing on one token: one joins", async () => {
      const email = mail("race");
      const { token } = await invite(owner, ws, email);
      const [a, b] = [person("race_a", { verified: [email] }), person("race_b", { verified: [email] })];
      const results = await Promise.all([a, b].map(async (u) => call(await clerkToken(u), "POST", `/api/invites/${token}/accept`)));
      expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
      const joined = await sql`select clerk_user_id from workspace_members where workspace_id = ${ws} and clerk_user_id = any(${[a, b]}::text[])`;
      expect(joined.length).toBe(1);
    });

    test("the wrong email is refused and leaves the invite open; so is the right address unverified", async () => {
      const email = mail("wrong-target");
      const { id, token } = await invite(owner, ws, email);
      const wrong = person("wrong");
      expect(await call(await clerkToken(wrong), "POST", `/api/invites/${token}/accept`)).toMatchObject({
        status: 403,
        body: { error: { code: "invite_email_mismatch", details: { invited_email: email } } },
      });
      const unverified = person("unverified", { verified: [mail("unverified")], unverified: [email] });
      expect((await call(await clerkToken(unverified), "POST", `/api/invites/${token}/accept`)).status).toBe(403);
      for (const u of [wrong, unverified]) expect((await sql`select 1 from workspace_members where workspace_id = ${ws} and clerk_user_id = ${u}`).length).toBe(0);
      expect((await sql`select accepted_at from workspace_invites where id = ${id}`)[0]!.accepted_at).toBeNull();
      expect((await sql`select data from events where workspace_id = ${ws} and kind = 'invite_refused' order by id desc limit 1`)[0]!.data).toMatchObject({ invite_id: id, reason: "email_mismatch" });
      // The owner of the address, with any capitalization on Clerk's side, still gets in.
      const owns = person("wrong_target", { verified: [email.toUpperCase()] });
      expect((await call(await clerkToken(owns), "POST", `/api/invites/${token}/accept`)).status).toBe(200);
    });

    test("expired", async () => {
      const { id, token } = await invite(owner, ws, mail("late"));
      await sql`update workspace_invites set expires_at = now() - interval '1 second' where id = ${id}`;
      const u = person("late");
      expect(await call(null, "GET", `/api/invites/${token}`)).toMatchObject({ status: 410, body: { error: { code: "invite_expired" } } });
      expect(await call(await clerkToken(u), "POST", `/api/invites/${token}/accept`)).toMatchObject({ status: 410, body: { error: { code: "invite_expired" } } });
      expect((await sql`select 1 from workspace_members where workspace_id = ${ws} and clerk_user_id = ${u}`).length).toBe(0);
      expect((await call(owner, "GET", "/api/team/invites", { ws })).body.data.find((i: any) => i.id === id).status).toBe("expired");
      // Inviting the address again replaces it.
      const again = await invite(owner, ws, mail("late"));
      expect(again.id).not.toBe(id);
      expect((await call(await clerkToken(u), "POST", `/api/invites/${again.token}/accept`)).status).toBe(200);
    });

    test("revoked", async () => {
      const { id, token } = await invite(owner, ws, mail("revoked"));
      expect((await call(owner, "DELETE", `/api/team/invites/${id}`, { ws })).status).toBe(204);
      const u = person("revoked");
      expect(await call(await clerkToken(u), "POST", `/api/invites/${token}/accept`)).toMatchObject({ status: 410, body: { error: { code: "invite_revoked" } } });
      expect(await call(null, "GET", `/api/invites/${token}`)).toMatchObject({ status: 410, body: { error: { code: "invite_revoked" } } });
      expect((await call(owner, "DELETE", `/api/team/invites/${id}`, { ws })).status).toBe(404);
      expect((await call(owner, "GET", "/api/team/invites", { ws })).body.data.map((i: any) => i.id)).not.toContain(id);
    });

    test("resend: a new token, the old link dead, no faster than once a minute", async () => {
      const { id, token: first } = await invite(owner, ws, mail("resend"));
      const soon = await call(owner, "POST", `/api/team/invites/${id}/resend`, { ws, body: {} });
      expect(soon).toMatchObject({ status: 429, body: { error: { code: "invite_resend_too_soon" } } });
      await sql`update workspace_invites set last_sent_at = now() - interval '2 minutes', expires_at = now() + interval '1 day' where id = ${id}`;
      const r = await call(owner, "POST", `/api/team/invites/${id}/resend`, { ws, body: {} });
      expect(r.status).toBe(200);
      const second = lastToken();
      expect(second).not.toBe(first);
      expect(new Date(r.body.invite.expires_at).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
      expect((await call(null, "GET", `/api/invites/${first}`)).status).toBe(404);
      const u = person("resend");
      expect((await call(await clerkToken(u), "POST", `/api/invites/${first}/accept`)).status).toBe(404);
      expect((await call(await clerkToken(u), "POST", `/api/invites/${second}/accept`)).status).toBe(200);
    });

    test("when the email fails: an invite that was never delivered leaves nothing behind; a failed resend keeps the old link", async () => {
      mailFails = true;
      const email = mail("bounce");
      expect(await call(owner, "POST", "/api/team/invites", { ws, body: { email } })).toMatchObject({ status: 502, body: { error: { code: "invite_email_failed" } } });
      expect((await sql`select 1 from workspace_invites where workspace_id = ${ws} and email = ${email}`).length).toBe(0);
      mailFails = false;
      const { id, token } = await invite(owner, ws, email);
      await sql`update workspace_invites set last_sent_at = now() - interval '2 minutes' where id = ${id}`;
      mailFails = true;
      expect((await call(owner, "POST", `/api/team/invites/${id}/resend`, { ws, body: {} })).status).toBe(502);
      mailFails = false;
      expect((await call(null, "GET", `/api/invites/${token}`)).status).toBe(200);
    });

    test("accepting needs a signed-in person: no token, an API key and MCP_TOKEN are refused; Clerk being down refuses too", async () => {
      const { token } = await invite(owner, ws, mail("who"));
      expect((await call(null, "POST", `/api/invites/${token}/accept`)).status).toBe(401);
      expect(await call(await testKey(sql, ws), "POST", `/api/invites/${token}/accept`)).toMatchObject({ status: 403, body: { error: { code: "human_required" } } });
      expect(await call(`it-owner-${run}`, "POST", `/api/invites/${token}/accept`)).toMatchObject({ status: 403, body: { error: { code: "human_required" } } });
      clerkDown = true;
      expect(await call(await clerkToken(person("who")), "POST", `/api/invites/${token}/accept`)).toMatchObject({ status: 503, body: { error: { code: "clerk_unavailable" } } });
      clerkDown = false;
      const blocked = env({ BLOCKED_USER_IDS: uid("who") });
      expect(await call(await clerkToken(uid("who")), "POST", `/api/invites/${token}/accept`, { env: blocked })).toMatchObject({ status: 403, body: { error: { code: "account_blocked" } } });
      expect((await call(null, "GET", `/api/invites/${token}`)).status).toBe(200);
    });

    test("works while sign-ups are closed: a brand-new user joins and gets no workspace of their own", async () => {
      const closed = env({ SIGNUPS_OPEN: "false" });
      const { token } = await invite(owner, ws, mail("closed"), "member", closed);
      const u = person("closed");
      const t = await clerkToken(u);
      // Nobody can get in any other way.
      expect(await call(t, "GET", "/api/me", { env: closed })).toMatchObject({ status: 403, body: { error: { code: "signups_closed" } } });
      expect((await call(null, "GET", `/api/invites/${token}`, { env: closed })).status).toBe(200);
      expect((await call(t, "POST", `/api/invites/${token}/accept`, { env: closed })).status).toBe(200);
      const me = await call(t, "GET", "/api/me", { env: closed });
      expect(me.body.workspace).toMatchObject({ id: ws, role: "member" });
      expect((await sql`select workspace_id from workspace_members where clerk_user_id = ${u}`).map((r) => r.workspace_id)).toEqual([ws]);
      // But being invited doesn't let them open up shop.
      expect(await call(t, "POST", "/api/workspaces", { env: closed, ws, body: { name: "Mine" } })).toMatchObject({ status: 403, body: { error: { code: "signups_closed" } } });
    });

    test("with sign-ups open, a new user's accept makes no workspace either", async () => {
      const { token } = await invite(owner, ws, mail("open"));
      const u = person("open");
      expect((await call(await clerkToken(u), "POST", `/api/invites/${token}/accept`)).status).toBe(200);
      expect((await sql`select workspace_id from workspace_members where clerk_user_id = ${u}`).map((r) => r.workspace_id)).toEqual([ws]);
    });

    test("someone already in the workspace keeps their role, and is told", async () => {
      const email = mail("keeps");
      const u = person("keeps", { verified: [email, mail("keeps-other")] });
      await join(ws, u, "admin");
      clerkUsers.set(u, { name: "keeps", verified: [mail("keeps-other"), email] });
      const { token } = await invite(owner, ws, email);
      const r = await call(await clerkToken(u), "POST", `/api/invites/${token}/accept`);
      expect(r.body).toMatchObject({ workspace: { id: ws, role: "admin" }, already_member: true });
    });

    test("no second invite to an open address, to a member, or to someone who asked not to be contacted; nothing while paused", async () => {
      const email = mail("dup");
      await invite(owner, ws, email);
      const count = sent.length;
      expect(await call(owner, "POST", "/api/team/invites", { ws, body: { email } })).toMatchObject({ status: 409, body: { error: { code: "invite_exists" } } });
      expect(await call(owner, "POST", "/api/team/invites", { ws, body: { email: mail("inv_owner") } })).toMatchObject({ status: 409, body: { error: { code: "already_member" } } });
      await addSuppression(sql, ws, mail("dnc"), "manual", "test");
      expect(await call(owner, "POST", "/api/team/invites", { ws, body: { email: mail("dnc") } })).toMatchObject({ status: 422, body: { error: { code: "email_suppressed" } } });
      expect((await call(owner, "POST", "/api/team/invites", { ws, body: { email: "not an email" } })).status).toBe(400);
      expect((await call(owner, "POST", "/api/team/invites", { ws, body: { email: mail("own"), role: "owner" } })).status).toBe(400);
      await sql`update workspaces set paused = true where id = ${ws}`;
      expect(await call(owner, "POST", "/api/team/invites", { ws, body: { email: mail("paused") } })).toMatchObject({ status: 409, body: { error: { code: "workspace_paused" } } });
      await sql`update workspaces set paused = false where id = ${ws}`;
      expect(sent.length).toBe(count);
    });

    test("a complaint on the instance's inbox (the owner workspace) blocks that address for every workspace", async () => {
      const email = mail("complained");
      await sql`insert into suppressions (workspace_id, email, reason) values ('ws_owner', ${email}, 'complaint') on conflict do nothing`;
      try {
        expect(await call(owner, "POST", "/api/team/invites", { ws, body: { email } })).toMatchObject({ status: 422, body: { error: { code: "email_suppressed" } } });
      } finally {
        await sql`delete from suppressions where workspace_id = 'ws_owner' and email = ${email}`;
      }
    });
  });

  // ---------- roles ----------

  describe("roles", () => {
    let ws: string;
    let ownerT: string;
    let adminT: string;
    let memberT: string;
    const ownerId = () => uid("role_owner");
    const adminId = () => uid("role_admin");
    const memberId = () => uid("role_member");

    beforeAll(async () => {
      ws = await workspace("roles", person("role_owner"));
      person("role_admin");
      person("role_member");
      await join(ws, adminId(), "admin");
      await join(ws, memberId(), "member");
      ownerT = await clerkToken(ownerId());
      adminT = await clerkToken(adminId());
      memberT = await clerkToken(memberId());
    });

    test("a member can't manage billing, keys, the team or integrations, but does the everyday work", async () => {
      const refused: [string, string, unknown?][] = [
        ["POST", "/api/keys", { name: "k" }],
        ["DELETE", "/api/keys/key_x"],
        ["POST", "/api/billing/checkout", { pack: "starter" }],
        ["POST", "/api/billing/portal", {}],
        ["POST", "/api/integrations/sync", { target: "hubspot" }],
        ["POST", "/api/integrations/hubspot/import", {}],
        ["GET", "/api/team/invites"],
        ["POST", "/api/team/invites", { email: mail("from-member") }],
        ["POST", "/api/team/invites/inv_x/resend", {}],
        ["DELETE", "/api/team/invites/inv_x"],
        ["PATCH", `/api/team/members/${ownerId()}`, { role: "member" }],
        ["PATCH", `/api/team/members/${memberId()}`, { role: "admin" }],
        ["DELETE", `/api/team/members/${adminId()}`],
        ["PATCH", "/api/workspaces/current", { name: "Mine" }],
      ];
      for (const [method, path, body] of refused) {
        const r = await call(memberT, method, path, { ws, ...(body === undefined ? {} : { body }) });
        expect({ method, path, status: r.status, code: r.body?.error?.code }).toEqual({ method, path, status: 403, code: "forbidden_role" });
      }
      expect(sent.filter((m) => m.to === mail("from-member"))).toEqual([]);
      for (const path of ["/api/leads", "/api/team/members", "/api/billing", "/api/keys", "/api/integrations/crm", "/api/summary", "/api/settings/pause"]) {
        expect({ path, status: (await call(memberT, "GET", path, { ws })).status }).toEqual({ path, status: 200 });
      }
      expect((await call(memberT, "POST", "/api/leads", { ws, body: { email: mail("by-member") } })).status).toBe(201);
    });

    test("a member can't decide consent or take an address off the do-not-contact list; an admin and an owner can", async () => {
      const email = mail("consent-lead");
      const lead = (await call(memberT, "POST", "/api/leads", { ws, body: { email } })).body.lead;
      expect(lead.has_consent).toBe(false);
      const csv = `Email,Opted in\n${mail("csv-lead")},yes\n`;
      const refused: [string, string, unknown?][] = [
        ["POST", "/api/leads", { email: mail("granted-by-member"), consent: { text: "said yes" } }],
        ["PATCH", `/api/leads/${lead.id}`, { consent: { text: "said yes" } }],
        ["PATCH", `/api/leads/${lead.id}`, { consent: null }],
        ["POST", "/api/leads/import", { csv, mapping: { email: "Email", consent: "Opted in" } }],
        ["POST", "/api/import/commit", { csv, mapping: { email: "Email", consent: "Opted in" }, source: "members" }],
      ];
      for (const [method, path, body] of refused) {
        const r = await call(memberT, method, path, { ws, body });
        expect({ method, path, status: r.status, code: r.body?.error?.code }).toEqual({ method, path, status: 403, code: "forbidden_role" });
      }
      // What's left of a member's import: the contacts, without consent, even if a consent column would have been guessed.
      expect((await call(memberT, "PATCH", `/api/leads/${lead.id}`, { ws, body: { title: "CTO" } })).body.lead).toMatchObject({ title: "CTO", has_consent: false });
      expect((await call(memberT, "POST", "/api/leads/import", { ws, body: { csv } })).status).toBe(200);
      expect((await sql`select consent_at from leads where workspace_id = ${ws} and email = ${mail("csv-lead")}`)[0]!.consent_at).toBeNull();

      for (const [role, token] of [["admin", adminT], ["owner", ownerT]] as const) {
        const granted = await call(token, "PATCH", `/api/leads/${lead.id}`, { ws, body: { consent: { text: `from the ${role}` } } });
        expect({ role, has_consent: granted.body.lead?.has_consent }).toEqual({ role, has_consent: true });
        const removed = await call(token, "PATCH", `/api/leads/${lead.id}`, { ws, body: { consent: null } });
        expect({ role, has_consent: removed.body.lead?.has_consent }).toEqual({ role, has_consent: false });
        expect((await call(token, "POST", "/api/leads", { ws, body: { email: mail(`by-${role}`), consent: { text: "said yes" } } })).body.lead.has_consent).toBe(true);
        const imported = await call(token, "POST", "/api/import/commit", { ws, body: { csv: `Email,Opted in\n${mail(`csv-${role}`)},yes\n`, mapping: { email: "Email", consent: "Opted in" }, source: role } });
        expect({ role, status: imported.status }).toEqual({ role, status: 200 });
        expect((await sql`select consent_at from leads where workspace_id = ${ws} and email = ${mail(`csv-${role}`)}`)[0]!.consent_at).not.toBeNull();
      }

      // Anyone may add to the do-not-contact list; only an admin or an owner takes someone off it.
      const dnc = encodeURIComponent(mail("dnc"));
      for (const token of [adminT, ownerT]) {
        expect((await call(memberT, "POST", "/api/suppressions", { ws, body: { email: mail("dnc") } })).status).toBe(201);
        const r = await call(memberT, "DELETE", `/api/suppressions/${dnc}`, { ws });
        expect([r.status, r.body.error.code]).toEqual([403, "forbidden_role"]);
        expect((await call(memberT, "GET", "/api/suppressions", { ws })).body.data.map((s: { email: string }) => s.email)).toContain(mail("dnc"));
        expect((await call(token, "DELETE", `/api/suppressions/${dnc}`, { ws })).status).toBe(204);
      }
    });

    test("an admin runs the team but can't touch an owner or make one", async () => {
      const { id } = await invite(adminT, ws, mail("from-admin"));
      expect((await call(adminT, "DELETE", `/api/team/invites/${id}`, { ws })).status).toBe(204);
      expect((await call(adminT, "POST", "/api/keys", { ws, body: { name: "admin key" } })).status).toBe(201);
      const forbidden = { status: 403, body: { error: { code: "forbidden_role" } } };
      expect(await call(adminT, "PATCH", `/api/team/members/${memberId()}`, { ws, body: { role: "owner" } })).toMatchObject(forbidden);
      expect(await call(adminT, "PATCH", `/api/team/members/${adminId()}`, { ws, body: { role: "owner" } })).toMatchObject(forbidden);
      expect(await call(adminT, "PATCH", `/api/team/members/${ownerId()}`, { ws, body: { role: "member" } })).toMatchObject(forbidden);
      expect(await call(adminT, "DELETE", `/api/team/members/${ownerId()}`, { ws })).toMatchObject(forbidden);
      const up = await call(adminT, "PATCH", `/api/team/members/${memberId()}`, { ws, body: { role: "admin" } });
      expect(up.body.member).toEqual({ user_id: memberId(), role: "admin" });
      const down = await call(adminT, "PATCH", `/api/team/members/${memberId()}`, { ws, body: { role: "member" } });
      expect(down.body.member.role).toBe("member");
      const audit = await sql`select data from events where workspace_id = ${ws} and kind = 'member_role_changed' order by id`;
      expect(audit.map((r) => r.data)).toEqual([
        expect.objectContaining({ user: memberId(), from: "member", to: "admin", actor: `clerk:${adminId()}` }),
        expect.objectContaining({ user: memberId(), from: "admin", to: "member", actor: `clerk:${adminId()}` }),
      ]);
    });

    test("members list with Clerk's names and emails, or just the id when Clerk is down", async () => {
      const list = await call(memberT, "GET", "/api/team/members", { ws });
      expect(list.body.data.map((m: any) => [m.user_id, m.role, m.email])).toEqual([
        [ownerId(), "owner", mail("role_owner")],
        [adminId(), "admin", mail("role_admin")],
        [memberId(), "member", mail("role_member")],
      ]);
      clerkDown = true;
      const quiet = await call(memberT, "GET", "/api/team/members", { ws });
      expect(quiet.status).toBe(200);
      expect(quiet.body.data[0]).toEqual({ user_id: ownerId(), role: "owner", joined_at: expect.any(String) });
    });

    test("the last owner can't leave or be demoted; with a second owner they can", async () => {
      const lastOwner = { status: 409, body: { error: { code: "last_owner" } } };
      expect(await call(ownerT, "POST", "/api/team/leave", { ws, body: {} })).toMatchObject(lastOwner);
      expect(await call(ownerT, "PATCH", `/api/team/members/${ownerId()}`, { ws, body: { role: "admin" } })).toMatchObject(lastOwner);
      expect(await call(ownerT, "DELETE", `/api/team/members/${ownerId()}`, { ws })).toMatchObject(lastOwner);
      expect((await call(ownerT, "PATCH", `/api/team/members/${adminId()}`, { ws, body: { role: "owner" } })).status).toBe(200);
      // Two owners demoting each other at once: the lock leaves one.
      const both = await Promise.all([
        call(ownerT, "PATCH", `/api/team/members/${adminId()}`, { ws, body: { role: "member" } }),
        call(adminT, "PATCH", `/api/team/members/${ownerId()}`, { ws, body: { role: "member" } }),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
      const owners = await sql`select clerk_user_id from workspace_members where workspace_id = ${ws} and role = 'owner'`;
      expect(owners.length).toBe(1);
      // Back to where the other tests expect things.
      const stillOwner = owners[0]!.clerk_user_id as string;
      const t = await clerkToken(stillOwner);
      await call(t, "PATCH", `/api/team/members/${ownerId()}`, { ws, body: { role: "owner" } });
      await call(t, "PATCH", `/api/team/members/${adminId()}`, { ws, body: { role: "admin" } });
    });

    test("anyone else can leave; the workspace goes with it, and the audit trail says so", async () => {
      const u = person("leaver");
      await join(ws, u, "member");
      const t = await clerkToken(u);
      expect((await call(t, "POST", "/api/team/leave", { ws, body: {} })).status).toBe(204);
      expect((await call(t, "GET", "/api/leads", { ws })).status).toBe(403);
      expect((await sql`select data from events where workspace_id = ${ws} and kind = 'member_left' order by id desc limit 1`)[0]!.data).toMatchObject({ user: u, actor: `clerk:${u}` });
    });

    test("removing someone also revokes the keys they made and the invites they sent, and only theirs", async () => {
      const u = person("ex_admin");
      await join(ws, u, "admin");
      const t = await clerkToken(u);
      const key = await call(t, "POST", "/api/keys", { ws, body: { name: "ex admin's" } });
      const other = await call(ownerT, "POST", "/api/keys", { ws, body: { name: "owner's" } });
      const theirs = await invite(t, ws, mail("ex-friend"));
      const ours = await invite(ownerT, ws, mail("ours"));
      expect((await call(key.body.key, "GET", "/api/leads")).status).toBe(200);
      expect((await call(ownerT, "DELETE", `/api/team/members/${u}`, { ws })).status).toBe(204);
      expect((await call(key.body.key, "GET", "/api/leads")).status).toBe(401);
      expect((await call(other.body.key, "GET", "/api/leads")).status).toBe(200);
      expect(await call(null, "GET", `/api/invites/${theirs.token}`)).toMatchObject({ status: 410, body: { error: { code: "invite_revoked" } } });
      expect((await call(null, "GET", `/api/invites/${ours.token}`)).status).toBe(200);
      const [ev] = await sql`select data from events where workspace_id = ${ws} and kind = 'member_removed' order by id desc limit 1`;
      expect(ev!.data).toMatchObject({ user: u, role: "admin", keys_revoked: 1, invites_revoked: 1, actor: `clerk:${ownerId()}` });
    });

    test("the instance owner stays an owner of the owner workspace", async () => {
      const o = person("instance_owner");
      const co = person("instance_co");
      const e = env({ OWNER_CLERK_USER_ID: o });
      await join("ws_owner", co, "owner");
      try {
        const t = await clerkToken(co);
        await call(await clerkToken(o), "GET", "/api/me", { env: e });
        const forbidden = { status: 403, body: { error: { code: "forbidden_role" } } };
        expect(await call(t, "PATCH", `/api/team/members/${o}`, { env: e, ws: "ws_owner", body: { role: "member" } })).toMatchObject(forbidden);
        expect(await call(t, "DELETE", `/api/team/members/${o}`, { env: e, ws: "ws_owner" })).toMatchObject(forbidden);
      } finally {
        await sql`delete from workspace_members where workspace_id = 'ws_owner' and clerk_user_id in (${o}, ${co})`;
      }
    });

    test("an API key can't reach the team at all, but MCP_TOKEN (the owner's own token) can", async () => {
      const key = await testKey(sql, ws);
      expect(await call(key, "GET", "/api/team/members")).toMatchObject({ status: 403, body: { error: { code: "human_required" } } });
      expect(await call(key, "POST", "/api/team/invites", { body: { email: mail("by-key") } })).toMatchObject({ status: 403, body: { error: { code: "human_required" } } });
      expect(await call(key, "POST", "/api/workspaces", { body: { name: "by key" } })).toMatchObject({ status: 403, body: { error: { code: "human_required" } } });
      expect(sent.filter((m) => m.to === mail("by-key"))).toEqual([]);
      expect((await call(`it-owner-${run}`, "GET", "/api/team/members")).status).toBe(200);
      expect(await call(`it-owner-${run}`, "POST", "/api/workspaces", { body: { name: "x" } })).toMatchObject({ status: 403, body: { error: { code: "human_required" } } });
    });
  });

  // ---------- open sign-up ----------

  describe("open sign-up", () => {
    const balance = async (t: string, e?: Env) => (await call(t, "GET", "/api/billing", e ? { env: e } : {})).body.balance as number;

    test("a new workspace needs a verified email that isn't a throwaway, and Clerk's word for it", async () => {
      const unverified = person("su_unv", { verified: [], unverified: [mail("su_unv")] });
      expect(await call(await clerkToken(unverified), "GET", "/api/me")).toMatchObject({ status: 403, body: { error: { code: "email_not_verified" } } });
      const throwaway = person("su_throw", { verified: [`someone-${run}@mailinator.com`] });
      expect(await call(await clerkToken(throwaway), "GET", "/api/me")).toMatchObject({ status: 403, body: { error: { code: "email_not_allowed" } } });
      const later = person("su_down");
      clerkDown = true;
      expect(await call(await clerkToken(later), "GET", "/api/me")).toMatchObject({ status: 503, body: { error: { code: "clerk_unavailable" } } });
      clerkDown = false;
      // None of them got a workspace or an account; the last one gets in once Clerk answers.
      expect(await sql`select 1 from workspace_members where clerk_user_id = any(${[unverified, throwaway, later]}::text[])`).toEqual([]);
      expect((await call(await clerkToken(later), "GET", "/api/me")).status).toBe(200);
    });

    test("a mailbox gets one free sample, however its address is written", async () => {
      const first = person("su_a", { verified: [`dan${run}@gmail.com`] });
      const second = person("su_b", { verified: [`d.a.n.${run}+again@googlemail.com`] });
      expect(await balance(await clerkToken(first))).toBe(300);
      const t = await clerkToken(second);
      expect(await balance(t)).toBe(0);
      // It still has a workspace, and says why nothing runs, instead of an error.
      expect((await call(t, "GET", "/api/me")).status).toBe(200);
      const [w] = await sql`select w.no_free_sample from workspaces w join workspace_members m on m.workspace_id = w.id where m.clerk_user_id = ${second}`;
      expect(w!.no_free_sample).toBe(true);
    });

    test("two accounts on one mailbox at the same moment still get one sample between them", async () => {
      const a = person("su_c", { verified: [`race${run}@acme.example.com`] });
      const b = person("su_d", { verified: [`race${run}+2@acme.example.com`] });
      const balances = await Promise.all([a, b].map(async (id) => balance(await clerkToken(id))));
      expect(balances.sort((x, y) => x - y)).toEqual([0, 300]);
    });

    test("someone who joined by invite and makes their own workspace is checked too", async () => {
      const owner = person("su_host");
      const ws = await workspace("su_host", owner);
      const joined = person("su_join", { verified: [`someone-${run}@yopmail.com`] });
      await join(ws, joined, "member");
      expect(await call(await clerkToken(joined), "POST", "/api/workspaces", { body: { name: "Mine" } })).toMatchObject({ status: 403, body: { error: { code: "email_not_allowed" } } });
      const fine = person("su_join2");
      await join(ws, fine, "member");
      const made2 = await call(await clerkToken(fine), "POST", "/api/workspaces", { body: { name: "Mine" } });
      expect(made2.status).toBe(201);
      made.push(made2.body.workspace.id);
      expect(await getBalance(sql, made2.body.workspace.id)).toBe(300);
    });

    test("an invite says who sent it, and replies go to them, not to the instance's inbox", async () => {
      const owner = person("su_inv", { name: "Dana", verified: [mail("su_inv")] });
      const ws = await workspace("su_inv", owner);
      await invite(await clerkToken(owner), ws, mail("su_invited"));
      const email = sent.at(-1)! as unknown as { text: string; html: string; reply_to?: string };
      expect(email.text).toContain(`Dana (${mail("su_inv")}) invited you`);
      expect(email.text).toContain("The people who run Crusonia didn't write it and haven't seen it.");
      expect(email.reply_to).toBe(mail("su_inv"));
    });

    test("an admin's invite shows the admin; a workspace with no verified owner email can't invite at all", async () => {
      const owner = person("su_o", { verified: [], unverified: [mail("su_o")] });
      const admin = person("su_adm");
      const ws = await workspace("su_o", owner);
      await join(ws, admin, "admin");
      const t = await clerkToken(admin);
      const before = sent.length;
      expect(await call(t, "POST", "/api/team/invites", { ws, body: { email: mail("su_nope") } })).toMatchObject({ status: 403, body: { error: { code: "owner_email_unverified" } } });
      expect(sent.length).toBe(before);
      expect(await sql`select 1 from workspace_invites where workspace_id = ${ws}`).toEqual([]);
      // Refused before it uses up a send.
      expect(await sql`select 1 from invite_sends where workspace_id = ${ws}`).toEqual([]);

      clerkUsers.set(owner, { name: "su_o", verified: [mail("su_o")] });
      await invite(t, ws, mail("su_yes"));
      expect(sent.at(-1)!.text).toContain(`su_adm (${mail("su_adm")}) invited you`);

      // Clerk down: refused too, rather than sent with nobody to answer for it.
      clerkDown = true;
      expect((await call(t, "POST", "/api/team/invites", { ws, body: { email: mail("su_down") } })).status).toBe(403);
    });

    test("the default limit is 10 invites per workspace per day", async () => {
      const owner = person("su_lim");
      const ws = await workspace("su_lim", owner);
      const t = await clerkToken(owner);
      const e = env({ INVITES_PER_WORKSPACE_PER_DAY: undefined });
      for (let i = 0; i < 10; i++) await invite(t, ws, mail(`su_l${i}`), "member", e);
      expect(await call(t, "POST", "/api/team/invites", { ws, env: e, body: { email: mail("su_l10") } })).toMatchObject({ status: 429, body: { error: { code: "invite_rate_limited" } } });
    });

    test("the default limit is 50 invites per instance per day", async () => {
      const owner = person("su_inst");
      const ws = await workspace("su_inst", owner);
      const t = await clerkToken(owner);
      // The same limit whatever else this database has sent: count what is there, and leave room for one.
      const [{ n }] = (await sql`select count(*)::int as n from invite_sends where created_at > now() - interval '1 day'`) as { n: number }[];
      const e = env({ INVITES_PER_INSTANCE_PER_DAY: String(n + 1) });
      await invite(t, ws, mail("su_i0"), "member", e);
      expect(await call(t, "POST", "/api/team/invites", { ws, env: e, body: { email: mail("su_i1") } })).toMatchObject({ status: 429, body: { error: { code: "invite_rate_limited" } } });
      expect(limitsConfig({ PUBLIC_URL: "x" }).invitesPerInstancePerDay).toBe(50);
    });
  });

  // ---------- rate limits ----------

  describe("rate limits", () => {
    const limited = (body: { status: number; body: any }) => expect(body).toMatchObject({ status: 429, body: { error: { code: "invite_rate_limited" } } });

    test("per workspace per day: resends count, and an old send stops counting", async () => {
      const ws = await workspace("rl_ws", person("rl_ws"));
      const t = await clerkToken(uid("rl_ws"));
      const e = env({ INVITES_PER_WORKSPACE_PER_DAY: "2" });
      const a = await invite(t, ws, mail("rl1"), "member", e);
      await sql`update workspace_invites set last_sent_at = now() - interval '2 minutes' where id = ${a.id}`;
      expect((await call(t, "POST", `/api/team/invites/${a.id}/resend`, { ws, env: e, body: {} })).status).toBe(200);
      const count = sent.length;
      limited(await call(t, "POST", "/api/team/invites", { ws, env: e, body: { email: mail("rl2") } }));
      await sql`update workspace_invites set last_sent_at = now() - interval '2 minutes' where id = ${a.id}`;
      limited(await call(t, "POST", `/api/team/invites/${a.id}/resend`, { ws, env: e, body: {} }));
      expect(sent.length).toBe(count);
      expect((await sql`select 1 from workspace_invites where workspace_id = ${ws} and email = ${mail("rl2")}`).length).toBe(0);
      expect((await sql`select count(*)::int as n from events where workspace_id = ${ws} and kind = 'invite_rate_limited'`)[0]!.n).toBe(2);
      await sql`update invite_sends set created_at = now() - interval '25 hours' where workspace_id = ${ws}`;
      expect((await call(t, "POST", "/api/team/invites", { ws, env: e, body: { email: mail("rl2") } })).status).toBe(201);
    });

    test("per sender across workspaces: making more workspaces doesn't make more email", async () => {
      const u = person("rl_user");
      const a = await workspace("rl_user_a", u);
      const b = await workspace("rl_user_b");
      await join(b, u, "owner");
      const t = await clerkToken(u);
      const e = env({ INVITES_PER_USER_PER_DAY: "1" });
      await invite(t, a, mail("rlu1"), "member", e);
      limited(await call(t, "POST", "/api/team/invites", { ws: b, env: e, body: { email: mail("rlu2") } }));
    });

    test("per address across workspaces: nobody can be flooded from many workspaces", async () => {
      const email = mail("rl-target");
      const e = env({ INVITES_PER_EMAIL_PER_DAY: "1" });
      const a = await workspace("rl_addr_a", person("rl_addr_a"));
      const b = await workspace("rl_addr_b", person("rl_addr_b"));
      await invite(await clerkToken(uid("rl_addr_a")), a, email, "member", e);
      limited(await call(await clerkToken(uid("rl_addr_b")), "POST", "/api/team/invites", { ws: b, env: e, body: { email } }));
    });

    test("a burst of concurrent invites can't slip past the limit", async () => {
      const ws = await workspace("rl_burst", person("rl_burst"));
      const t = await clerkToken(uid("rl_burst"));
      const e = env({ INVITES_PER_WORKSPACE_PER_DAY: "2" });
      const results = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => call(t, "POST", "/api/team/invites", { ws, env: e, body: { email: mail(`burst${i}`) } })));
      expect(results.filter((r) => r.status === 201).length).toBe(2);
      expect(results.filter((r) => r.status === 429).length).toBe(4);
    });

    test("the whole instance has a cap too", async () => {
      const ws = await workspace("rl_all", person("rl_all"));
      const t = await clerkToken(uid("rl_all"));
      const [{ n }] = (await sql`select count(*)::int as n from invite_sends where created_at > now() - interval '1 day'`) as [{ n: number }];
      limited(await call(t, "POST", "/api/team/invites", { ws, env: env({ INVITES_PER_INSTANCE_PER_DAY: String(n) }), body: { email: mail("rl-all") } }));
    });
  });

  // ---------- creating workspaces ----------

  describe("creating workspaces", () => {
    test("the free sample is one per person; the first workspace has it, and viewing billing elsewhere grants nothing", async () => {
      const u = person("maker");
      const t = await clerkToken(u);
      const first = (await call(t, "GET", "/api/me")).body.workspace.id as string;
      made.push(first);
      expect((await call(t, "GET", "/api/billing", { ws: first })).body.balance).toBe(300);
      const r = await call(t, "POST", "/api/workspaces", { body: { name: "  Second  " } });
      expect(r.status).toBe(201);
      expect(r.body.workspace).toMatchObject({ name: "Second", role: "owner", owner: false });
      const second = r.body.workspace.id as string;
      made.push(second);
      expect((await call(t, "GET", "/api/billing", { ws: second })).body).toMatchObject({ workspace_id: second, balance: 0 });
      expect(await getBalance(sql, second)).toBe(0);
      expect((await sql`select role from workspace_members where workspace_id = ${second} and clerk_user_id = ${u}`)[0]!.role).toBe("owner");
      expect((await sql`select data from events where workspace_id = ${second} and kind = 'workspace_created'`)[0]!.data).toMatchObject({ actor: `clerk:${u}` });
      expect((await call(t, "PATCH", "/api/workspaces/current", { ws: second, body: { name: "Renamed" } })).body.workspace.name).toBe("Renamed");
      expect((await call(t, "GET", "/api/workspaces")).body.data.map((w: any) => w.name)).toContain("Renamed");
    });

    test("someone who only joined through an invite gets the free sample on their own first workspace, once", async () => {
      const u = person("joined_first");
      const owner = await workspace("joined_first", person("joined_first_owner"));
      await join(owner, u, "member");
      const t = await clerkToken(u);
      const r = await call(t, "POST", "/api/workspaces", { body: { name: "My own" } });
      made.push(r.body.workspace.id);
      expect(await (await call(t, "GET", "/api/billing", { ws: r.body.workspace.id })).body.balance).toBe(300);
    });

    test("a cap per person, even when they've left the ones they made", async () => {
      const u = person("capped");
      const t = await clerkToken(u);
      const e = env({ MAX_WORKSPACES_PER_USER: "2" });
      made.push((await call(t, "GET", "/api/me", { env: e })).body.workspace.id);
      made.push((await call(t, "POST", "/api/workspaces", { env: e, body: { name: "Two" } })).body.workspace.id);
      expect(await call(t, "POST", "/api/workspaces", { env: e, body: { name: "Three" } })).toMatchObject({ status: 403, body: { error: { code: "workspace_limit" } } });
    });

    test("a name is one short line", async () => {
      const t = await clerkToken(person("namer"));
      made.push((await call(t, "GET", "/api/me")).body.workspace.id);
      for (const name of ["", "   ", "x".repeat(81), "line\nbreak"]) expect((await call(t, "POST", "/api/workspaces", { body: { name } })).status).toBe(400);
    });

    test("removed from everything with sign-ups open: a new workspace, without a second free sample", async () => {
      const u = person("regrant");
      const t = await clerkToken(u);
      const first = (await call(t, "GET", "/api/me")).body.workspace.id as string;
      made.push(first);
      expect((await call(t, "GET", "/api/billing")).body.balance).toBe(300);
      await sql`delete from workspace_members where clerk_user_id = ${u}`;
      const again = (await call(t, "GET", "/api/me")).body.workspace.id as string;
      made.push(again);
      expect(again).not.toBe(first);
      expect((await call(t, "GET", "/api/billing")).body.balance).toBe(0);
    });
  });
});
