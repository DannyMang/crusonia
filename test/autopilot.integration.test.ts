// Autopilot against a real Postgres (a Neon dev branch or database, never production), Naive and Apify mocked at fetch.
// Skipped unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=<dev branch url> bun test test/autopilot.integration.test.ts
// Covers: a new workspace gets its workflow and first run with no click; find -> research; one active run; schedules due
// and not due; pause, caps and credits; the switch; the Operator; a researcher kept to its lead; merge; import; the feed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getSql, type Sql } from "../src/db.ts";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import type { McpRole } from "../src/mcp/toolsets.ts";
import type { FetchFn } from "../src/providers/http.ts";
import { activityFeed, autonomyCounts } from "../src/services/activity.ts";
import { ensureAutopilotWorkflow, getAutopilot, operatorSnapshot, runAutopilot, setAutopilot } from "../src/services/autopilot.ts";
import { writeCompanySummary } from "../src/services/company-summary.ts";
import { addLeads } from "../src/services/leads.ts";
import { addNote } from "../src/services/notes.ts";
import { handleSessionIdle } from "../src/services/workflows.ts";
import { createTestWorkspace, deleteTestWorkspaces, testKey } from "./helpers/workspace.ts";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const run = crypto.randomUUID().slice(0, 8);

let sql: Sql;
const created: string[] = [];

const baseEnv = (ws: string): Env => ({
  PUBLIC_URL: "https://example.test",
  DATABASE_URL: url,
  NAIVE_API_KEY: "nv_test",
  NAIVE_AGENT_ID: "agt_research",
  NAIVE_OPERATOR_AGENT_ID: "agt_operator",
  NAIVE_VAULT_ID: "vlt_test",
  AUTOPILOT_WORKSPACES: ws,
});

/** Mocked Naive: each session gets an id, and the messages sent are recorded. */
function naive() {
  const sessions: { id: string; agent_id: string; message: string; metadata: Record<string, string> }[] = [];
  let n = 0;
  let failCreate = false;
  const events = new Map<string, unknown[]>();
  const fn: FetchFn = async (input, init) => {
    const u = String(input);
    const method = init?.method ?? "GET";
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (u.includes("/v1/sessions") && method === "POST" && !/\/v1\/sessions\/[^/]+\//.test(u)) {
      if (failCreate) return json({ error: "boom" }, 400);
      const body = JSON.parse(String(init!.body));
      const id = `ses_ap_${run}_${++n}`;
      sessions.push({ id, ...body });
      return json({ id, status: "running" });
    }
    const ev = /\/v1\/sessions\/([^/]+)\/events/.exec(u);
    if (ev) return json({ data: events.get(ev[1]!) ?? [], has_more: false, next_cursor: null });
    const one = /\/v1\/sessions\/([^/?]+)$/.exec(u);
    if (one) return json({ id: one[1], status: "idle", stop_reason: "end_turn", pending_actions: [] });
    if (/\/v1\/agents\/[^/]+$/.test(u) && method === "GET") return json({ id: u.split("/").pop(), name: "T", model: "m", window: "immediate", system: "s", tools: { default_config: { permission: "deny" }, configs: {} }, mcp_servers: [], budget: { cap_micro_usd: 1, max_task_micro_usd: 1, period: "day" }, metadata: { playbook: "p", playbook_version: "1" }, current_version: 1 });
    if (u.endsWith("/v1/agents") && method === "POST") return json({ id: `agt_copy_${++n}`, current_version: 1 });
    if (u.includes("/credentials") && method === "POST") return json({ id: `vcr_${++n}`, mcp_server_url: "x", agent_id: "y" });
    return json({}, 200);
  };
  return { fn, sessions, events, fail: (v: boolean) => (failCreate = v) };
}

async function workspace(label: string) {
  const ws = await createTestWorkspace(sql, `ap_${label}_${run}`);
  created.push(ws);
  // Pretend its research agent exists, so sessions start without provisioning one.
  await sql`update workspaces set naive_agent_id = 'agt_ws', naive_credential_id = 'vcr_x', naive_synced_at = now() + interval '1 hour' where id = ${ws}`;
  await sql`insert into credit_ledger (workspace_id, owner_id, amount, reason, source) values (${ws}, ${ws}, 100000, 'grant', ${`test:${ws}`})`;
  return ws;
}
const summary = (ws: string) => writeCompanySummary(sql, ws, { markdown: "# Acme\n\n## What we sell\n\nThings\n", author: "onboarding", note: "first" });

/** The find session of a run finished with these leads added. */
async function finishFind(n: ReturnType<typeof naive>, ws: string, sessionId: string, names: string[], score = 80) {
  const out = await addLeads(
    sql,
    ws,
    names.map((name, i) => ({ company: name, domain: `${name}-${run}.dev`, source: "it", source_url: `https://${name}-${run}.dev/`, score: score - i, qualified: score - i >= 50, rationale: "r", why_summary: `${name} is hiring [1].`, evidence: [{ claim: "hiring", source_url: `https://${name}-${run}.dev/jobs` }] })),
    { cohort: `run:${sessionId}` },
  );
  n.events.set(sessionId, [{ seq: 1, type: "tool.completed", data: { name: "crusonia.add_leads", output: JSON.stringify(out) }, created_at: new Date().toISOString() }]);
  await sql`update naive_sessions set status = 'done' where id = ${sessionId}`;
  return out;
}

async function mcp(ws: string, env: Env, role: McpRole) {
  const server = createMcpServer(env, { workspace: { id: ws, owner: false }, role }, { sql: () => sql });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = res.content[0]!.text;
    return res.isError ? { error: text } : { data: JSON.parse(text) };
  };
}

suite("autopilot (database, mocked Naive)", () => {
  beforeAll(() => {
    sql = getSql(url);
  });
  afterAll(async () => {
    if (!sql) return;
    await sql`delete from naive_sessions where workspace_id = any(${created}::text[])`;
    await deleteTestWorkspaces(sql, created);
  });

  test("nothing happens without AUTOPILOT_WORKSPACES, and a workspace outside the list stays untouched", async () => {
    const ws = await workspace("off");
    await summary(ws);
    const n = naive();
    expect(await runAutopilot(sql, { ...baseEnv(ws), AUTOPILOT_WORKSPACES: undefined }, n.fn)).toEqual({ skipped: "off" });
    await runAutopilot(sql, { ...baseEnv("ws_other"), AUTOPILOT_WORKSPACES: "ws_other" }, n.fn);
    expect(n.sessions.filter((s) => s.metadata.workspace_id === ws)).toHaveLength(0);
    const [row] = await sql`select autopilot, autopilot_provisioned_at from workspaces where id = ${ws}`;
    expect(row).toMatchObject({ autopilot: false, autopilot_provisioned_at: null });
  });

  test("zero clicks: a Company summary gives a workspace its workflow and first run; found leads go to research; drafts follow", async () => {
    const ws = await workspace("flow");
    const env = baseEnv(ws);
    const n = naive();
    // Before the summary: nothing.
    await runAutopilot(sql, env, n.fn);
    expect(n.sessions).toHaveLength(0);

    // An onboarding session still writing: wait.
    await sql`insert into naive_sessions (id, workspace_id, purpose, status) values (${`ses_ob_${run}`}, ${ws}, 'onboarding', 'running')`;
    await summary(ws);
    await runAutopilot(sql, env, n.fn);
    expect(n.sessions).toHaveLength(0);
    await sql`update naive_sessions set status = 'done' where id = ${`ses_ob_${run}`}`;

    await runAutopilot(sql, env, n.fn);
    const state = await getAutopilot(sql, env, ws);
    expect(state).toMatchObject({ available: true, enabled: true });
    expect(state.workflow?.name).toBe("Find and qualify");
    expect(state.workflow?.every_hours).toBe(6);
    expect(n.sessions).toHaveLength(1);
    const find = n.sessions[0]!;
    expect(find.message).toStartWith("Find up to 5 new leads");
    expect(find.message).toContain("Don't call ask_operator");
    expect(find.agent_id).toBe("agt_ws");
    const [fr] = await sql`select * from workflow_runs where workspace_id = ${ws}`;
    expect(fr).toMatchObject({ phase: "finding", trigger: "schedule", find_session_id: find.id });
    const [s] = await sql`select workflow_run_id, workflow_id from naive_sessions where id = ${find.id}`;
    expect(s).toMatchObject({ workflow_run_id: fr!.id, workflow_id: state.workflow!.id });

    // Not due again, and the running find session isn't touched.
    await runAutopilot(sql, env, n.fn);
    expect(n.sessions).toHaveLength(1);

    // The find step finishes: 5 companies, one judged out by its score. The best 3 go to research.
    await finishFind(n, ws, find.id, ["alpha", "beta", "gamma", "delta"]);
    await addLeads(sql, ws, [{ company: "out", domain: `out-${run}.dev`, source: "it", source_url: `https://out-${run}.dev/`, score: 10, qualified: false, rationale: "no" }], { cohort: `run:${find.id}` });
    await runAutopilot(sql, env, n.fn);
    const [after] = await sql`select phase from workflow_runs where id = ${fr!.id}`;
    expect(after!.phase).toBe("researching");
    // The same tick queues them and starts them on the next pass.
    await runAutopilot(sql, env, n.fn);
    const research = n.sessions.filter((x) => x.metadata.purpose === "research");
    expect(research).toHaveLength(3);
    expect(research[0]!.message).toStartWith("Research lead");
    expect(research[0]!.message).toContain("Don't call ask_operator");
    const rows = await sql`select l.company, rl.status from workflow_run_leads rl join leads l on l.id = rl.lead_id where rl.run_id = ${fr!.id} order by l.company`;
    expect(rows.map((r) => `${r.company}:${r.status}`).filter((r) => r.endsWith(":started")).map((r) => r.split(":")[0]).sort()).toEqual(["alpha", "beta", "gamma"]);
    const [session] = await sql`select workflow_run_id from naive_sessions where id = ${research[0]!.id}`;
    expect(session!.workflow_run_id).toBe(fr!.id);

    // One active run per workflow: a due schedule waits, and says so once.
    await sql`update workflow_defs set next_run_at = now() - interval '1 minute' where workspace_id = ${ws} and is_autopilot`;
    await runAutopilot(sql, env, n.fn);
    await runAutopilot(sql, env, n.fn);
    expect(n.sessions.filter((x) => x.metadata.purpose === "find_leads")).toHaveLength(1);
    const [skips] = await sql`select count(*)::int as n from events where workspace_id = ${ws} and kind = 'workflow_skipped' and data->>'reason' = 'active_run'`;
    expect(skips!.n).toBe(1);

    // Research finishes: the run ends and logs it. The Operator runs next, on its own agent. The due schedule starts too.
    await sql`update naive_sessions set status = 'done' where workspace_id = ${ws}`;
    await sql`update workflow_defs set next_run_at = now() + interval '1 hour' where workspace_id = ${ws} and is_autopilot`;
    await runAutopilot(sql, env, n.fn);
    const [done] = await sql`select phase, finished_at from workflow_runs where id = ${fr!.id}`;
    expect(done!.phase).toBe("done");
    const [ev] = await sql`select data from events where workspace_id = ${ws} and kind = 'workflow_run_finished'`;
    expect(ev!.data).toMatchObject({ run_id: fr!.id, researched: 3 });

    await runAutopilot(sql, env, n.fn);
    const operator = n.sessions.filter((x) => x.metadata.purpose === "operate");
    expect(operator).toHaveLength(1);
    expect(operator[0]!.message).toStartWith("Operate Crusonia");
    expect(operator[0]!.message).toContain('"pipeline"');
    // Only one Operator at a time.
    await runAutopilot(sql, env, n.fn);
    expect(n.sessions.filter((x) => x.metadata.purpose === "operate")).toHaveLength(1);

    // The feed and the tally.
    const feed = await activityFeed(sql, ws);
    const lines = feed.map((f) => f.text);
    expect(lines.some((l) => l.startsWith("Found alpha · alpha is hiring"))).toBe(true);
    expect(lines).toContain("Autopilot on");
    expect(lines.some((l) => l.startsWith("Finished a run"))).toBe(true);
    const counts = await autonomyCounts(sql, ws);
    expect(counts.agent_actions).toBeGreaterThanOrEqual(5);
    expect(counts.owner_actions).toBe(0);
    await addNote(sql, ws, { leadId: (await sql`select id from leads where workspace_id = ${ws} limit 1`)[0]!.id as string, author: "user:u1", body: "agency", kind: "thumbs_down" });
    expect((await autonomyCounts(sql, ws)).owner_actions).toBe(1);
  }, 120_000);

  test("pause, the switch, caps and credits stop a due schedule", async () => {
    const ws = await workspace("gates");
    const env = baseEnv(ws);
    const n = naive();
    await summary(ws);
    await sql`update workspaces set autopilot_provisioned_at = now() where id = ${ws}`;
    await ensureAutopilotWorkflow(sql, env, ws);
    const finds = () => n.sessions.filter((x) => x.metadata.purpose === "find_leads").length;

    // Off (a provisioned workspace stays off until the owner turns it on).
    await runAutopilot(sql, env, n.fn);
    expect(finds()).toBe(0);

    await setAutopilot(sql, env, ws, true, "clerk:u1");
    await sql`update workspaces set paused = true where id = ${ws}`;
    await runAutopilot(sql, env, n.fn);
    expect(finds()).toBe(0);
    await sql`update workspaces set paused = false where id = ${ws}`;

    // Daily cap.
    await sql`update workspaces set daily_cap_micro_usd = 0 where id = ${ws}`;
    await runAutopilot(sql, env, n.fn);
    expect(finds()).toBe(0);
    expect((await getAutopilot(sql, env, ws)).workflow?.last_skip).toBe("daily_cap_reached");
    await sql`update workspaces set daily_cap_micro_usd = null where id = ${ws}`;

    // Weekly cap on the workflow.
    await sql`update workflow_defs set spend_cap_usd = 0 where workspace_id = ${ws} and is_autopilot`;
    await runAutopilot(sql, env, n.fn);
    expect(finds()).toBe(0);
    expect((await getAutopilot(sql, env, ws)).workflow?.last_skip).toBe("spend_cap_reached");
    await sql`update workflow_defs set spend_cap_usd = 5 where workspace_id = ${ws} and is_autopilot`;

    // Credits.
    await sql`insert into credit_ledger (workspace_id, owner_id, amount, reason, source) values (${ws}, ${ws}, -200000, 'usage', ${`test:drain:${ws}`})`;
    await runAutopilot(sql, env, n.fn);
    expect(finds()).toBe(0);
    expect((await getAutopilot(sql, env, ws)).workflow?.last_skip).toBe("no_credits");
    await sql`insert into credit_ledger (workspace_id, owner_id, amount, reason, source) values (${ws}, ${ws}, 200000, 'grant', ${`test:fill:${ws}`})`;

    // All clear: it runs, and next_run_at moves forward by its interval.
    await runAutopilot(sql, env, n.fn);
    expect(finds()).toBe(1);
    const [def] = await sql`select next_run_at, last_skip from workflow_defs where workspace_id = ${ws} and is_autopilot`;
    expect(new Date(def!.next_run_at as string).getTime()).toBeGreaterThan(Date.now() + 5 * 3_600_000);
    expect(def!.last_skip).toBeNull();

    // A failed start retries soon, and closes its run.
    await sql`update naive_sessions set status = 'done' where workspace_id = ${ws}`;
    await sql`update workflow_runs set phase = 'done' where workspace_id = ${ws}`;
    await sql`update workflow_defs set next_run_at = now() - interval '1 minute' where workspace_id = ${ws} and is_autopilot`;
    n.fail(true);
    await runAutopilot(sql, env, n.fn);
    n.fail(false);
    const [retry] = await sql`select next_run_at, last_skip from workflow_defs where workspace_id = ${ws} and is_autopilot`;
    expect(new Date(retry!.next_run_at as string).getTime()).toBeLessThan(Date.now() + 10 * 60_000);
    expect(retry!.last_skip).toBe("failed");
    const [open] = await sql`select count(*)::int as n from workflow_runs where workspace_id = ${ws} and phase <> 'done'`;
    expect(open!.n).toBe(0);
  }, 60_000);

  test("the index keeps one active run per workflow, whatever starts it", async () => {
    const ws = await workspace("one");
    const env = baseEnv(ws);
    const id = await ensureAutopilotWorkflow(sql, env, ws);
    await sql`insert into workflow_runs (id, workspace_id, workflow_id, version, phase) values (${`wfr_a_${run}`}, ${ws}, ${id}, 1, 'finding')`;
    const second = await Promise.resolve(sql`insert into workflow_runs (id, workspace_id, workflow_id, version, phase) values (${`wfr_b_${run}`}, ${ws}, ${id}, 1, 'researching')`).then(
      () => null,
      (err) => (err as { code?: string }).code,
    );
    expect(second).toBe("23505");
    // Manual runs (phase done) aren't held back.
    await sql`insert into workflow_runs (id, workspace_id, workflow_id, version) values (${`wfr_c_${run}`}, ${ws}, ${id}, 1)`;
  });

  test("a stuck run ends after 3 hours, so it can't block the schedule forever", async () => {
    const ws = await workspace("stuck");
    const env = baseEnv(ws);
    const id = await ensureAutopilotWorkflow(sql, env, ws);
    await sql`insert into workflow_runs (id, workspace_id, workflow_id, version, phase, started_at) values (${`wfr_s_${run}`}, ${ws}, ${id}, 1, 'finding', now() - interval '4 hours')`;
    await runAutopilot(sql, env, naive().fn);
    const [r] = await sql`select phase from workflow_runs where id = ${`wfr_s_${run}`}`;
    expect(r!.phase).toBe("done");
  }, 30_000);

  test("imports nobody ran start by themselves on the default workflow; consented ones first", async () => {
    const ws = await workspace("csv");
    const env = baseEnv(ws);
    const n = naive();
    await summary(ws);
    await setAutopilot(sql, env, ws, true, "clerk:u1");
    await sql`update workflow_defs set next_run_at = now() + interval '1 hour' where workspace_id = ${ws} and is_autopilot`;
    const [lead] = await sql`
      insert into leads (id, workspace_id, email, company, source, stage, variant, consent_text, consent_at, import_meta, cohort)
      values (${`lead_csv_${run}`}, ${ws}, ${`a-${run}@ex.test`}, 'Imported', 'import', 'new', 'A', 'form', now(), '{"row":1}', 'batch') returning id`;
    await runAutopilot(sql, env, n.fn);
    const research = n.sessions.filter((s) => s.metadata.purpose === "research");
    expect(research.map((s) => s.metadata.lead_id)).toEqual([lead!.id as string]);
    const [r] = await sql`select trigger, phase from workflow_runs where workspace_id = ${ws}`;
    expect(r).toMatchObject({ trigger: "csv_import", phase: "researching" });
    await runAutopilot(sql, env, n.fn);
    expect(n.sessions.filter((s) => s.metadata.purpose === "research")).toHaveLength(1);
  }, 60_000);

  test("a reply starts a workflow with a reply trigger, once", async () => {
    const ws = await workspace("reply");
    const env = baseEnv(ws);
    const n = naive();
    await summary(ws);
    await setAutopilot(sql, env, ws, true, "clerk:u1");
    await sql`update workflow_defs set enabled = false where workspace_id = ${ws} and is_autopilot`;
    const call = await mcp(ws, env, "full");
    const made = await call("create_workflow", { name: "Answer replies", trigger: { kind: "reply" }, spend: { cap_usd: 1, period: "week" } });
    const [lead] = await sql`
      insert into leads (id, workspace_id, email, company, source, stage, variant) values (${`lead_rep_${run}`}, ${ws}, ${`r-${run}@ex.test`}, 'Replier', 'it', 'replied', 'A') returning id`;
    await sql`insert into messages (workspace_id, lead_id, direction, subject, body, from_addr) values (${ws}, ${lead!.id}, 'in', 'Re: hi', 'tell me more', ${`r-${run}@ex.test`})`;
    await runAutopilot(sql, env, n.fn);
    const research = n.sessions.filter((s) => s.metadata.purpose === "research");
    expect(research).toHaveLength(1);
    expect(research[0]!.message).toContain("This lead replied");
    await sql`update naive_sessions set status = 'done' where workspace_id = ${ws}`;
    await runAutopilot(sql, env, n.fn);
    await runAutopilot(sql, env, n.fn);
    expect(n.sessions.filter((s) => s.metadata.purpose === "research")).toHaveLength(1);
    expect(made.data.workflow.trigger.kind).toBe("reply");
  }, 60_000);

  test("the switch over HTTP: a person can, an API key can't, and off stops new work", async () => {
    const ws = await workspace("http");
    const env = baseEnv(ws);
    const key = await testKey(sql, ws);
    const res = await worker.fetch(
      new Request("https://example.test/api/autopilot", { method: "PUT", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(403);
    const get = await worker.fetch(new Request("https://example.test/api/autopilot", { headers: { Authorization: `Bearer ${key}` } }), env, {} as ExecutionContext);
    expect(get.status).toBe(200);
    expect(((await get.json()) as { available: boolean; enabled: boolean })).toMatchObject({ available: true, enabled: false });
    await expect(setAutopilot(sql, { ...env, AUTOPILOT_WORKSPACES: "ws_other" }, ws, true, "clerk:u1")).rejects.toThrow("available");
  });

  test("a researcher sees and changes only its target lead", async () => {
    const ws = await workspace("scope");
    const env = baseEnv(ws);
    const { results } = await addLeads(
      sql,
      ws,
      [
        { company: "Mine", domain: `mine-${run}.dev`, source: "it", source_url: `https://mine-${run}.dev/` },
        { company: "Other", domain: `other-${run}.dev`, source: "it", source_url: `https://other-${run}.dev/` },
      ],
      { cohort: "x" },
    );
    const [mine, other] = results.map((r) => r.id!);
    await sql`insert into naive_sessions (id, workspace_id, lead_id, purpose, status, input) values (${`ses_r_${run}`}, ${ws}, ${mine}, 'research', 'running', ${JSON.stringify({ run_id: `run_r_${run}` })}::jsonb)`;
    await sql`insert into naive_sessions (id, workspace_id, purpose, status, input) values (${`ses_f_${run}`}, ${ws}, 'find_leads', 'running', ${JSON.stringify({ run_id: `run_f_${run}`, like_lead_id: other })}::jsonb)`;
    await addNote(sql, ws, { leadId: other!, author: "user:u1", body: "secret note about other", kind: "note" });
    await sql`update leads set excluded_at = now(), excluded_reason = 'x' where id = ${other}`;
    const call = await mcp(ws, env, "researcher");

    expect((await call("get_lead", { lead_id: mine })).error).toContain("run_id");
    expect((await call("get_lead", { lead_id: mine, run_id: `run_r_${run}` })).data.lead.id).toBe(mine);
    expect((await call("get_lead", { lead_id: other, run_id: `run_r_${run}` })).error).toContain("one lead");
    expect((await call("save_evidence", { lead_id: other, run_id: `run_r_${run}`, claim: "c", source_url: "https://x.dev/" })).error).toContain("one lead");
    expect((await call("add_note", { lead_id: other, run_id: `run_r_${run}`, body: "x" })).error).toContain("one lead");
    expect((await call("flag_for_review", { lead_id: other, run_id: `run_r_${run}`, question: "q?" })).error).toContain("one lead");
    expect((await call("get_lead", { lead_id: other, run_id: `run_nope_${run}` })).error).toContain("No run");
    // A research run can't add leads; a find run can, and may read the lead it was told to look like, read-only.
    expect((await call("add_leads", { run_id: `run_r_${run}`, leads: [{ company: "N", domain: `n-${run}.dev`, source: "s", source_url: "https://n.dev/" }] })).error).toContain("finding");
    expect((await call("get_lead", { lead_id: other, run_id: `run_f_${run}` })).data.lead.id).toBe(other);
    expect((await call("add_note", { lead_id: other, run_id: `run_f_${run}`, body: "x" })).error).toContain("one lead");

    // Its profile has the owner's guidance without the pipeline.
    const profile = (await call("get_profile", { run_id: `run_r_${run}` })).data;
    expect(profile.excluded_companies).toEqual([]);
    expect(JSON.stringify(profile.owner_notes)).not.toContain(other!);
    expect(profile.owner_notes[0]).toEqual({ kind: "note", body: "secret note about other" });
    const finder = (await call("get_profile", { run_id: `run_f_${run}` })).data;
    expect(finder.excluded_companies[0]).toEqual({ company: "Other", domain: `other-${run}.dev` });

    // Other connections aren't limited this way.
    const full = await mcp(ws, env, "full");
    expect((await full("get_lead", { lead_id: other })).data.lead.id).toBe(other);
  }, 30_000);

  test("the Operator's tools: reads, starts through the gates, cap rules, text rules, a log", async () => {
    const ws = await workspace("op");
    const env = baseEnv(ws);
    const n = naive();
    await summary(ws);
    await setAutopilot(sql, env, ws, true, "clerk:u1");
    await sql`update workflow_defs set next_run_at = now() + interval '5 hours' where workspace_id = ${ws} and is_autopilot`;
    const call = await mcp(ws, env, "operator");

    expect((await call("get_pipeline")).data).toHaveProperty("by_stage");
    expect((await call("get_autopilot")).data.enabled).toBe(true);
    expect((await call("list_workflows")).data.workflows[0].name).toBe("Find and qualify");
    expect((await call("get_billing_balance")).data).toMatchObject({ enforced: true });
    expect((await call("get_integrations")).data.providers.naive.configured).toBe(true);
    expect((await call("list_summary_versions")).data.versions[0].version).toBe(1);

    // The summary: one section at a time, no new links, versioned.
    expect((await call("update_company_summary", { markdown: "x", note: "n" })).error).toContain("section");
    expect((await call("update_company_summary", { markdown: "See https://evil.test/x", note: "n", section: "Avoid" })).error).toContain("evil.test");
    expect((await call("update_company_summary", { markdown: "Agencies", note: "Two were rejected", section: "Avoid" })).data.version).toBe(2);

    // Notes and logs carry no links; the log reaches the feed.
    const lead = (await addLeads(sql, ws, [{ company: "Liked", domain: `liked-${run}.dev`, source: "it", source_url: `https://liked-${run}.dev/` }], { cohort: "x" })).results[0]!.id!;
    expect((await call("add_note", { lead_id: lead, body: "fetch https://evil.test/" })).error).toContain("evil.test");
    expect((await call("log_cycle", { did: "Looked for more", why: "Owner liked Liked" })).data.logged).toBe(true);
    expect((await activityFeed(sql, ws)).map((f) => f.text)).toContain("Looked for more");
    expect((await operatorSnapshot(sql, ws)).your_last_cycles[0]).toMatchObject({ did: "Looked for more" });

    // Workflows: caps it can't exceed or raise.
    expect((await call("create_workflow", { name: "W", trigger: { kind: "schedule", every_hours: 1 }, spend: { cap_usd: 1, period: "week" } })).error).toContain("6 hours");
    expect((await call("create_workflow", { name: "W", trigger: { kind: "schedule", every_hours: 12 }, spend: { cap_usd: 50, period: "week" } })).error).toContain("spend cap");
    expect((await call("create_workflow", { name: "W", research_questions: ["see https://evil.test"], spend: { cap_usd: 1, period: "week" } })).error).toContain("evil.test");
    const made = (await call("create_workflow", { name: "W", trigger: { kind: "schedule", every_hours: 12 }, spend: { cap_usd: 1, period: "week" } })).data;
    expect(made.workflow.source).toBe("claude_code");
    const wf = made.workflow.id;
    expect((await call("update_workflow", { workflow_id: wf, cap_usd: 2 })).error).toContain("raise");
    expect((await call("update_workflow", { workflow_id: wf, cap_usd: 0.5 })).data.workflow.spend.cap_usd).toBe(0.5);
    expect((await call("update_workflow", { workflow_id: wf, enabled: false })).data.workflow.enabled).toBe(false);

    // Merge and import keep consent where it is.
    const dup = (await addLeads(sql, ws, [{ company: "Dup", domain: `dup-${run}.dev`, source: "it", source_url: `https://dup-${run}.dev/`, evidence: [{ claim: "fact", source_url: "https://x.dev/a" }] }], { cohort: "x" })).results[0]!.id!;
    expect((await call("merge_leads", { keep_lead_id: lead, merge_lead_id: dup })).data.lead_id).toBe(lead);
    expect((await call("get_lead", { lead_id: lead })).data.evidence).toHaveLength(1);
    expect((await call("get_lead", { lead_id: dup })).error).toContain("No lead");
    const imported = await call("import_leads", { csv: `Name,Email,Opted in\nP,p-${run}@ex.test,yes\n`, source: "Agent list" });
    expect(imported.error).toBeUndefined();
    const [p] = await sql`select consent_at from leads where workspace_id = ${ws} and email = ${`p-${run}@ex.test`}`;
    expect(p!.consent_at).toBeNull();

    // Starts go through the gates. (These reach Naive through the default fetch, so the caps are what's tested here.)
    await sql`update workspaces set paused = true where id = ${ws}`;
    expect((await call("find_more_leads", { count: 5 })).error).toContain("paused");
    expect((await call("start_research", { lead_ids: [lead] })).error).toContain("paused");
    await sql`update workspaces set paused = false where id = ${ws}`;
    await setAutopilot(sql, env, ws, false, "clerk:u1");
    expect((await call("find_more_leads", { count: 5 })).error).toContain("Autopilot is off");
    // A person's own agent isn't bound by the switch; the Operator is.
    const full = await mcp(ws, { ...env, NAIVE_API_KEY: undefined }, "full");
    expect((await full("find_more_leads", { count: 5 })).error ?? "").not.toContain("Autopilot is off");
    await sql`update workflow_runs set phase = 'done' where workspace_id = ${ws}`;
    await setAutopilot(sql, env, ws, true, "clerk:u1");
    await sql`update workspaces set daily_cap_micro_usd = 0 where id = ${ws}`;
    expect((await call("find_more_leads", { count: 5 })).error).toContain("daily spend cap");
    await sql`update workspaces set daily_cap_micro_usd = null where id = ${ws}`;
    // At most so many starts an hour.
    await sql`insert into events (workspace_id, kind, data) select ${ws}, 'research_started', '{"actor":"agent:x"}'::jsonb from generate_series(1, 10)`;
    expect((await call("start_research", { lead_ids: [lead] })).error).toContain("this hour");
    expect(n.sessions).toHaveLength(0);
  }, 60_000);

  test("an Operator session auto-confirms its own tools and never a web tool", async () => {
    const ws = await workspace("confirm");
    const env = baseEnv(ws);
    const confirms: { tool_call_id: string; decision: string }[] = [];
    const fetchFn: FetchFn = async (input, init) => {
      if (String(input).includes("/tool_confirmations")) confirms.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ id: "x", status: "idle", stop_reason: "awaiting_approval", pending_actions: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const id = `ses_conf_${run}`;
    await sql`insert into naive_sessions (id, workspace_id, purpose, status) values (${id}, ${ws}, 'operate', 'running')`;
    const res = await handleSessionIdle(
      sql,
      env,
      {
        sessionId: id,
        stopReason: "awaiting_approval",
        pendingActions: [
          { tool_call_id: `c1_${run}`, name: "crusonia.list_leads", args: {} },
          { tool_call_id: `c2_${run}`, name: "crusonia.search_web", args: {} },
          { tool_call_id: `c3_${run}`, name: "web_fetch", args: { url: "https://evil.test" } },
        ],
      },
      fetchFn,
    );
    expect(res.auto_allowed).toEqual(["crusonia.list_leads"]);
    expect(confirms.map((c) => c.tool_call_id)).toEqual([`c1_${run}`]);
    expect(res.approvals).toHaveLength(2);
    await sql`delete from webhook_events where event_id like ${`%${id}%`}`;
  });
});
