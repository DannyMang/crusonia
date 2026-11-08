// Workspaces against a real Postgres (a Neon dev branch, never production), with Naive faked at fetch.
// Skipped unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=<dev branch url> bun test test/workspaces.integration.test.ts
// Covers: the migration's backfill and per-workspace uniqueness, workspace creation on first sign-in, isolation of
// every /api route and MCP tool between two workspaces, the Company summary (overwrites, sections, the migration, the
// /api/profile alias), credits and limits for workspaces other than the owner's, the billing merge, platform-admin
// reads, and the per-workspace Naive agent. Everything runs in throwaway workspaces that are deleted afterwards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@neondatabase/serverless";
import { addLedgerRow, getBalance } from "../src/billing/accounts.ts";
import { getSql, type Sql } from "../src/db.ts";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";
import type { FetchFn } from "../src/providers/http.ts";
import { verifyApiKey } from "../src/services/api-keys.ts";
import { patchLead } from "../src/services/crm.ts";
import { createDraft } from "../src/services/drafts.ts";
import { handleAgentMailEvent } from "../src/services/inbound.ts";
import { addLeads } from "../src/services/leads.ts";
import { paidStartAllowance } from "../src/services/limits.ts";
import { naiveAgentFor, resetTemplateVersionCache, workspaceMcpUrl } from "../src/services/naive-agents.ts";
import { addSuppression } from "../src/services/settings.ts";
import { createTestWorkspace, deleteTestWorkspaces, testKey } from "./helpers/workspace.ts";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const run = crypto.randomUUID().slice(0, 8);
const ctx = {} as ExecutionContext;
let sql: Sql;
/** Two customer workspaces, each with a key. B holds the data A must never reach. */
let A: string;
let B: string;
let keyA: string;
let keyB: string;
const created: string[] = [];
const b: { lead: string; email: string; code: string; session: string; keyId: string; suppressed: string } = {
  lead: "",
  email: "",
  code: "",
  session: "",
  keyId: "",
  suppressed: "",
};

// Clerk session tokens signed with a key generated here (networkless verification with CLERK_JWT_KEY).
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
  PUBLIC_URL: "https://example.test",
  DATABASE_URL: url,
  MCP_TOKEN: `it-owner-${run}`,
  NAIVE_API_KEY: "nv_test",
  NAIVE_AGENT_ID: "agt_template",
  NAIVE_VAULT_ID: "vlt_test",
  CLERK_JWT_KEY: pem,
  ...over,
});

async function call(token: string, method: string, path: string, body?: unknown, e: Env = env()) {
  const res = await worker.fetch(
    new Request(`https://example.test${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    e,
    ctx,
  );
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any };
}

let rpcId = 0;
/** One MCP tools/call through the real /mcp route. Returns the parsed result or the error text. */
async function tool(token: string, name: string, args: Record<string, unknown> = {}, path = "/mcp", e: Env = env()) {
  const res = await worker.fetch(
    new Request(`https://example.test${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    }),
    e,
    ctx,
  );
  if (res.status !== 200) return { status: res.status, error: await res.text() };
  const rpc = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  const text = rpc.result.content[0]!.text;
  return rpc.result.isError ? { error: text } : { data: JSON.parse(text) };
}

suite("workspaces (database, faked Naive)", () => {
  beforeAll(async () => {
    sql = getSql(url);
    const params = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
    keys = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
    const spki = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64");
    pem = `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----`;

    A = await createTestWorkspace(sql, `a_${run}`, { clerkUserId: `user_it_${run}_a` });
    B = await createTestWorkspace(sql, `b_${run}`, { clerkUserId: `user_it_${run}_b` });
    created.push(A, B);
    keyA = await testKey(sql, A, "A key");
    keyB = await testKey(sql, B, "B key");
    b.keyId = (await verifyApiKey(sql, keyB))!.id;

    // B's data: an opted-in lead with a pending send approval, a suppression, a run, a reply, a summary.
    b.email = `shared-${run}@it.example.com`;
    const lead = await call(await clerkToken(`user_it_${run}_b`), "POST", "/api/leads", { email: b.email, name: "Bea", consent: { text: "opted in" } });
    b.lead = lead.body.lead.id;
    b.code = (await createDraft(sql, B, { lead_id: b.lead, subject: "Hi from B", body: "Body" }, { ttlMinutes: 60 })).approval.code;
    b.suppressed = `nope-${run}@it.example.com`;
    await addSuppression(sql, B, b.suppressed, "manual", "test");
    b.session = `ses_ws_${run}_b`;
    await sql`insert into naive_sessions (id, workspace_id, lead_id, purpose, status) values (${b.session}, ${B}, ${b.lead}, 'research', 'done')`;
    await sql`insert into messages (workspace_id, lead_id, direction, provider_message_id, thread_id, from_addr, subject, body, label)
              values (${B}, ${b.lead}, 'in', ${`ws-${run}-reply`}, ${`thr_ws_${run}_b`}, ${b.email}, 'Re: Hi', 'Yes please', 'interested')`;
    await call(keyB, "PUT", "/api/company-summary", { markdown: "# B Corp\n\n## What we sell\n\nB things" });
    await addLedgerRow(sql, { workspaceId: B, amount: 777, reason: "adjustment", source: `adjustment:ws-it-${run}-b` });
  });

  afterAll(async () => {
    if (!sql) return;
    await deleteTestWorkspaces(sql, created);
    await sql`delete from events where workspace_id = 'ws_owner' and data::text like ${`%${run}%`}`;
  });

  // ---------- the migration ----------

  describe("migration", () => {
    test("the Company summary keeps each workspace's latest row and drops the older versions; a rerun changes nothing", async () => {
      // The statements from src/schema.sql, in a schema of their own: nothing here reaches the shared tables.
      const file = await Bun.file(new URL("../src/schema.sql", import.meta.url)).text();
      const block = /create table if not exists company_summaries[\s\S]*?\nend\n\$\$;/.exec(file)![0];
      const schema = `it_summary_${run}`;
      const client = new Client(url);
      await client.connect();
      try {
        await client.query(`
          create schema ${schema};
          set local search_path to ${schema};
          create table workspaces (id text primary key);
          insert into workspaces values ('w1'), ('w2'), ('w3');
          create table company_summary_versions (
            id bigserial primary key, workspace_id text not null references workspaces(id), version int not null, content_md text not null,
            author text not null, change_note text, created_at timestamptz not null default now(), unique (workspace_id, version));
          insert into company_summary_versions (workspace_id, version, content_md, author, change_note, created_at) values
            ('w1', 1, 'old one', 'onboarding', 'first', '2026-11-01'),
            ('w1', 7, 'latest one', 'agent:ses_1', 'second', '2026-11-03'),
            ('w1', 5, 'old two', 'user:u', null, '2026-11-02'),
            ('w2', 1, 'only', 'user:u', null, '2026-11-04');
          ${block}`);
        const rows = async () =>
          (await client.query(`select workspace_id, content_md, version, updated_by, updated_at from ${schema}.company_summaries order by workspace_id`)).rows.map((r: any) => ({
            ...r,
            updated_at: new Date(r.updated_at).toISOString().slice(0, 10),
          }));
        const want = [
          { workspace_id: "w1", content_md: "latest one", version: 7, updated_by: "agent:ses_1", updated_at: "2026-11-03" },
          { workspace_id: "w2", content_md: "only", version: 1, updated_by: "user:u", updated_at: "2026-11-04" },
        ];
        expect(await rows()).toEqual(want);
        const gone = async () => (await client.query(`select to_regclass('${schema}.company_summary_versions') as t`)).rows[0].t;
        expect(await gone()).toBeNull();

        // Again: nothing to do, and later saves stay.
        await client.query(`
          set local search_path to ${schema};
          update company_summaries set content_md = 'saved since', version = 8 where workspace_id = 'w1';
          ${block}`);
        expect((await rows())[0]).toMatchObject({ content_md: "saved since", version: 8 });

        // An older checkout's migration brought the table back: what's current wins, and it goes again.
        await client.query(`
          set local search_path to ${schema};
          create table company_summary_versions (workspace_id text, version int, content_md text, author text, created_at timestamptz);
          insert into company_summary_versions values ('w1', 1, 'stale', 'onboarding', now()), ('w3', 1, 'new here', 'onboarding', '2026-11-05');
          ${block}`);
        expect(await rows()).toEqual([
          { ...want[0]!, content_md: "saved since", version: 8 },
          want[1]!,
          { workspace_id: "w3", content_md: "new here", version: 1, updated_by: "onboarding", updated_at: "2026-11-05" },
        ]);
        expect(await gone()).toBeNull();
      } finally {
        await client.query(`drop schema if exists ${schema} cascade`);
        await client.end();
      }
    });

    test("every tenant table has a NOT NULL workspace_id with no unassigned rows; the owner workspace exists", async () => {
      const tables = ["leads", "evidence", "lookalikes", "drafts", "approvals", "messages", "naive_sessions", "naive_session_events", "events",
        "suppressions", "api_keys", "billing_accounts", "credit_ledger", "crm_sync_queue", "company_summaries"];
      const cols = await sql`select table_name, is_nullable from information_schema.columns
                             where table_schema = 'public' and column_name = 'workspace_id' and table_name = any(${tables}::text[])`;
      expect(cols.map((c) => c.table_name).sort()).toEqual([...tables].sort());
      expect(cols.every((c) => c.is_nullable === "NO")).toBe(true);
      for (const t of tables) {
        const [r] = await sql.query(`select count(*)::int as n from ${t} where workspace_id is null`);
        expect({ t, n: r!.n }).toEqual({ t, n: 0 });
      }
      expect((await sql`select id from workspaces where id = 'ws_owner'`).length).toBe(1);
      const idx = (await sql`select indexname from pg_indexes where schemaname = 'public'`).map((r) => r.indexname as string);
      expect(idx).toEqual(expect.arrayContaining(["leads_ws_email_uq", "leads_ws_company_uq", "suppressions_ws_email_uq", "billing_accounts_ws_uq"]));
      // A user can belong to several workspaces.
      expect(idx).not.toContain("workspace_members_user_uq");
      expect(idx).not.toContain("leads_no_email_uq");
      expect((await sql`select 1 from pg_constraint where conname = 'leads_email_key'`).length).toBe(0);
      // At most one billing account and one free-sample grant per workspace.
      expect((await sql`select workspace_id from billing_accounts group by 1 having count(*) > 1`).length).toBe(0);
      expect((await sql`select workspace_id from credit_ledger where reason = 'grant' and source like 'signup:%' group by 1 having count(*) > 1`).length).toBe(0);
    });

    test("the billing merge: two accounts of one workspace become one, every ledger row kept, the duplicate free sample removed (1,027 left)", async () => {
      const ws = await createTestWorkspace(sql, `merge_${run}`);
      created.push(ws);
      // The production shape before the migration: 'owner' (MCP_TOKEN) with the Stripe customer and the purchase, and the
      // owner's Clerk user with only a free sample, both already backfilled to the same workspace. Two accounts in one
      // workspace can only exist before the unique index, so this transaction lifts it, merges, and restores it.
      const legacyOwner = `owner_it_${run}`;
      const legacyUser = `user_it_${run}_merge`;
      const rows = [
        [legacyOwner, 300, "grant", `signup:${legacyOwner}`],
        [legacyOwner, 1000, "pack", `checkout:cs_it_${run}_merge`],
        [legacyOwner, -15, "usage", `usage:ses_it_${run}_m1`],
        [legacyOwner, -163, "usage", `usage:ses_it_${run}_m2`],
        [legacyOwner, -64, "usage", `usage:ses_it_${run}_m3`],
        [legacyOwner, -31, "usage", `usage:ses_it_${run}_m4`],
        [legacyUser, 300, "grant", `signup:${legacyUser}`],
      ] as const;
      const ledgerJson = JSON.stringify(rows.map(([owner_id, amount, reason, source]) => ({ owner_id, amount, reason, source })));
      const out = await sql.transaction([
        sql`drop index billing_accounts_ws_uq`,
        sql`insert into billing_accounts (owner_id, workspace_id, stripe_customer_id, created_at)
            values (${legacyOwner}, ${ws}, ${`cus_it_${run}_merge`}, now() - interval '2 days'),
                   (${legacyUser}, ${ws}, null, now() - interval '1 day')`,
        sql`insert into credit_ledger (workspace_id, owner_id, amount, reason, source)
            select ${ws}, x.owner_id, x.amount, x.reason, x.source
            from jsonb_to_recordset(${ledgerJson}::jsonb) as x(owner_id text, amount bigint, reason text, source text)`,
        sql`select coalesce(sum(amount), 0)::int as balance from credit_ledger where workspace_id = ${ws}`,
        sql`select crusonia_merge_billing(${ws}) as result`,
        sql`create unique index billing_accounts_ws_uq on billing_accounts (workspace_id)`,
      ]);
      expect(out[3]![0]!.balance).toBe(1327);
      const result = out[4]![0]!.result as any;
      expect(result.kept_account).toBe(legacyOwner);
      expect(result.merged_accounts).toEqual([expect.objectContaining({ owner_id: legacyUser, stripe_customer_id: null })]);
      expect(result.removed_duplicate_grants).toEqual([expect.objectContaining({ source: `signup:${legacyUser}`, amount: 300 })]);
      expect(await getBalance(sql, ws)).toBe(1027);
      const accounts = await sql`select owner_id, stripe_customer_id from billing_accounts where workspace_id = ${ws}`;
      expect(accounts).toEqual([{ owner_id: legacyOwner, stripe_customer_id: `cus_it_${run}_merge` }]);
      const sources = (await sql`select source from credit_ledger where workspace_id = ${ws} order by id`).map((r) => r.source);
      expect(sources).toEqual(rows.filter(([o, , reason]) => !(o === legacyUser && reason === "grant")).map(([, , , s]) => s));
      const [audit] = await sql`select data from events where workspace_id = ${ws} and kind = 'billing_merged'`;
      expect(audit!.data).toMatchObject({ kept_account: legacyOwner, merged_accounts: [{ owner_id: legacyUser }] });
      // Idempotent: a second run changes nothing.
      await sql`select crusonia_merge_billing(${ws})`;
      expect(await getBalance(sql, ws)).toBe(1027);
      expect((await sql`select count(*)::int as n from events where workspace_id = ${ws} and kind = 'billing_merged'`)[0]!.n).toBe(1);
      // The ledger stays append-only outside the merge.
      await expect(Promise.resolve(sql`delete from credit_ledger where workspace_id = ${ws}`)).rejects.toThrow(/append-only/);
    });

    test("lead dedupe is per workspace; a company is stored once per workspace by its normalized domain", async () => {
      // Same email in two workspaces: two leads. Twice in one: refused.
      expect((await call(keyA, "POST", "/api/leads", { email: b.email, name: "Bea in A" })).status).toBe(201);
      expect((await call(keyA, "POST", "/api/leads", { email: b.email })).status).toBe(409);
      const d = `acme-${run}.test`;
      const added = await addLeads(sql, A, [
        { company: "Acme", website: `https://www.${d}/about`, source: "it", source_url: "https://example.com/a" },
        { company: "Acme Inc", domain: `APP.${d.toUpperCase()}`, source: "it", source_url: "https://example.com/b" },
        { name: "Pat Lee", domain: `blog.${d}`, source: "it", source_url: "https://example.com/c" },
      ]);
      // The second and third are the same company (its subdomains): merged into one lead, the person as a contact.
      expect(added.counts).toEqual({ created: 1, merged: 2, known: 0, skipped: 0 });
      const rowsA = await sql`select domain, contacts from leads where workspace_id = ${A} and domain = ${d}`;
      expect(rowsA).toHaveLength(1);
      expect((rowsA[0]!.contacts as { name: string }[]).map((c) => c.name)).toContain("Pat Lee");
      // Another workspace has its own copy of the company.
      expect((await addLeads(sql, B, [{ company: "Acme", domain: d, source: "it", source_url: "https://example.com/a" }])).counts.created).toBe(1);
      // Whatever writes a lead, the database stores the normalized domain, and a second company row is refused.
      const raw = `raw-${d}`;
      await sql`insert into leads (id, workspace_id, name, domain, source, variant, stage) values (${`lead_it_${run}_raw`}, ${A}, 'Raw', ${`https://WWW.Shop.${raw.toUpperCase()}/x`}, 'it', 'A', 'no_consent')`;
      expect((await sql`select domain from leads where id = ${`lead_it_${run}_raw`}`)[0]!.domain).toBe(raw);
      await expect(
        Promise.resolve(sql`insert into leads (id, workspace_id, name, domain, source, variant, stage) values (${`lead_it_${run}_dup`}, ${A}, 'Other name', ${`www.${raw}`}, 'it', 'A', 'no_consent')`),
      ).rejects.toThrow(/leads_ws_company_uq/);
    });
  });

  // ---------- first sign-in ----------

  describe("first sign-in", () => {
    test("a new Clerk user gets a private workspace with the free credits, once, even with concurrent first requests", async () => {
      const user = `user_it_${run}_new`;
      const token = await clerkToken(user);
      const results = await Promise.all([1, 2, 3].map(() => call(token, "GET", "/api/me")));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      const ids = new Set(results.map((r) => r.body.workspace.id));
      expect(ids.size).toBe(1);
      const ws = [...ids][0] as string;
      created.push(ws);
      expect(ws).not.toBe("ws_owner");
      expect(results[0]!.body.workspace).toMatchObject({ owner: false });
      expect((await sql`select workspace_id, role from workspace_members where clerk_user_id = ${user}`)).toEqual([{ workspace_id: ws, role: "owner" }]);
      const billing = await call(token, "GET", "/api/billing");
      expect(billing.body).toMatchObject({ workspace_id: ws, balance: 300, billing: { enforced: true } });
      expect(billing.body.ledger.map((r: any) => r.source)).toEqual([`signup:${ws}`]);
      // Later sign-ins: the same workspace, no second grant.
      expect((await call(token, "GET", "/api/me")).body.workspace.id).toBe(ws);
      expect(await getBalance(sql, ws)).toBe(300);
      expect((await sql`select count(*)::int as n from events where workspace_id = ${ws} and kind = 'workspace_created'`)[0]!.n).toBe(1);
    });

    test("SIGNUPS_OPEN=false refuses new users but lets members in; BLOCKED_USER_IDS is refused; the owner user maps to the owner workspace", async () => {
      const closed = env({ SIGNUPS_OPEN: "false" });
      const stranger = await clerkToken(`user_it_${run}_late`);
      const r = await call(stranger, "GET", "/api/me", undefined, closed);
      expect(r).toMatchObject({ status: 403, body: { error: { code: "signups_closed" } } });
      expect((await sql`select 1 from workspace_members where clerk_user_id = ${`user_it_${run}_late`}`).length).toBe(0);
      const member = await clerkToken(`user_it_${run}_a`);
      expect((await call(member, "GET", "/api/me", undefined, closed)).body.workspace.id).toBe(A);
      const blocked = await call(member, "GET", "/api/me", undefined, env({ BLOCKED_USER_IDS: `x, user_it_${run}_a` }));
      expect(blocked).toMatchObject({ status: 403, body: { error: { code: "account_blocked" } } });
      // OWNER_CLERK_USER_ID is the owner workspace, whatever else the user has.
      const ownerUser = `user_it_${run}_owner`;
      const me = await call(await clerkToken(ownerUser), "GET", "/api/me", undefined, env({ OWNER_CLERK_USER_ID: ownerUser }));
      expect(me.body.workspace).toEqual({ id: "ws_owner", name: expect.any(String), owner: true, role: "owner" });
      await sql`delete from workspace_members where clerk_user_id = ${ownerUser}`;
    });
  });

  // ---------- isolation: every /api route ----------

  describe("isolation: workspace A cannot read or change workspace B through /api", () => {
    test("leads", async () => {
      expect((await call(keyA, "GET", "/api/leads?limit=200")).body.data.map((l: any) => l.id)).not.toContain(b.lead);
      expect((await call(keyA, "GET", `/api/leads/${b.lead}`)).status).toBe(404);
      expect((await call(keyA, "PATCH", `/api/leads/${b.lead}`, { name: "hijacked" })).status).toBe(404);
      expect((await call(keyA, "DELETE", `/api/leads/${b.lead}`)).status).toBe(404);
      expect((await call(keyA, "POST", `/api/leads/${b.lead}/drafts`, { subject: "x", body: "y" })).status).toBe(404);
      const imported = await call(keyA, "POST", "/api/leads/import", { csv: `email,name,title\n${b.email},Imported,CEO\n` });
      expect(imported.body).toMatchObject({ created: 0, updated: 1 }); // A's own lead with that email (title filled), not B's
      const still = await call(keyB, "GET", `/api/leads/${b.lead}`);
      expect(still.body.lead).toMatchObject({ name: "Bea", stage: "awaiting_approval" });
    });

    test("approvals", async () => {
      expect((await call(keyA, "GET", "/api/approvals")).body.data.map((a: any) => a.code)).not.toContain(b.code);
      expect((await call(keyA, "GET", `/api/approvals/${b.code}`)).status).toBe(404);
      const personA = await clerkToken(`user_it_${run}_a`);
      for (const action of ["approve", "reject", "edit", "answer"]) {
        expect({ action, status: (await call(personA, "POST", `/api/approvals/${b.code}/${action}`, {})).status }).toEqual({ action, status: 404 });
        // API keys never decide approvals, in any workspace (src/api/guards.ts).
        expect({ action, status: (await call(keyB, "POST", `/api/approvals/${b.code}/${action}`, {})).status }).toEqual({ action, status: 403 });
      }
      expect((await call(keyB, "GET", `/api/approvals/${b.code}`)).body.approval).toMatchObject({ status: "pending" });
    });

    test("workflows, runs and onboarding sessions", async () => {
      const runs = (await call(keyA, "GET", "/api/workflows?runs=50")).body.data.flatMap((w: any) => w.runs.map((r: any) => r.id));
      expect(runs).not.toContain(b.session);
      expect((await call(keyA, "GET", `/api/workflows/runs/${b.session}`)).status).toBe(404);
      expect((await call(keyA, "GET", `/api/onboarding/propose/${b.session}`)).status).toBe(404);
      const research = await call(keyA, "POST", "/api/workflows/research", { lead_ids: [b.lead] });
      expect(research.body).toEqual({ started: [], skipped: [{ lead_id: b.lead, reason: "not_found" }], failed: [] });
      expect((await call(keyB, "GET", `/api/workflows/runs/${b.session}`, undefined, env({ NAIVE_API_KEY: undefined }))).status).toBe(200);
    });

    test("suppressions and the pause switch", async () => {
      expect((await call(keyA, "GET", "/api/suppressions")).body.data.map((s: any) => s.email)).not.toContain(b.suppressed);
      expect((await call(await clerkToken(`user_it_${run}_a`), "DELETE", `/api/suppressions/${encodeURIComponent(b.suppressed)}`)).status).toBe(404);
      expect((await call(keyB, "DELETE", `/api/suppressions/${encodeURIComponent(b.suppressed)}`)).status).toBe(403);
      expect((await call(keyA, "PUT", "/api/settings/pause", { paused: true })).body).toEqual({ paused: true });
      expect((await call(keyB, "GET", "/api/settings/pause")).body).toEqual({ paused: false });
      // Resuming takes a person (src/api/guards.ts): a key is refused and the workspace stays paused.
      const refused = await call(keyA, "PUT", "/api/settings/pause", { paused: false });
      expect([refused.status, refused.body.error.code]).toEqual([403, "human_required"]);
      expect((await call(keyA, "GET", "/api/settings/pause")).body).toEqual({ paused: true });
      expect((await call(await clerkToken(`user_it_${run}_a`), "PUT", "/api/settings/pause", { paused: false })).body).toEqual({ paused: false });
      expect((await call(keyB, "GET", "/api/suppressions")).body.data.map((s: any) => s.email)).toContain(b.suppressed);
    });

    test("API keys", async () => {
      expect((await call(keyA, "GET", "/api/keys")).body.data.map((k: any) => k.id)).not.toContain(b.keyId);
      expect((await call(await clerkToken(`user_it_${run}_a`), "DELETE", `/api/keys/${b.keyId}`)).status).toBe(404);
      expect((await call(keyB, "DELETE", `/api/keys/${b.keyId}`)).status).toBe(403); // a key can't revoke (or mint) keys
      expect((await call(keyB, "GET", "/api/me")).status).toBe(200); // still valid
      // A key never reaches another workspace's MCP URL.
      expect((await tool(keyB, "get_status", {}, `/mcp?ws=${A}`)).status).toBe(403);
    });

    test("Company summary and profile", async () => {
      const a = await call(keyA, "GET", "/api/company-summary");
      expect(a.body).toMatchObject({ markdown: null, version: 0 });
      expect(a.body.template).toContain("## What we sell");
      expect((await call(keyA, "GET", "/api/profile")).body).toEqual({ profile: null });
      expect((await call(keyB, "GET", "/api/company-summary")).body).toMatchObject({ version: 1, markdown: expect.stringContaining("B things") });
    });

    test("billing, dashboard, replies and status", async () => {
      const billing = await call(keyA, "GET", "/api/billing");
      expect(billing.body.workspace_id).toBe(A);
      expect(billing.body.ledger.map((r: any) => r.source)).not.toContain(`adjustment:ws-it-${run}-b`);
      expect(billing.body.balance).not.toBe(777);
      const summary = await call(keyA, "GET", "/api/summary");
      expect(summary.body.pending_approvals.map((p: any) => p.code)).not.toContain(b.code);
      expect((await call(keyA, "GET", "/api/replies")).body.data.map((r: any) => r.lead_id)).not.toContain(b.lead);
      expect((await call(keyB, "GET", "/api/replies")).body.data.map((r: any) => r.lead_id)).toContain(b.lead);
      const status = await call(keyA, "GET", "/api/status");
      expect(status.body).toMatchObject({ workspace_id: A, agent_mcp_url: `https://example.test/mcp?ws=${A}`, crm_sync: { available: false } });
    });

    test("CRM sync is the owner workspace's only", async () => {
      expect((await call(keyA, "GET", "/api/integrations/crm")).body).toMatchObject({ available: false, hubspot: { configured: false } });
      expect((await call(keyA, "POST", "/api/integrations/sync", { target: "hubspot" })).status).toBe(403);
      expect((await call(keyA, "POST", "/api/integrations/hubspot/import", {})).status).toBe(403);
      // The events trigger never queues another workspace's leads.
      await sql`insert into settings (key, value) values ('crm_sync_targets', '["hubspot"]'::jsonb) on conflict (key) do update set value = excluded.value`;
      try {
        await call(keyB, "PATCH", `/api/leads/${b.lead}`, { title: "CTO" });
        expect((await sql`select count(*)::int as n from crm_sync_queue where lead_id = ${b.lead}`)[0]!.n).toBe(0);
      } finally {
        await sql`update settings set value = '[]'::jsonb where key = 'crm_sync_targets'`;
      }
    });
  });

  // ---------- isolation: every MCP tool ----------

  describe("isolation: workspace A cannot read or change workspace B through MCP", () => {
    test("leads, evidence, scores, drafts and approvals", async () => {
      expect((await tool(keyA, "list_leads", { limit: 200 })).data.leads.map((l: any) => l.id)).not.toContain(b.lead);
      expect((await tool(keyA, "get_lead", { lead_id: b.lead })).error).toContain("No lead");
      expect((await tool(keyA, "save_evidence", { lead_id: b.lead, claim: "x", source_url: "https://example.com/x" })).error).toContain("No lead");
      expect((await tool(keyA, "score_lead", { lead_id: b.lead, score: 1, rationale: "x", qualified: false })).error).toContain("No lead");
      expect((await tool(keyA, "create_draft", { lead_id: b.lead, subject: "x", body: "y" })).error).toContain("No lead");
      expect((await tool(keyA, "list_pending_approvals")).data.approvals.map((a: any) => a.code)).not.toContain(b.code);
      // add_leads with B's lead's email creates (or updates) A's own lead.
      const added = (await tool(keyA, "add_leads", { leads: [{ email: b.email, source: "it", source_url: "https://example.com/p" }] })).data;
      expect(added.results[0].id).not.toBe(b.lead);
      const bLead = (await tool(keyB, "get_lead", { lead_id: b.lead })).data;
      expect(bLead.lead).toMatchObject({ id: b.lead, score: null });
      expect(bLead.evidence).toEqual([]);
    });

    test("status, Company summary and the profile aliases", async () => {
      const statusA = (await tool(keyA, "get_status")).data;
      const statusB = (await tool(keyB, "get_status")).data;
      expect(statusA.database.pending_approvals).toBe(0);
      expect(statusB.database.pending_approvals).toBe(1);
      expect((await tool(keyA, "get_company_summary")).data).toMatchObject({ version: 0, markdown: null });
      const write = (await tool(keyA, "update_company_summary", { markdown: "# A Inc\n\n## Avoid\n\nAgencies" })).data;
      expect(write).toMatchObject({ version: 1, updated_by: expect.stringMatching(/^agent:api_key:/), unchanged: false });
      expect((await tool(keyB, "get_company_summary")).data).toMatchObject({ version: 1, markdown: expect.stringContaining("B things") });
      const profile = (await tool(keyA, "get_profile")).data;
      expect(profile).toMatchObject({ profile: { company: "A Inc" }, version: 1 });
      await tool(keyA, "save_profile", { company: "A Inc", sells: "Widgets", icp_description: "Plants" });
      expect((await tool(keyB, "get_profile")).data.profile).toMatchObject({ company: "B Corp", sells: "B things" });
    });
  });

  // ---------- variants, cohorts and workflow versions ----------

  test("each lead keeps a deterministic variant and the cohort that brought it in; drafts and runs record the workflow version", async () => {
    const ws = await createTestWorkspace(sql, `cohort_${run}`);
    created.push(ws);
    const key = await testKey(sql, ws, "agent");
    // A CSV import is one cohort.
    const csv = await call(key, "POST", "/api/leads/import", { csv: `email,name\nc1-${run}@it.example.com,One\nc2-${run}@it.example.com,Two\n` });
    expect(csv.body.cohort).toMatch(/^import:imp_/);
    const imported = await sql`select cohort, variant from leads where workspace_id = ${ws} and email like ${`c_-${run}@it.example.com`}`;
    expect(new Set(imported.map((r) => r.cohort))).toEqual(new Set([csv.body.cohort]));
    // Leads an agent run finds are that run's cohort; the run records its workflow version.
    await sql`insert into naive_sessions (id, workspace_id, purpose, status, input, workflow_version)
              values (${`ses_ws_${run}_find`}, ${ws}, 'find_leads', 'done', ${JSON.stringify({ run_id: `run_${run}_find` })}::jsonb, 'research@3, agent v7')`;
    const found = (await tool(key, "add_leads", { run_id: `run_${run}_find`, leads: [{ email: `c3-${run}@it.example.com`, source: "it", source_url: "https://example.com/x" }] })).data;
    const leadId = found.results[0].id as string;
    expect((await sql`select cohort from leads where id = ${leadId}`)[0]!.cohort).toBe(`run:ses_ws_${run}_find`);
    // Re-adding it later (another batch) changes neither its cohort nor its variant; the variant is the same in any workspace.
    const before = (await sql`select variant from leads where id = ${leadId}`)[0]!.variant;
    await tool(key, "add_leads", { leads: [{ email: `c3-${run}@it.example.com`, title: "CEO", source: "it", source_url: "https://example.com/y" }] });
    expect((await sql`select cohort, variant, title from leads where id = ${leadId}`)[0]).toEqual({ cohort: `run:ses_ws_${run}_find`, variant: before, title: "CEO" });
    await tool(keyA, "add_leads", { leads: [{ email: `c3-${run}@it.example.com`, source: "it", source_url: "https://example.com/z" }] });
    expect((await sql`select variant from leads where workspace_id = ${A} and email = ${`c3-${run}@it.example.com`}`)[0]!.variant).toBe(before);
    // A draft written in a run records the run and its workflow version; one written by a person records none.
    // Consent is a person's decision (an API key gets 403 human_required, src/api/guards.ts): grant it as the owner would.
    await patchLead(sql, ws, leadId, { consent: { text: "opted in" } }, "test");
    await sql`insert into naive_sessions (id, workspace_id, lead_id, purpose, status, input, workflow_version)
              values (${`ses_ws_${run}_res`}, ${ws}, ${leadId}, 'research', 'running', ${JSON.stringify({ run_id: `run_${run}_res` })}::jsonb, 'research@3, agent v8')`;
    const draft = (await tool(key, "create_draft", { run_id: `run_${run}_res`, lead_id: leadId, subject: "Hi", body: "Body" })).data.draft;
    expect(draft).toMatchObject({ session_id: `ses_ws_${run}_res`, workflow_version: "research@3, agent v8", variant: before });
    const manual = (await call(key, "POST", `/api/leads/${leadId}/drafts`, { subject: "Hi 2", body: "Body" })).body.draft;
    expect(manual).toMatchObject({ session_id: null, workflow_version: null });
    const runs = (await call(key, "GET", "/api/workflows?runs=10", undefined, env({ NAIVE_API_KEY: undefined }))).body.data;
    expect(runs.flatMap((w: any) => w.runs).find((r: any) => r.id === `ses_ws_${run}_find`)).toMatchObject({ workflow_version: "research@3, agent v7" });
  });

  // ---------- the Company summary ----------

  describe("Company summary", () => {
    test("a save overwrites: unchanged saves, sections, conflicts, the size cap, and no history", async () => {
      const ws = await createTestWorkspace(sql, `sum_${run}`, { clerkUserId: `user_it_${run}_sum` });
      created.push(ws);
      const user = await clerkToken(`user_it_${run}_sum`);
      const first = await call(user, "PUT", "/api/company-summary", { markdown: "# Sum Co\n\n## What we sell\n\nSoftware\n\n## Avoid\n", base_version: 0 });
      expect(first.body).toMatchObject({ version: 1, updated_by: `user:user_it_${run}_sum`, unchanged: false });
      expect(first.body.updated_at).toEqual(expect.any(String));
      const same = await call(user, "PUT", "/api/company-summary", { markdown: "# Sum Co\n\n## What we sell\n\nSoftware\n\n## Avoid", base_version: 1 });
      expect(same.body).toMatchObject({ version: 1, unchanged: true });

      // An agent replaces one section: the rest of the document stays.
      const key = await testKey(sql, ws, "agent");
      const sec = (await tool(key, "update_company_summary", { section: "Avoid", markdown: "- Agencies\n- Companies over 500 people" })).data;
      expect(sec.version).toBe(2);
      const second = await call(user, "GET", "/api/company-summary");
      expect(second.body.markdown).toBe("# Sum Co\n\n## What we sell\n\nSoftware\n\n## Avoid\n\n- Agencies\n- Companies over 500 people");
      expect(second.body.updated_by).toMatch(/^agent:api_key:key_/);
      // A missing section is appended. An agent on an older playbook may still send a note: it is dropped, not stored.
      await tool(key, "update_company_summary", { section: "Proof points", markdown: "Used by Acme", note: "new customer" });
      expect((await call(user, "GET", "/api/company-summary")).body.markdown).toEndWith("## Proof points\n\nUsed by Acme");

      // The stale-write check (also before there is a row) and the size cap.
      const stale = await call(user, "PUT", "/api/company-summary", { markdown: "stale", base_version: 1 });
      expect([stale.status, stale.body.error.code, stale.body.error.details.current_version]).toEqual([409, "version_conflict", 3]);
      expect((await call(user, "PUT", "/api/company-summary", { markdown: "x".repeat(20_001) })).status).toBe(413);
      const empty = await createTestWorkspace(sql, `sum2_${run}`);
      created.push(empty);
      expect((await call(await testKey(sql, empty), "PUT", "/api/company-summary", { markdown: "# New", base_version: 2 })).status).toBe(409);

      // Of two saves from the same version, one lands.
      const raced = await Promise.all(["# One", "# Two"].map((markdown) => call(user, "PUT", "/api/company-summary", { markdown, base_version: 3 })));
      expect(raced.map((r) => r.status).sort()).toEqual([200, 409]);

      // One row, however many saves: no history, and the old routes are gone.
      expect((await sql`select count(*)::int as n from company_summaries where workspace_id = ${ws}`)[0]!.n).toBe(1);
      for (const [method, path] of [["GET", "/api/company-summary/versions"], ["GET", "/api/company-summary/versions/1"], ["POST", "/api/company-summary/revert"]] as const) {
        expect({ path, status: (await call(user, method, path, method === "POST" ? { version: 1 } : undefined)).status }).toEqual({ path, status: 404 });
      }
      expect((await tool(key, "list_summary_versions")).error).toContain("list_summary_versions");
      // The feed logs that it changed, without the text.
      const logged = await sql`select data from events where workspace_id = ${ws} and kind = 'company_summary_updated'`;
      expect(logged).toHaveLength(4);
      expect(logged.some((e) => (e.data as { author?: string }).author?.startsWith("agent:"))).toBe(true);
      expect(logged.some((e) => "note" in (e.data as object))).toBe(false);

      // /api/profile maps both ways and keeps the sections a profile has no field for.
      await tool(key, "update_company_summary", { section: "Voice", markdown: "Plain, short, no hype." });
      const put = await call(user, "PUT", "/api/profile", {
        company: "Sum Co",
        website: "sum.example",
        sells: "Scheduling software",
        icp_description: "Clinics",
        segments: [{ name: "Dental", company_size: "10-50", industry: "Health", roles: ["Owner", "Office manager"] }],
        signals: [{ name: "Opening a second site", description: "Job posts for a new location" }],
        sources: [{ field: "sells", url: "https://sum.example/" }],
      });
      expect(put.body.profile).toMatchObject({
        company: "Sum Co",
        website: "https://sum.example",
        sells: "Scheduling software",
        icp_description: "Clinics",
        segments: [{ name: "Dental", company_size: "10-50", industry: "Health", roles: ["Owner", "Office manager"] }],
        signals: [{ name: "Opening a second site", description: "Job posts for a new location" }],
        sources: [{ field: "sells", url: "https://sum.example/" }],
      });
      const md = (await call(user, "GET", "/api/company-summary")).body.markdown as string;
      expect(md).toContain("## Voice\n\nPlain, short, no hype.");
      expect(md).toContain("- **Dental**: 10-50; Health; roles: Owner, Office manager");
      expect((await call(user, "GET", "/api/profile")).body.profile).toEqual(put.body.profile);
    });

    test("an agent run's edit is attributed to its session (run id), or to 'onboarding' for an onboarding run", async () => {
      const ws = await createTestWorkspace(sql, `auth_${run}`);
      created.push(ws);
      const key = await testKey(sql, ws, "agent");
      await sql`insert into naive_sessions (id, workspace_id, purpose, status, input) values
        (${`ses_ws_${run}_r1`}, ${ws}, 'research', 'running', ${JSON.stringify({ run_id: `run_${run}_1` })}::jsonb),
        (${`ses_ws_${run}_o1`}, ${ws}, 'onboarding', 'running', ${JSON.stringify({ run_id: `run_${run}_2` })}::jsonb)`;
      expect((await tool(key, "update_company_summary", { markdown: "# X", run_id: `run_${run}_1` })).data.updated_by).toBe(`agent:ses_ws_${run}_r1`);
      expect((await tool(key, "update_company_summary", { markdown: "# Y", run_id: `run_${run}_2` })).data.updated_by).toBe("onboarding");
      // A run id of another workspace means nothing here.
      expect((await tool(key, "update_company_summary", { markdown: "# Z", run_id: "run_unknown" })).data.updated_by).toMatch(/^agent:api_key:/);
    });
  });

  // ---------- credits and limits ----------

  describe("credits and limits for workspaces other than the owner's", () => {
    test("paid work needs credits even with BILLING_ENFORCED off; MCP_TOKEN (the owner workspace) is not gated", async () => {
      const ws = await createTestWorkspace(sql, `broke_${run}`);
      created.push(ws);
      const key = await testKey(sql, ws);
      const e = env({ BILLING_ENFORCED: undefined, BILLING_FREE_CREDITS: "0" });
      for (const [path, body] of [
        ["/api/workflows/research", { lead_ids: ["lead_missing"] }],
        ["/api/leads/find", { count: 5 }],
        ["/api/onboarding/propose", { url: "acme.example" }],
      ] as const) {
        expect({ path, ...(await call(key, "POST", path, body, e)) }).toMatchObject({ path, status: 402, body: { error: { code: "insufficient_credits" } } });
      }
      // Web reads through the instance's Apify account need credits too (refused before any Apify call).
      const apify = env({ APIFY_TOKEN: "apify_test_not_called" });
      expect((await tool(key, "search_web", { query: "gtm engineers" }, "/mcp", apify)).error).toContain("need credits");
      expect((await tool(key, "read_website", { url: "https://example.com" }, "/mcp", apify)).error).toContain("need credits");
      expect((await call(key, "POST", "/api/onboarding/read-website", { url: "https://example.com" }, apify)).status).toBe(402);
      const ownerResearch = await call(`it-owner-${run}`, "POST", "/api/workflows/research", { lead_ids: ["lead_missing"] }, e);
      expect(ownerResearch.status).toBe(200);
    });

    test("rate limits and the daily spend cap", async () => {
      const ws = await createTestWorkspace(sql, `busy_${run}`);
      created.push(ws);
      const e = env({ PAID_STARTS_PER_HOUR: "3", MAX_ACTIVE_SESSIONS: "10", WORKSPACE_DAILY_CAP_USD: "1" });
      expect((await paidStartAllowance(sql, e, ws, 5)).allowed).toBe(3);
      await sql`insert into naive_sessions (id, workspace_id, purpose, status, consumed_micro_usd) values
        (${`ses_ws_${run}_l1`}, ${ws}, 'research', 'done', 100000), (${`ses_ws_${run}_l2`}, ${ws}, 'research', 'done', 100000)`;
      expect(await paidStartAllowance(sql, e, ws, 5)).toMatchObject({ allowed: 1, reason: "rate_limited" });
      await sql`update naive_sessions set consumed_micro_usd = 600000 where workspace_id = ${ws}`;
      expect(await paidStartAllowance(sql, e, ws, 1)).toMatchObject({ allowed: 0, reason: "daily_cap_reached" });
      // A per-workspace cap overrides the default.
      await sql`update workspaces set daily_cap_micro_usd = 5000000 where id = ${ws}`;
      expect((await paidStartAllowance(sql, e, ws, 1)).allowed).toBe(1);
      // Through a route: research skips what the limits do not allow, and says why.
      const key = await testKey(sql, ws);
      await addLedgerRow(sql, { workspaceId: ws, amount: 100, reason: "adjustment", source: `adjustment:ws-it-${run}-busy` });
      await sql`update workspaces set naive_agent_id = 'agt_ws_copy', naive_credential_id = 'vcr_x', naive_synced_at = now() + interval '1 hour', daily_cap_micro_usd = 1 where id = ${ws}`;
      const lead = (await call(key, "POST", "/api/leads", { email: `busy-${run}@it.example.com` })).body.lead.id;
      expect((await call(key, "POST", "/api/workflows/research", { lead_ids: [lead] }, e)).body).toEqual({
        started: [],
        skipped: [{ lead_id: lead, reason: "daily_cap_reached" }],
        failed: [],
      });
      expect((await call(key, "POST", "/api/leads/find", { count: 5 }, e)).status).toBe(409); // no summary yet: checked first
      await call(key, "PUT", "/api/company-summary", { markdown: "# Busy" });
      expect((await call(key, "POST", "/api/leads/find", { count: 5 }, e)).body.error.code).toBe("daily_cap_reached");
    });
  });

  // ---------- webhooks ----------

  test("an AgentMail reply maps to the workspace of its thread; a sender in two workspaces stays unmatched", async () => {
    // B's lead was emailed on a thread: a reply on it updates B only.
    const thread = `thr_ws_${run}_out`;
    await sql`insert into messages (workspace_id, lead_id, direction, provider_message_id, thread_id, to_addr) values (${B}, ${b.lead}, 'out', ${`ws-${run}-out`}, ${thread}, ${b.email})`;
    const reply = await handleAgentMailEvent(sql, {
      event_id: `ws-${run}-e1`,
      event_type: "message.received",
      message: { thread_id: thread, message_id: `ws-${run}-in1`, from: b.email, subject: "Re", extracted_text: "Please unsubscribe me" },
    });
    expect(reply.detail).toMatchObject({ lead_id: b.lead, matched_by: "thread", label: "unsubscribe" });
    expect((await sql`select workspace_id from suppressions where email = ${b.email}`).map((r) => r.workspace_id)).toEqual([B]);
    expect((await sql`select stage from leads where workspace_id = ${A} and email = ${b.email}`)[0]!.stage).not.toBe("unsubscribed");
    // The address is also a lead in A, but only B has emailed it: adding a lead does not route that person's mail,
    // so a new thread from it is B's.
    const loose = await handleAgentMailEvent(sql, {
      event_id: `ws-${run}-e2`,
      event_type: "message.received",
      message: { thread_id: `thr_ws_${run}_new`, message_id: `ws-${run}-in2`, from: b.email, subject: "Hello", text: "hi" },
    });
    expect(loose.detail).toMatchObject({ lead_id: b.lead, matched_by: "sender" });
    // Once A has emailed it too, a new thread from it cannot say whose it is: unmatched, kept in the owner workspace.
    const aLead = (await sql`select id from leads where workspace_id = ${A} and email = ${b.email}`)[0]!.id as string;
    await sql`insert into messages (workspace_id, lead_id, direction, provider_message_id, thread_id, to_addr) values (${A}, ${aLead}, 'out', ${`ws-${run}-out-a`}, ${`thr_ws_${run}_out_a`}, ${b.email})`;
    const ambiguous = await handleAgentMailEvent(sql, {
      event_id: `ws-${run}-e3`,
      event_type: "message.received",
      message: { thread_id: `thr_ws_${run}_new3`, message_id: `ws-${run}-in3`, from: b.email, subject: "Hello again", text: "hi" },
    });
    expect(ambiguous.detail).toMatchObject({ matched: false });
    expect((await sql`select workspace_id from messages where provider_message_id = ${`ws-${run}-in3`}`)[0]!.workspace_id).toBe("ws_owner");
    await sql`delete from messages where provider_message_id = ${`ws-${run}-in3`}`;
  });

  // ---------- platform admins ----------

  describe("platform admins", () => {
    test("non-admins get 403; admin reads are cross-workspace, read-only and audited in the viewed workspace", async () => {
      const adminUser = `user_it_${run}_admin`;
      const adminWs = await createTestWorkspace(sql, `admin_${run}`, { clerkUserId: adminUser });
      created.push(adminWs);
      const e = env({ PLATFORM_ADMIN_USER_IDS: `someone, ${adminUser}` });
      const admin = await clerkToken(adminUser);
      const member = await clerkToken(`user_it_${run}_a`);

      expect((await call(member, "GET", `/api/admin/runs?workspace=${B}`, undefined, e)).status).toBe(403);
      expect((await call(keyA, "GET", `/api/admin/runs?workspace=${B}`, undefined, e)).status).toBe(403);
      expect((await call(`it-owner-${run}`, "GET", `/api/admin/runs/${b.session}/trace`, undefined, e)).status).toBe(403);

      await sql`insert into naive_session_events (workspace_id, session_id, seq, type, data, created_at)
                values (${B}, ${b.session}, 1, 'message.completed', '{"role":"user","content":"Research lead"}'::jsonb, now())`;
      const runs = await call(admin, "GET", `/api/admin/runs?workspace=${B}`, undefined, e);
      expect(runs.status).toBe(200);
      expect(runs.body.workspace.id).toBe(B);
      expect(runs.body.data.map((r: any) => r.id)).toContain(b.session);
      const trace = await call(admin, "GET", `/api/admin/runs/${b.session}/trace`, undefined, e);
      expect(trace.status).toBe(200);
      expect(trace.body).toMatchObject({ workspace_id: B, run: { id: b.session }, sync: { skipped: expect.stringContaining("read-only") } });
      expect(trace.body.events).toEqual([expect.objectContaining({ seq: 1, type: "message.completed" })]);
      const audit = await sql`select kind, data from events where workspace_id = ${B} and kind = 'admin_viewed' order by id`;
      expect(audit.map((r) => r.data)).toEqual([
        expect.objectContaining({ admin: `clerk:${adminUser}`, what: "runs" }),
        expect.objectContaining({ admin: `clerk:${adminUser}`, what: "trace", session_id: b.session }),
      ]);
      // Everywhere else the admin is a normal user of their own workspace.
      expect((await call(admin, "GET", `/api/workflows/runs/${b.session}`, undefined, e)).status).toBe(404);
      expect((await call(admin, "GET", `/api/leads/${b.lead}`, undefined, e)).status).toBe(404);
      // OWNER_CLERK_USER_ID is a platform admin by default.
      const ownerAdmin = await call(admin, "GET", `/api/admin/runs?workspace=${B}`, undefined, env({ OWNER_CLERK_USER_ID: adminUser }));
      expect(ownerAdmin.status).toBe(200);
    });
  });

  // ---------- the per-workspace Naive agent ----------

  test("a workspace's first paid run creates its own agent: the template's config, its own MCP URL, a bound credential with a workspace key", async () => {
    const ws = await createTestWorkspace(sql, `agent_${run}`);
    created.push(ws);
    const calls: { method: string; url: string; body: any; key: string | null }[] = [];
    let version = 7;
    const template = () => ({
      id: "agt_template",
      name: "Crusonia Research",
      description: "Researches leads",
      model: "vetta/auto",
      window: "immediate",
      system: "# Crusonia research agent",
      tools: { default_config: { permission: "ask" }, configs: { "crusonia.get_lead": { enabled: true, permission: "allow" } } },
      mcp_servers: [
        { name: "crusonia", url: "https://example.test/mcp" },
        { name: "apify", url: "https://mcp.apify.com?tools=actors" },
      ],
      handoffs: false,
      budget: { cap_micro_usd: 5_000_000, max_task_micro_usd: 1_000_000, period: "day" },
      metadata: { app: "crusonia", playbook_version: "3" },
      current_version: version,
    });
    const fetchFn: FetchFn = async (u, init = {}) => {
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      const key = (init.headers as Record<string, string> | undefined)?.["Idempotency-Key"] ?? null;
      calls.push({ method: init.method ?? "GET", url: u, body, key });
      if (u.endsWith("/v1/agents/agt_template")) return new Response(JSON.stringify(template()));
      if (u.endsWith("/v1/agents") && init.method === "POST") return new Response(JSON.stringify({ id: `agt_ws_${run}`, ...body }));
      if (u.endsWith(`/v1/agents/agt_ws_${run}`) && init.method === "PATCH") return new Response(JSON.stringify({ id: `agt_ws_${run}` }));
      if (u.endsWith("/v1/vaults/vlt_test/credentials")) return new Response(JSON.stringify({ id: `vcr_${run}`, mcp_server_url: body.mcp_server_url, agent_id: body.agent_id }));
      return new Response("{}", { status: 404 });
    };
    const e = env();
    const first = await naiveAgentFor(sql, e, ws, fetchFn);
    expect(first.agentId).toBe(`agt_ws_${run}`);
    expect(first.workflowVersion).toBe("playbook@3, agent v7");
    const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/agents"))!;
    const wsUrl = workspaceMcpUrl(e, ws);
    expect(wsUrl).toBe(`https://example.test/mcp?ws=${ws}`);
    expect(create.body).toMatchObject({
      system: "# Crusonia research agent",
      model: "vetta/auto",
      budget: { cap_micro_usd: 5_000_000, max_task_micro_usd: 1_000_000, period: "day" },
      handoffs: false,
      mcp_servers: [
        { type: "url", name: "crusonia", url: wsUrl },
        { type: "url", name: "apify", url: "https://mcp.apify.com?tools=actors" },
      ],
      metadata: { workspace_id: ws, template_agent: "agt_template", template_version: "7" },
    });
    expect(create.key).toBe(`crusonia-agent-${ws}`);
    const cred = calls.find((c) => c.url.endsWith("/credentials"))!;
    expect(cred.body).toMatchObject({ kind: "static_bearer", mcp_server_url: wsUrl, agent_id: `agt_ws_${run}` });
    // The credential holds an 'agent' key of this workspace only: it works on its URL, and nowhere else.
    const agentKey = cred.body.value as string;
    expect(await verifyApiKey(sql, agentKey)).toMatchObject({ workspace_id: ws, kind: "agent" });
    expect((await tool(agentKey, "get_status", {}, `/mcp?ws=${ws}`)).data.database.reachable).toBe(true);
    expect((await tool(agentKey, "get_status", {}, `/mcp?ws=${B}`)).status).toBe(403);
    // An agent key is a researcher: it can't even ask without its run id, and a run id from another workspace is unknown.
    expect((await tool(agentKey, "get_lead", { lead_id: b.lead }, `/mcp?ws=${ws}`)).error).toContain("Pass run_id");
    expect((await tool(agentKey, "get_lead", { lead_id: b.lead, run_id: "run_of_b" }, `/mcp?ws=${ws}`)).error).toContain("No run");
    // The agent key is managed by Crusonia: not listed, not revocable through /api/keys.
    const userKey = await testKey(sql, ws);
    expect((await call(userKey, "GET", "/api/keys")).body.data.map((k: any) => k.name)).toEqual(["test key"]);
    const row = (await sql`select naive_agent_id, naive_credential_id, naive_mcp_url, naive_template_version from workspaces where id = ${ws}`)[0];
    expect(row).toEqual({ naive_agent_id: `agt_ws_${run}`, naive_credential_id: `vcr_${run}`, naive_mcp_url: wsUrl, naive_template_version: 7 });

    // Next runs reuse it without calling Naive; after a template change (new playbook) it is re-synced with a PATCH.
    const n = calls.length;
    expect((await naiveAgentFor(sql, e, ws, fetchFn)).agentId).toBe(`agt_ws_${run}`);
    expect(calls).toHaveLength(n);
    version = 8;
    await sql`update workspaces set naive_synced_at = now() - interval '1 hour' where id = ${ws}`;
    await naiveAgentFor(sql, e, ws, fetchFn);
    const patch = calls.slice(n).find((c) => c.method === "PATCH")!;
    expect(patch.url).toEndWith(`/v1/agents/agt_ws_${run}`);
    expect(patch.body.mcp_servers[0]).toEqual({ type: "url", name: "crusonia", url: wsUrl });
    expect((await sql`select naive_template_version from workspaces where id = ${ws}`)[0]!.naive_template_version).toBe(8);
    expect(calls.filter((c) => c.url.endsWith("/credentials"))).toHaveLength(1);

    // The owner workspace runs on the template agent itself (its version read from Naive, cached briefly).
    resetTemplateVersionCache();
    expect(await naiveAgentFor(sql, e, "ws_owner", fetchFn)).toMatchObject({ agentId: "agt_template", workflowVersion: "playbook@3, agent v8" });
  });
});
