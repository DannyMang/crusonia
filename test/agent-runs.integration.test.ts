// The agent job queue against a real Postgres (a Neon dev branch, never production). Skipped unless TEST_DATABASE_URL
// is set:
//   TEST_DATABASE_URL=<dev branch url> bun test test/agent-runs.integration.test.ts
// Works in its own workspace and deletes it afterwards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getSql, type Sql } from "../src/db.ts";
import type { Env } from "../src/env.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import type { McpRole } from "../src/mcp/toolsets.ts";
import { claimRun, closeRun, countToolCall, expireRuns, newRunId, queueRun, runLimits } from "../src/services/agent-runs.ts";
import { startOperatorCycle } from "../src/services/autopilot.ts";
import { createLead } from "../src/services/crm.ts";
import { getRunDetail } from "../src/services/runs.ts";
import { startResearch } from "../src/services/workflows.ts";
import { createTestWorkspace, deleteTestWorkspaces } from "./helpers/workspace.ts";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const env: Env = { PUBLIC_URL: "https://example.test", MAX_ACTIVE_SESSIONS: "100", PAID_STARTS_PER_HOUR: "100" };
const tag = crypto.randomUUID().slice(0, 8);
let sql: Sql;
let WS: string;

const row = async (id: string) => (await sql`select status, stop_reason, tool_calls, claimed_by, deadline_at, events_seq, leads_processed from agent_runs where id = ${id}`)[0]!;
const lead = (name: string) => createLead(sql, WS, { email: `${name}-${tag}@it.example.com`, name, source: "it_test" }, "test");
const queue = async (purpose: "research" | "operate" | "find_leads" = "find_leads", over: Partial<Env> = {}) => {
  const id = newRunId();
  await queueRun(sql, { ...env, ...over }, { id, ws: WS, purpose, message: `Task for ${id}` });
  return id;
};
/** Claims the next run and checks it is the one the test queued (each test leaves the queue empty). */
const claim = async (id: string, by: { role?: "researcher" | "operator"; actor?: string } = {}) => {
  const run = await claimRun(sql, WS, { role: by.role, actor: by.actor ?? "x" });
  expect(run?.id).toBe(id);
  return run!;
};
/** An MCP client on this workspace with the given role, as an agent holding that role's key sees it. */
async function mcp(role: McpRole) {
  const server = createMcpServer({ ...env, DATABASE_URL: url }, { workspace: { id: WS, owner: false }, role });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: res.isError === true, text: res.content.map((c) => c.text).join("") };
  };
  return { call, close: () => client.close() };
}

suite("agent job queue (database)", () => {
  beforeAll(async () => {
    sql = getSql(url);
    WS = await createTestWorkspace(sql, `runs_${tag}`);
  });
  afterAll(async () => {
    if (sql) await deleteTestWorkspaces(sql, [WS]);
  });

  test("limits come from the purpose: an Operator cycle gets less of everything, and the environment can change both", () => {
    expect(runLimits(env, "research")).toEqual({ minutes: 15, toolCalls: 60, costMicroUsd: 1_000_000 });
    expect(runLimits(env, "operate")).toEqual({ minutes: 10, toolCalls: 25, costMicroUsd: 250_000 });
    expect(runLimits({ ...env, RUN_MAX_TOOL_CALLS: "5", OPERATOR_MAX_COST_USD: "0.1", RUN_MAX_MINUTES: "-1" }, "find_leads")).toEqual({ minutes: 15, toolCalls: 5, costMicroUsd: 1_000_000 });
    expect(runLimits({ ...env, OPERATOR_MAX_COST_USD: "0.1" }, "operate").costMicroUsd).toBe(100_000);
  });

  test("a run waits queued until an agent claims it; a claim hands over the message once, oldest first, by role", async () => {
    const first = await queue("find_leads");
    const operate = await queue("operate");
    const second = await queue("find_leads");
    expect(await row(first)).toMatchObject({ status: "queued", claimed_by: null, deadline_at: null });

    // A researcher never gets the Operator's cycle, and the other way round.
    const a = await claimRun(sql, WS, { role: "researcher", actor: "api_key:k1" });
    expect(a).toMatchObject({ id: first, purpose: "find_leads", role: "researcher", message: `Task for ${first}`, max_tool_calls: 60 });
    const op = await claimRun(sql, WS, { role: "operator", actor: "api_key:k2" });
    expect(op).toMatchObject({ id: operate, role: "operator", max_tool_calls: 25 });
    expect(await claimRun(sql, WS, { role: "operator", actor: "api_key:k2" })).toBeNull();

    const claimed = await row(first);
    expect(claimed).toMatchObject({ status: "running", claimed_by: "api_key:k1" });
    const minutes = (new Date(claimed.deadline_at as string).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);

    // Two agents asking at once get different runs, or nothing.
    const third = await queue("find_leads");
    const both = await Promise.all([claimRun(sql, WS, { actor: "a" }), claimRun(sql, WS, { actor: "b" }), claimRun(sql, WS, { actor: "c" })]);
    expect(both.filter(Boolean).map((r) => r!.id).sort()).toEqual([second, third].sort());
    for (const id of [first, operate, second, third]) await closeRun(sql, id, "finished");
  });

  test("nothing is handed out while the workspace is paused", async () => {
    const id = await queue();
    await sql`update workspaces set paused = true where id = ${WS}`;
    expect(await claimRun(sql, WS, { actor: "a" })).toBeNull();
    await sql`update workspaces set paused = false where id = ${WS}`;
    expect((await claimRun(sql, WS, { actor: "a" }))?.id).toBe(id);
    await closeRun(sql, id, "finished");
  });

  test("every tool call counts; the call past the limit is refused and closes the run", async () => {
    const id = await queue("find_leads", { RUN_MAX_TOOL_CALLS: "2" });
    expect(await countToolCall(sql, WS, id)).toMatchObject({ ok: false, reason: "not_claimed" });
    await claim(id);
    expect(await countToolCall(sql, WS, id)).toMatchObject({ ok: true, id, purpose: "find_leads" });
    expect(await countToolCall(sql, WS, id)).toMatchObject({ ok: true });
    const third = await countToolCall(sql, WS, id);
    expect(third).toMatchObject({ ok: false, reason: "out_of_tool_calls" });
    expect(await row(id)).toMatchObject({ status: "error", stop_reason: "out_of_tool_calls", tool_calls: 2 });
    // Its id no longer works, and says why.
    const after = await countToolCall(sql, WS, id);
    expect(after).toMatchObject({ ok: false, reason: "closed" });
    expect((after as { message: string }).message).toContain("out of tool calls");
    expect(await countToolCall(sql, WS, "run_nope")).toMatchObject({ ok: false, reason: "not_found" });
    // Another workspace's run id is not found either.
    const other = await createTestWorkspace(sql, `runs_other_${tag}`);
    try {
      expect(await countToolCall(sql, other, id)).toMatchObject({ ok: false, reason: "not_found" });
    } finally {
      await deleteTestWorkspaces(sql, [other]);
    }
  });

  test("a run past its deadline is closed by its next tool call, or by the cron if it makes none", async () => {
    const a = await queue();
    const b = await queue();
    await claim(a);
    await claim(b);
    await sql`update agent_runs set deadline_at = now() - interval '1 second' where id = any(${[a, b]}::text[])`;
    expect(await countToolCall(sql, WS, a)).toMatchObject({ ok: false, reason: "out_of_time" });
    expect(await row(a)).toMatchObject({ status: "error", stop_reason: "out_of_time" });
    expect(await expireRuns(sql, env)).toBeGreaterThanOrEqual(1);
    expect(await row(b)).toMatchObject({ status: "error", stop_reason: "out_of_time" });
  });

  test("a queued run nobody claims is closed after the queue's time, and its lead is given back", async () => {
    const l = await lead("unclaimed");
    const { started } = await startResearch(sql, env, WS, { lead_ids: [l.id] }, "test");
    const id = started[0]!.session_id;
    expect((await sql`select stage from leads where id = ${l.id}`)[0]!.stage).toBe("researching");
    expect(await expireRuns(sql, env)).toBe(0); // still inside the hour
    await sql`update agent_runs set created_at = now() - interval '61 minutes' where id = ${id}`;
    expect(await expireRuns(sql, env)).toBe(1);
    expect(await row(id)).toMatchObject({ status: "error", stop_reason: "unclaimed" });
    expect((await sql`select stage from leads where id = ${l.id}`)[0]!.stage).toBe("new");
    // The lead is free again: research can be queued once more.
    const again = await startResearch(sql, env, WS, { lead_ids: [l.id] }, "test");
    expect(again.started).toHaveLength(1);
    await closeRun(sql, again.started[0]!.session_id, "finished");
  });

  test("closing is once: a finished run stays finished, and the timeline says how it ended", async () => {
    const id = await queue();
    await claim(id);
    expect(await closeRun(sql, id, "finished")).toBe(true);
    expect(await closeRun(sql, id, "out_of_time")).toBe(false);
    expect(await row(id)).toMatchObject({ status: "done", stop_reason: "finished" });
    const detail = await getRunDetail(sql, WS, id);
    expect(detail.run).toMatchObject({ status: "done", stop_reason: "finished" });
    expect(detail.steps.map((s) => `${s.source}:${s.summary}`)).toEqual(["crusonia:Picked up by x", "agent:Finished"]);
  });

  test("MCP: a tool call that names a run is counted and written to its trace; a closed run's id is refused", async () => {
    const id = await queue("find_leads", { RUN_MAX_TOOL_CALLS: "2" });
    await claim(id, { role: "researcher", actor: "api_key:k1" });
    const agent = await mcp("researcher");
    try {
      const added = await agent.call("add_leads", { run_id: id, leads: [{ company: `Acme ${tag}`, domain: `acme-${tag}.example.com`, source: "it_test", source_url: `https://acme-${tag}.example.com` }] });
      expect(added.isError).toBe(false);
      expect(await row(id)).toMatchObject({ status: "running", tool_calls: 1, events_seq: 2, leads_processed: 1 });
      const events = await sql`select seq, type, data->>'name' as name, data->>'tool_call_id' as call from agent_run_events where session_id = ${id} order by seq`;
      expect(events.map((e) => `${e.seq}:${e.type}:${e.name}`)).toEqual(["1:tool.started:add_leads", "2:tool.completed:add_leads"]);
      expect(events[0]!.call).toBe(events[1]!.call);

      const profile = await agent.call("get_profile", { run_id: id });
      expect(profile.isError).toBe(false);
      const refused = await agent.call("get_profile", { run_id: id });
      expect(refused).toMatchObject({ isError: true });
      expect(refused.text).toContain("out of tool calls");
      expect(await row(id)).toMatchObject({ status: "error", stop_reason: "out_of_tool_calls", tool_calls: 2 });

      const steps = (await getRunDetail(sql, WS, id)).steps.filter((s) => s.source === "agent").map((s) => `${s.type}:${s.tool ?? s.summary}`);
      expect(steps).toEqual(["tool:add_leads", "tool:get_profile", "status:Stopped: out of tool calls"]);
    } finally {
      await agent.close();
    }
  });

  test("an Operator cycle: queued with the state in its message, limited to one start, and finished by log_cycle", async () => {
    const { run_id: id } = await startOperatorCycle(sql, env, WS, "autopilot:operator");
    const [queued] = await sql`select status, role, message, max_minutes, max_tool_calls, max_cost_micro_usd::text, workflow_version from agent_runs where id = ${id}`;
    expect(queued).toMatchObject({ status: "queued", role: "operator", max_minutes: 10, max_tool_calls: 25, max_cost_micro_usd: "250000", workflow_version: "operator@4" });
    expect(queued!.message).toStartWith("Operate Crusonia for this workspace: one cycle.");
    expect(queued!.message).toContain(`Crusonia run id: ${id}`);

    await claim(id, { role: "operator", actor: "api_key:op" });
    const operator = await mcp("operator");
    try {
      const logged = await operator.call("log_cycle", { run_id: id, did: "Nothing to do", why: "Three drafts wait for the owner" });
      expect(logged.isError).toBe(false);
      expect(await row(id)).toMatchObject({ status: "done", stop_reason: "finished", tool_calls: 1 });
      // The cycle is over: its id no longer works.
      const late = await operator.call("log_cycle", { run_id: id, did: "Again", why: "Too late" });
      expect(late).toMatchObject({ isError: true });
      expect(late.text).toContain("closed");
    } finally {
      await operator.close();
    }
  });
});
