// The instance's brakes and Autopilot for every sign-up, against a real Postgres (never production), Naive mocked at fetch.
// Skipped unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=<dev branch url> bun test test/go-live.integration.test.ts
// Safe on a database shared with staging: the kill switch uses its own settings key, the cap comes from each test's env,
// ticks run on a list of test workspaces (never "*", which would act on every workspace in the database), and what lands
// in the owner workspace's log is deleted afterwards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getBalance } from "../src/billing/accounts.ts";
import { getSql, type Sql } from "../src/db.ts";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";
import type { FetchFn } from "../src/providers/http.ts";
import { agentFindMore, canRun, ensureAutopilotWorkflow, getAutopilot, runAutopilot, setAutopilot } from "../src/services/autopilot.ts";
import { writeCompanySummary } from "../src/services/company-summary.ts";
import { instanceBrake, instanceState, RUNNING_SESSION_RESERVE_MICRO_USD, setInstanceHalted } from "../src/services/instance.ts";
import { addLeads } from "../src/services/leads.ts";
import { paidStartAllowance, requirePaidStart, requireWebCall } from "../src/services/limits.ts";
import { startResearch } from "../src/services/workflows.ts";
import { createTestWorkspace, deleteTestWorkspaces, testKey } from "./helpers/workspace.ts";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const run = crypto.randomUUID().slice(0, 8);
const CONTROL_KEY = `instance_control_it_${run}`;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

let sql: Sql;
let startedAt: string;
const created: string[] = [];

const baseEnv = (over: Partial<Env> = {}): Env => ({
  PUBLIC_URL: "https://example.test",
  DATABASE_URL: url,
  MCP_TOKEN: `it-owner-${run}`,
  NAIVE_API_KEY: "nv_test",
  NAIVE_AGENT_ID: "agt_research",
  NAIVE_OPERATOR_AGENT_ID: "agt_operator",
  NAIVE_VAULT_ID: "vlt_test",
  INSTANCE_CONTROL_KEY: CONTROL_KEY,
  // Whatever else this database spent today. Tests of the cap set their own.
  INSTANCE_DAILY_CAP_USD: "1000000",
  ...over,
});
const atCap = { INSTANCE_DAILY_CAP_USD: "0" };

/** Mocked Naive: each session gets an id, and the sessions started are recorded. */
function naive() {
  const sessions: { id: string; metadata: Record<string, string> }[] = [];
  const fn: FetchFn = async (input, init) => {
    const u = String(input);
    const method = init?.method ?? "GET";
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (u.includes("/v1/sessions") && method === "POST" && !/\/v1\/sessions\/[^/]+\//.test(u)) {
      const id = `ses_gl_${run}_${crypto.randomUUID().slice(0, 8)}`;
      sessions.push({ id, ...(JSON.parse(String(init!.body)) as { metadata: Record<string, string> }) });
      return json({ id, status: "running" });
    }
    if (/\/v1\/agents\/[^/]+$/.test(u) && method === "GET")
      return json({ id: u.split("/").pop(), name: "T", model: "m", window: "immediate", system: "s", tools: { default_config: { permission: "deny" }, configs: {} }, mcp_servers: [], budget: { cap_micro_usd: 1, max_task_micro_usd: 1, period: "day" }, metadata: { playbook: "p", playbook_version: "1" }, current_version: 1 });
    return json({}, 200);
  };
  return { fn, sessions, started: (ws: string) => sessions.filter((s) => s.metadata.workspace_id === ws).length };
}

async function workspace(label: string, opts: { credits?: number; createdBy?: string } = {}) {
  const ws = await createTestWorkspace(sql, `gl_${label}_${run}`);
  created.push(ws);
  await sql`update workspaces set naive_agent_id = 'agt_ws', naive_credential_id = 'vcr_x', naive_synced_at = now() + interval '1 hour', created_by = ${opts.createdBy ?? null} where id = ${ws}`;
  const credits = opts.credits ?? 100_000;
  if (credits) await sql`insert into credit_ledger (workspace_id, owner_id, amount, reason, source) values (${ws}, ${ws}, ${credits}, 'grant', ${`test:${ws}`})`;
  return ws;
}

/** A workspace on Autopilot with its schedule due now. */
async function onAutopilot(label: string, env: Env, opts: { credits?: number; createdBy?: string } = {}) {
  const ws = await workspace(label, opts);
  await writeCompanySummary(sql, ws, { markdown: "# Acme\n\n## What we sell\n\nThings\n", author: "onboarding" });
  await sql`update workspaces set autopilot_provisioned_at = now() where id = ${ws}`;
  await ensureAutopilotWorkflow(sql, env, ws);
  // The switch only asks whether Autopilot is available; ticks below run on a list of test workspaces.
  await setAutopilot(sql, { ...env, AUTOPILOT_WORKSPACES: "*" }, ws, true, "clerk:u1");
  return ws;
}

const session = (ws: string, id: string, over: { status?: string; consumed?: number | null } = {}) =>
  sql`insert into naive_sessions (id, workspace_id, purpose, status, consumed_micro_usd) values (${`ses_it_${run}_${id}`}, ${ws}, 'research', ${over.status ?? "done"}, ${over.consumed ?? null})`;

const refusedBusy = { status: 429, code: "instance_busy" };

async function http(token: string, method: string, path: string, body: unknown, env: Env) {
  const res = await worker.fetch(
    new Request(`https://example.test${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    env,
    ctx,
  );
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any };
}

suite("going live (database, mocked Naive)", () => {
  beforeAll(async () => {
    sql = getSql(url);
    startedAt = new Date().toISOString();
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from apify_runs where workspace_id = any(${created}::text[]) or run_id like ${`run_it_${run}%`}`;
    await sql`delete from naive_sessions where id like ${`ses_it_${run}%`}`;
    await deleteTestWorkspaces(sql, created);
    await sql`delete from settings where key = ${CONTROL_KEY}`;
    await sql`delete from events where workspace_id = 'ws_owner' and kind in ('instance_cap_reached', 'instance_halted', 'instance_resumed') and created_at >= ${startedAt}::timestamptz`;
  });

  // ---------- the spend the cap counts ----------

  describe("what the cap counts", () => {
    test("Naive and Apify spend of other workspaces, running sessions at a floor, and open Apify runs at their limit", async () => {
      const env = baseEnv();
      const ws = await workspace("spend");
      const spent = async () => (await instanceState(sql, env)).spent_micro_usd;
      const a = await spent();

      await session(ws, "done", { consumed: 3_000_000 });
      const b = await spent();
      expect(b - a).toBeGreaterThanOrEqual(3_000_000);

      // Running with nothing reported yet: it counts, so a burst of starts can't all see $0.
      await session(ws, "running", { status: "running" });
      const c = await spent();
      expect(c - b).toBeGreaterThanOrEqual(RUNNING_SESSION_RESERVE_MICRO_USD);

      await sql`insert into apify_runs (run_id, workspace_id, actor, status, usage_micro_usd, usage_final, max_charge_usd) values (${`run_it_${run}_a`}, ${ws}, 'x', 'SUCCEEDED', 1000000, true, 0.25)`;
      const d = await spent();
      expect(d - c).toBeGreaterThanOrEqual(1_000_000);

      await sql`insert into apify_runs (run_id, workspace_id, actor, status, usage_micro_usd, usage_final, max_charge_usd) values (${`run_it_${run}_b`}, ${ws}, 'x', 'RUNNING', null, false, 0.25)`;
      expect((await spent()) - d).toBeGreaterThanOrEqual(250_000);
    });

    test("not the owner's, and not what is older than a day", async () => {
      const env = baseEnv();
      const ws = await workspace("old");
      const before = (await instanceState(sql, env)).spent_micro_usd;
      await session("ws_owner", "owner", { consumed: 900_000_000 });
      await session(ws, "old", { consumed: 900_000_000 });
      await sql`update naive_sessions set created_at = now() - interval '25 hours' where id = ${`ses_it_${run}_old`}`;
      const after = (await instanceState(sql, env)).spent_micro_usd;
      // Not left there: it would also be the owner workspace's own spend today, against its own daily cap.
      await sql`delete from naive_sessions where id = ${`ses_it_${run}_owner`}`;
      expect(after - before).toBeLessThan(100_000_000);
    });
  });

  // ---------- the cap ----------

  describe("the cap", () => {
    test("new paid starts answer 429 instance_busy everywhere but the owner's, and the log has one line an hour", async () => {
      const env = baseEnv(atCap);
      const ws = await workspace("cap");
      await expect(requirePaidStart(sql, env, ws)).rejects.toMatchObject(refusedBusy);
      await expect(requirePaidStart(sql, env, "ws_owner")).resolves.toBeUndefined();
      expect((await paidStartAllowance(sql, env, ws, 3)).reason).toBe("instance_busy");
      await expect(requireWebCall(sql, env, ws, "read_website")).rejects.toMatchObject(refusedBusy);
      await expect(requireWebCall(sql, env, "ws_owner", "read_website")).resolves.toBeUndefined();

      const count = async () => (await sql`select count(*)::int as n from events where workspace_id = 'ws_owner' and kind = 'instance_cap_reached' and created_at >= ${startedAt}::timestamptz`)[0]!.n as number;
      expect(await count()).toBe(1);
      expect(await instanceBrake(sql, env, ws)).toBe("cap");
      expect(await count()).toBe(1);
    });

    test("through the API: every route that starts paid work, with no run left behind", async () => {
      const env = baseEnv({ ...atCap, APIFY_TOKEN: "apify_test" });
      const ws = await onAutopilot("api", env);
      const [def] = await sql`select id from workflow_defs where workspace_id = ${ws} and is_autopilot`;
      const added = await addLeads(sql, ws, [{ company: "Acme", domain: `api-${run}.dev`, source: "it", source_url: `https://api-${run}.dev/`, score: 80, qualified: true, rationale: "r" }], { cohort: "c" });
      const leadId = (added as unknown as { added?: { id: string }[]; leads?: { id: string }[] }).added?.[0]?.id ?? (await sql`select id from leads where workspace_id = ${ws} limit 1`)[0]!.id;
      const key = await testKey(sql, ws);
      const busy = { status: 429, body: { error: { code: "instance_busy" } } };
      expect(await http(key, "POST", "/api/leads/find", { count: 1 }, env)).toMatchObject(busy);
      expect(await http(key, "POST", "/api/workflows/research", { lead_ids: [leadId] }, env)).toMatchObject(busy);
      expect(await http(key, "POST", "/api/onboarding/propose", { description: "Things" }, env)).toMatchObject(busy);
      expect(await http(key, "POST", "/api/onboarding/read-website", { url: "https://example.com" }, env)).toMatchObject(busy);
      expect(await http(key, "POST", `/api/workflow-definitions/${def!.id}/run`, { lead_ids: [leadId] }, env)).toMatchObject(busy);
      expect(await sql`select 1 from workflow_runs where workspace_id = ${ws}`).toEqual([]);
      expect(await sql`select 1 from naive_sessions where workspace_id = ${ws}`).toEqual([]);
    });

    test("an agent asking for more is told, and starts nothing", async () => {
      const env = baseEnv(atCap);
      const ws = await onAutopilot("agent", env);
      await expect(agentFindMore(sql, env, ws, { actor: "agent:x", respectSwitch: true })).rejects.toThrow("at capacity");
      expect(await sql`select 1 from workflow_runs where workspace_id = ${ws}`).toEqual([]);
    });

    test("startResearch refuses the whole batch", async () => {
      const env = baseEnv(atCap);
      const ws = await workspace("research");
      await addLeads(sql, ws, [{ company: "Acme", domain: `res-${run}.dev`, source: "it", source_url: `https://res-${run}.dev/`, score: 80, qualified: true, rationale: "r" }], { cohort: "c" });
      await expect(startResearch(sql, env, ws, {}, "clerk:u1", naive().fn)).rejects.toMatchObject(refusedBusy);
    });

    test("Autopilot waits, Home says so, and it picks up by itself once the cap lifts", async () => {
      const open = baseEnv();
      const ws = await onAutopilot("wait", baseEnv({ AUTOPILOT_WORKSPACES: "*" }));
      const n = naive();
      const capped = baseEnv({ ...atCap, AUTOPILOT_WORKSPACES: ws });
      await runAutopilot(sql, capped, n.fn);
      expect(n.started(ws)).toBe(0);
      expect((await getAutopilot(sql, capped, ws)).blocked).toBe("instance_busy");
      await runAutopilot(sql, { ...open, AUTOPILOT_WORKSPACES: ws }, n.fn);
      expect(n.started(ws)).toBe(1);
      expect((await getAutopilot(sql, { ...open, AUTOPILOT_WORKSPACES: ws }, ws)).blocked).toBeNull();
    });

    test("a run under way starts no more research, and the Operator stays quiet", async () => {
      const open = baseEnv();
      const ws = await onAutopilot("midrun", baseEnv({ AUTOPILOT_WORKSPACES: "*" }));
      const n = naive();
      const list = { AUTOPILOT_WORKSPACES: ws };
      await runAutopilot(sql, { ...open, ...list }, n.fn);
      const [wf] = await sql`select r.id, r.workflow_id from workflow_runs r where r.workspace_id = ${ws}`;
      await addLeads(sql, ws, [{ company: "Queued", domain: `q-${run}.dev`, source: "it", source_url: `https://q-${run}.dev/`, score: 80, qualified: true, rationale: "r" }], { cohort: "c" });
      const [lead] = await sql`select id, variant from leads where workspace_id = ${ws} limit 1`;
      await sql`update workflow_runs set phase = 'researching' where id = ${wf!.id}`;
      await sql`update naive_sessions set status = 'done' where workspace_id = ${ws}`;
      await sql`insert into workflow_run_leads (run_id, lead_id, variant, status) values (${wf!.id}, ${lead!.id}, ${lead!.variant}, 'queued')`;
      const startedBefore = n.sessions.length;

      await runAutopilot(sql, { ...open, ...list, ...atCap }, n.fn);
      expect(n.sessions.length).toBe(startedBefore);
      expect((await sql`select status from workflow_run_leads where run_id = ${wf!.id} and lead_id = ${lead!.id}`)[0]!.status).toBe("queued");

      await runAutopilot(sql, { ...open, ...list }, n.fn);
      expect(n.sessions.filter((s) => s.metadata.purpose === "research").length).toBe(1);
    });
  });

  // ---------- the kill switch ----------

  describe("the kill switch", () => {
    test("operators only; it stops everyone, the owner too; the log has it; only a person can release it", async () => {
      const env = baseEnv();
      const ws = await workspace("switch");
      await writeCompanySummary(sql, ws, { markdown: "# Acme\n\n## What we sell\n\nThings\n", author: "onboarding" });
      const owner = `it-owner-${run}`;
      const key = await testKey(sql, ws);

      expect(await http(key, "GET", "/api/admin/instance", undefined, env)).toMatchObject({ status: 403 });
      expect(await http(key, "PUT", "/api/admin/instance", { halted: true }, env)).toMatchObject({ status: 403 });

      const seen = await http(owner, "GET", "/api/admin/instance", undefined, env);
      expect(seen).toMatchObject({ status: 200, body: { halted: false, cap_usd: 1000000, cap_reached: false, signups_open: true, autopilot_workspaces: "none", payments_live: false } });

      expect(await http(owner, "PUT", "/api/admin/instance", { halted: true }, env)).toMatchObject({ status: 200, body: { halted: true, halted_by: "owner_token" } });
      await expect(requirePaidStart(sql, env, ws)).rejects.toMatchObject(refusedBusy);
      await expect(requirePaidStart(sql, env, "ws_owner")).rejects.toMatchObject(refusedBusy);
      await expect(requireWebCall(sql, env, "ws_owner", "read_website")).rejects.toMatchObject(refusedBusy);
      expect(await http(key, "POST", "/api/leads/find", { count: 1 }, env)).toMatchObject({ status: 429, body: { error: { code: "instance_busy" } } });

      // Another instance on this database, with its own key, isn't affected: that is what the key is for.
      await expect(requirePaidStart(sql, baseEnv({ INSTANCE_CONTROL_KEY: `${CONTROL_KEY}_other` }), ws)).resolves.toBeUndefined();

      expect(await http(owner, "PUT", "/api/admin/instance", { halted: false }, env)).toMatchObject({ status: 403, body: { error: { code: "human_required" } } });
      expect((await instanceState(sql, env)).halted).toBe(true);

      await setInstanceHalted(sql, env, false, "clerk:admin");
      await expect(requirePaidStart(sql, env, ws)).resolves.toBeUndefined();

      const [on] = await sql`select data from events where workspace_id = 'ws_owner' and kind = 'instance_halted' and created_at >= ${startedAt}::timestamptz order by id desc limit 1`;
      const [off] = await sql`select data from events where workspace_id = 'ws_owner' and kind = 'instance_resumed' and created_at >= ${startedAt}::timestamptz order by id desc limit 1`;
      expect(on!.data).toEqual({ actor: "owner_token" });
      expect(off!.data).toEqual({ actor: "clerk:admin" });
    });

    test("Autopilot stops at the next tick and picks up when released", async () => {
      const env = baseEnv();
      const ws = await onAutopilot("halt", baseEnv({ AUTOPILOT_WORKSPACES: "*" }));
      const n = naive();
      const list = { ...env, AUTOPILOT_WORKSPACES: ws };
      await setInstanceHalted(sql, env, true, "owner_token");
      try {
        const report = await runAutopilot(sql, list, n.fn);
        expect(n.started(ws)).toBe(0);
        expect(report.schedules).toBeUndefined();
        expect((await getAutopilot(sql, list, ws)).blocked).toBe("instance_busy");
      } finally {
        await setInstanceHalted(sql, env, false, "clerk:admin");
      }
      await runAutopilot(sql, list, n.fn);
      expect(n.started(ws)).toBe(1);
    });
  });

  // ---------- Autopilot for every sign-up ----------

  describe('AUTOPILOT_WORKSPACES="*"', () => {
    test("every workspace is on the list; the cap leaves the owner's; a blocked person's workspaces are off", async () => {
      const blocked = `user_it_${run}_blocked`;
      const mine = await workspace("all_a");
      const theirs = await workspace("all_b", { createdBy: blocked });
      const ids = async (t: Parameters<typeof canRun>[1]) => (await sql`select w.id from workspaces w where ${canRun(sql, t)}`).map((r) => r.id as string);
      const open = { capReached: false, all: true, list: ["*"], blocked: [] as string[] };

      const everyone = await ids(open);
      expect(everyone).toEqual(expect.arrayContaining([mine, theirs, "ws_owner"]));

      expect(await ids({ ...open, capReached: true })).toEqual(["ws_owner"]);

      const without = await ids({ ...open, blocked: [blocked] });
      expect(without).toContain(mine);
      expect(without).not.toContain(theirs);

      expect(await ids({ ...open, all: false, list: [mine] })).toEqual([mine]);
    });

    test("a workspace with no credits starts nothing, says so, and starts when it has some", async () => {
      const ws = await onAutopilot("empty", baseEnv({ AUTOPILOT_WORKSPACES: "*" }), { credits: 0 });
      const env = baseEnv({ AUTOPILOT_WORKSPACES: ws });
      const n = naive();
      await runAutopilot(sql, env, n.fn);
      await runAutopilot(sql, env, n.fn);
      expect(n.started(ws)).toBe(0);
      const state = await getAutopilot(sql, env, ws);
      expect(state).toMatchObject({ available: true, enabled: true, blocked: "no_credits", payments_live: false });
      expect(state.workflow?.last_skip).toBe("no_credits");
      // One line in the feed, not one a minute.
      expect((await sql`select count(*)::int as n from events where workspace_id = ${ws} and kind = 'workflow_skipped'`)[0]!.n).toBe(1);
      expect(state.feed[0]?.text).toContain("out of credits");

      await sql`insert into credit_ledger (workspace_id, owner_id, amount, reason, source) values (${ws}, ${ws}, 500, 'grant', ${`test:later:${ws}`})`;
      await runAutopilot(sql, env, n.fn);
      expect(n.started(ws)).toBe(1);
      expect((await getAutopilot(sql, env, ws)).blocked).toBeNull();
    });

    test("a run under way stops cleanly when credits run out: nothing left queued, the reason on the run", async () => {
      const ws = await onAutopilot("drain", baseEnv({ AUTOPILOT_WORKSPACES: "*" }));
      const env = baseEnv({ AUTOPILOT_WORKSPACES: ws });
      const n = naive();
      await runAutopilot(sql, env, n.fn);
      const [wf] = await sql`select id from workflow_runs where workspace_id = ${ws}`;
      await addLeads(sql, ws, [{ company: "Queued", domain: `dr-${run}.dev`, source: "it", source_url: `https://dr-${run}.dev/`, score: 80, qualified: true, rationale: "r" }], { cohort: "c" });
      const [lead] = await sql`select id, variant from leads where workspace_id = ${ws} limit 1`;
      await sql`update workflow_runs set phase = 'researching' where id = ${wf!.id}`;
      await sql`update naive_sessions set status = 'done' where workspace_id = ${ws}`;
      await sql`insert into workflow_run_leads (run_id, lead_id, variant, status) values (${wf!.id}, ${lead!.id}, ${lead!.variant}, 'queued')`;
      await sql`insert into credit_ledger (workspace_id, owner_id, amount, reason, source) values (${ws}, ${ws}, ${-(await getBalance(sql, ws))}, 'usage', ${`test:drain:${ws}`})`;

      const before = n.sessions.length;
      await runAutopilot(sql, env, n.fn);
      expect(n.sessions.length).toBe(before);
      expect((await sql`select phase from workflow_runs where id = ${wf!.id}`)[0]!.phase).toBe("done");
      expect((await sql`select status, reason from workflow_run_leads where run_id = ${wf!.id} and lead_id = ${lead!.id}`)[0]).toEqual({ status: "skipped", reason: "no_credits" });
      const [finished] = await sql`select data from events where workspace_id = ${ws} and kind = 'workflow_run_finished' order by id desc limit 1`;
      expect(finished!.data).toMatchObject({ reason: "no_credits" });
    });

    test("many workspaces out of credits don't hold up one that has some", async () => {
      // More than one tick's worth of due schedules, all older than the one with credits.
      const empty: string[] = [];
      for (let i = 0; i < 22; i++) empty.push(await onAutopilot(`crowd${i}`, baseEnv({ AUTOPILOT_WORKSPACES: "*" }), { credits: 0 }));
      await sql`update workflow_defs set next_run_at = now() - interval '1 day' where workspace_id = any(${empty}::text[])`;
      const funded = await onAutopilot("funded", baseEnv({ AUTOPILOT_WORKSPACES: "*" }));
      await sql`update workflow_defs set next_run_at = now() - interval '1 minute' where workspace_id = ${funded}`;
      const env = baseEnv({ AUTOPILOT_WORKSPACES: [...empty, funded].join(",") });
      const n = naive();
      await runAutopilot(sql, env, n.fn);
      await runAutopilot(sql, env, n.fn);
      expect(n.started(funded)).toBe(1);
      expect(n.sessions.length).toBe(1);
      // The ones already told cost nothing from here on: the next tick looks at none of them.
      const skips = async () => (await sql`select count(*)::int as n from events where workspace_id = any(${empty}::text[]) and kind = 'workflow_skipped'`)[0]!.n as number;
      const told = await skips();
      expect(told).toBe(empty.length);
      await runAutopilot(sql, env, n.fn);
      expect(await skips()).toBe(told);
    });

    test("BLOCKED_USER_IDS stops the workspaces that person made, even on the list", async () => {
      const blocked = `user_it_${run}_abuser`;
      const ws = await onAutopilot("abuse", baseEnv({ AUTOPILOT_WORKSPACES: "*" }), { createdBy: blocked });
      const n = naive();
      await runAutopilot(sql, baseEnv({ AUTOPILOT_WORKSPACES: ws, BLOCKED_USER_IDS: blocked }), n.fn);
      expect(n.started(ws)).toBe(0);
      await runAutopilot(sql, baseEnv({ AUTOPILOT_WORKSPACES: ws }), n.fn);
      expect(n.started(ws)).toBe(1);
    });

    test("the Operator stays under the rate limits and out of workspaces with no credits", async () => {
      const ws = await onAutopilot("op", baseEnv({ AUTOPILOT_WORKSPACES: "*" }));
      const env = baseEnv({ AUTOPILOT_WORKSPACES: ws });
      const n = naive();
      // Past its first run, nothing open, and the clock says it's time: only the limit stands between it and a start.
      await sql`insert into workflow_runs (id, workspace_id, workflow_id, version, actor, trigger, phase)
                select ${`wfr_it_${run}_op`}, ${ws}, id, latest_version, 'test', 'schedule', 'done' from workflow_defs where workspace_id = ${ws} and is_autopilot`;
      await sql`update workflow_defs set next_run_at = now() + interval '1 day' where workspace_id = ${ws}`;
      await runAutopilot(sql, baseEnv({ AUTOPILOT_WORKSPACES: ws, PAID_STARTS_PER_HOUR: "0" }), n.fn);
      expect(n.started(ws)).toBe(0);
      await runAutopilot(sql, env, n.fn);
      expect(n.sessions.filter((s) => s.metadata.purpose === "operate").length).toBe(1);
    });
  });
});
