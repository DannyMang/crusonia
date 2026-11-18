// Web app endpoints against a real Postgres (a Neon dev branch, never production).
// Skipped unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=<dev branch url> bun test test/web-api.integration.test.ts
// Everything happens in this suite's own workspaces, which are deleted afterwards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { settleSessionUsage } from "../src/billing/usage.ts";
import { getSql, type Sql } from "../src/db.ts";
import type { Env } from "../src/env.ts";
import { variantFor } from "../src/ids.ts";
import worker from "../src/index.ts";
import { ApiError } from "../src/lib/errors.ts";
import { createApiKey, listApiKeys, revokeApiKey, verifyApiKey } from "../src/services/api-keys.ts";
import { claimRun, closeRun, recordToolCall } from "../src/services/agent-runs.ts";
import { rejectApproval } from "../src/services/approvals.ts";
import { createLead, patchLead } from "../src/services/crm.ts";
import { createDraft } from "../src/services/drafts.ts";
import { getProfile, saveProfile } from "../src/services/profile.ts";
import { listReplies } from "../src/services/replies.ts";
import { getOnboardingProposal, getRunDetail, listWorkflows, startFindLeads, startOnboardingProposal } from "../src/services/runs.ts";
import { setPaused } from "../src/services/settings.ts";
import { getSummary } from "../src/services/summary.ts";
import { getCompanySummary, writeCompanySummary } from "../src/services/company-summary.ts";
import { createTestWorkspace, deleteTestWorkspaces, testKey } from "./helpers/workspace.ts";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const run = crypto.randomUUID().slice(0, 8);
const sid = (name: string) => `ses_it_${run}_${name}`;
const website = `https://acme-${run}.example.com`;
let sql: Sql;
/** This suite's workspace; FIND is a second one with no Company summary yet. */
let WS: string;
let FIND: string;

const env: Env = { PUBLIC_URL: "https://example.test" };

/** An opted-in lead whose email hashes to the wanted variant. */
async function leadIn(variant: "A" | "B", name: string) {
  for (let i = 0; ; i++) {
    const email = `${name}${i}-${run}@it.example.com`;
    if ((await variantFor(email)) === variant) {
      return createLead(sql, WS, { email, name, company: `Co ${name}`, source: "it_web", consent: { text: "integration test opt-in" } }, "test");
    }
  }
}

async function failure(p: Promise<unknown>) {
  const e = await p.then(() => undefined, (err) => err);
  expect(e).toBeInstanceOf(ApiError);
  return `${(e as ApiError).status} ${(e as ApiError).code}`;
}

suite("web app API (database)", () => {
  beforeAll(async () => {
    sql = getSql(url);
    WS = await createTestWorkspace(sql, `web_${run}`);
    FIND = await createTestWorkspace(sql, `find_${run}`);
  });

  afterAll(async () => {
    if (!sql) return;
    await deleteTestWorkspaces(sql, [WS, FIND]);
  });

  test("API keys: created once, stored hashed, accepted by /api and /mcp, refused after revoke", async () => {
    const { api_key, key } = await createApiKey(sql, WS, `it-${run}`, "test");
    expect(key).toMatch(/^crs_live_[0-9a-f]{64}$/);
    expect(api_key).toMatchObject({ name: `it-${run}`, prefix: key.slice(0, 17), status: "active", revoked_at: null, last_used_at: null });
    const listed = (await listApiKeys(sql, WS)).find((k) => k.id === api_key.id)!;
    expect(JSON.stringify(listed)).not.toContain(key.slice(9));
    expect(Object.keys(listed)).not.toContain("hash");
    const [stored] = await sql`select hash from api_keys where id = ${api_key.id}`;
    expect(stored!.hash).not.toContain(key.slice(9));

    const env: Env = { PUBLIC_URL: "https://example.test", DATABASE_URL: url };
    const get = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://example.test${path}`, init), env, {} as ExecutionContext);
    const headers = { Authorization: `Bearer ${key}` };
    const me = await get("/api/me", { headers });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      user: { id: `api_key:${api_key.id}`, name: `it-${run}` },
      auth: "token",
      key: { id: api_key.id, name: `it-${run}` },
      workspace: { id: WS, name: `Test web_${run}`, owner: false, role: "admin" },
    });
    const mcp = await get("/mcp", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "it", version: "0" } } }),
    });
    expect(mcp.status).toBe(200);
    expect(((await mcp.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("crusonia");
    expect((await sql`select last_used_at from api_keys where id = ${api_key.id}`)[0]!.last_used_at).not.toBeNull();

    const revoked = await revokeApiKey(sql, WS, api_key.id, "test");
    expect(revoked.status).toBe("revoked");
    expect(await verifyApiKey(sql, key)).toBeNull();
    expect((await get("/api/me", { headers })).status).toBe(401);
    expect((await get("/mcp", { method: "POST", headers, body: "{}" })).status).toBe(401);
  });

  test("summary: cumulative funnel, where leads are now, pending approvals with lead/company/subject, spend in credits", async () => {
    const before = await getSummary(sql, env, WS);
    const fresh = await leadIn("A", "fresh");
    const met = await leadIn("A", "met");
    await patchLead(sql, WS, met.id, { stage: "meeting_booked" }, "test");
    const awaiting = await leadIn("A", "awaiting");
    await createDraft(sql, WS, { lead_id: awaiting.id, subject: `Hello ${run}`, body: "Body" }, { ttlMinutes: 30, via: "api", actor: "test" });
    const drafted = await leadIn("B", "drafted");
    const d = await createDraft(sql, WS, { lead_id: drafted.id, subject: "Rejected", body: "Body" }, { ttlMinutes: 30, via: "api", actor: "test" });
    await rejectApproval({ sql, ws: WS, env: env, actor: "test", sendTtlMinutes: 30 }, d.approval.code, "no");
    await sql`insert into agent_runs (id, workspace_id, lead_id, purpose, status, consumed_micro_usd, billing_owner_id)
              values (${sid("spend")}, ${WS}, ${fresh.id}, 'research', 'done', 1500000, ${WS})`;
    // Spend is what was charged: the session debits 1.5 USD x 2 = 300 credits.
    expect(await settleSessionUsage(sql, sid("spend"))).toBe(300);

    const after = await getSummary(sql, { ...env, WEEKLY_BUDGET_USD: "20" }, WS);
    // Cumulative: 4 leads found; met, awaiting and drafted got at least to drafted (met is a meeting, so it counts in
    // every step); now: one lead in each bucket it sits in.
    const delta = (k: keyof typeof after.pipeline) => (after.pipeline[k] ?? 0) - (before.pipeline[k] ?? 0);
    expect([delta("found"), delta("researched"), delta("drafted"), delta("sent"), delta("replied"), delta("meetings")]).toEqual([4, 3, 3, 1, 1, 1]);
    expect(delta("awaiting_approval")).toBe(1);
    for (const [a, b] of [["found", "researched"], ["researched", "qualified"], ["qualified", "drafted"], ["drafted", "sent"], ["sent", "replied"], ["replied", "meetings"]] as const) {
      expect(after.pipeline[a] ?? 0).toBeGreaterThanOrEqual(after.pipeline[b] ?? 0);
    }
    const now = (k: keyof typeof after.pipeline_now) => (after.pipeline_now[k] ?? 0) - (before.pipeline_now[k] ?? 0);
    expect([now("found"), now("meetings"), now("awaiting_approval"), now("drafted")]).toEqual([1, 1, 1, 1]);
    expect(after.pending_approvals_total - before.pending_approvals_total).toBe(1);
    expect(after.pending_sends_total - before.pending_sends_total).toBe(1);
    const mine = after.pending_approvals.find((a) => a.lead_id === awaiting.id);
    expect(mine).toMatchObject({ kind: "send", lead_name: "awaiting", company: "Co awaiting", subject: `Hello ${run}` });
    expect(after.spend.budget_usd).toBe(20);
    expect(after.spend).toMatchObject({ day_usd: 1.5, daily_cap_usd: 5 });
    expect(Math.round(((after.spend.week_usd ?? 0) - (before.spend.week_usd ?? 0)) * 100)).toBe(300);
    expect(after.spend.week_credits - before.spend.week_credits).toBe(300);
    expect(Math.round(((after.spend.provider_usd ?? 0) - (before.spend.provider_usd ?? 0)) * 1e6)).toBe(1_500_000);
    expect(after.paused).toBe(false);
    expect(after.total_leads - before.total_leads).toBe(4);
  });

  test("replies: inbound messages with the lead, preview, label and cursor pagination", async () => {
    const lead = await leadIn("B", "replier");
    for (const [i, body] of ["First  reply\n\nwith   spaces", "Second", "Third"].entries()) {
      await sql`insert into messages (workspace_id, lead_id, direction, provider_message_id, thread_id, from_addr, subject, body, label)
                values (${WS}, ${lead.id}, 'in', ${`it-${run}-r${i}`}, ${`thr_${run}_r`}, ${lead.email}, ${`Re ${i}`}, ${body}, ${i === 0 ? "out_of_office" : "other"})`;
    }
    const page1 = await listReplies(sql, WS, { limit: 2, lead_id: lead.id });
    expect(page1.data.map((r) => r.subject)).toEqual(["Re 2", "Re 1"]);
    expect(page1.next_cursor).not.toBeNull();
    const page2 = await listReplies(sql, WS, { limit: 2, lead_id: lead.id, cursor: page1.next_cursor! });
    expect(page2.next_cursor).toBeNull();
    expect(page2.data[0]).toMatchObject({ lead_id: lead.id, from: lead.email, subject: "Re 0", preview: "First reply with spaces", label: "out_of_office" });
    expect(page2.data[0]!.lead).toMatchObject({ id: lead.id, name: "replier", company: "Co replier" });
    expect((await listReplies(sql, WS, { limit: 10, lead_id: lead.id, label: "out_of_office" })).data).toHaveLength(1);
  });

  test("workflows and run detail from the stored trace, with approvals and the lead", async () => {
    const lead = await leadIn("A", "runner");
    const id = sid("research");
    await sql`insert into agent_runs (id, workspace_id, lead_id, purpose, status, created_at, updated_at)
              values (${id}, ${WS}, ${lead.id}, 'research', 'running', now() - interval '5 minutes', now())`;
    const t = (s: number) => new Date(Date.now() - 300_000 + s * 1000).toISOString();
    const events = [
      { seq: 1, type: "message.completed", data: { role: "user", content: "Research lead" }, created_at: t(1) },
      { seq: 2, type: "tool.started", data: { tool_call_id: "tc1", name: "get_lead", args: { lead_id: lead.id } }, created_at: t(2) },
      { seq: 3, type: "tool.completed", data: { tool_call_id: "tc1", name: "get_lead", output: "{}", is_error: false }, created_at: t(3) },
    ];
    await sql`insert into agent_run_events (workspace_id, session_id, seq, type, data, created_at)
              select ${WS}, ${id}, x.seq, x.type, x.data, x.created_at
              from jsonb_to_recordset(${JSON.stringify(events)}::jsonb) as x(seq int, type text, data jsonb, created_at timestamptz)`;
    await sql`insert into events (workspace_id, lead_id, kind, data, created_at) values (${WS}, ${lead.id}, 'research_started', ${JSON.stringify({ session_id: id, actor: "test" })}::jsonb, ${t(0)}::timestamptz)`;
    // The email the run drafted waits for the owner: it shows on the run.
    const { approval } = await createDraft(sql, WS, { lead_id: lead.id, subject: "Hi", body: "Body" }, { ttlMinutes: 60, via: "mcp", actor: `agent:${id}` });

    await setPaused(sql, WS, true, "test");
    const detail = await getRunDetail(sql, WS, id);
    expect(detail.run).toMatchObject({ id, purpose: "research", name: "Lead research", status: "paused", lead_id: lead.id, leads_processed: 1 });
    expect(detail.steps.slice(0, 3).map((s) => s.type)).toEqual(["crusonia", "message", "tool"]);
    expect(detail.steps.map((s) => s.seq)).toEqual(detail.steps.map((_, i) => i + 1));
    expect(detail.steps.find((s) => s.type === "tool")).toMatchObject({ tool: "get_lead", duration_ms: 1000, source: "agent", event_seq: 2 });
    expect(detail.lead).toMatchObject({ id: lead.id, name: "runner" });
    expect(detail.approvals.map((a) => a.code)).toContain(approval.code);
    expect(detail).not.toHaveProperty("sync");

    const workflows = await listWorkflows(sql, WS, { recentRuns: 50 });
    const research = workflows.find((w) => w.purpose === "research")!;
    expect(research).toMatchObject({ name: "Lead research", status: "paused" }); // the workspace is paused
    expect(research.runs.find((r) => r.id === id)).toMatchObject({ status: "paused" });
    await setPaused(sql, WS, false, "test");
    expect((await getRunDetail(sql, WS, id)).run.status).toBe("running");
    await expect(getRunDetail(sql, WS, sid("missing"))).rejects.toThrow("No workflow run");
    // Another workspace cannot see the run.
    await expect(getRunDetail(sql, FIND, id)).rejects.toThrow("No workflow run");
  });

  test("run detail reads the trace Crusonia wrote: add_leads results count, and the end is a step", async () => {
    const id = sid("find");
    await sql`insert into agent_runs (id, workspace_id, lead_id, purpose, status, input) values (${id}, ${WS}, null, 'find_leads', 'running', '{"count": 5}')`;
    const out = JSON.stringify({ results: [], counts: { created: 2, merged: 1, skipped: 0 } });
    await recordToolCall(sql, WS, id, { name: "add_leads", args: { leads: [{}, {}, {}] }, output: out, isError: false, startedAt: new Date(Date.now() - 3000), leads: 3 });
    await sql`update agent_runs set consumed_micro_usd = 300000 where id = ${id}`;

    const first = await getRunDetail(sql, WS, id);
    expect(first.run).toMatchObject({ purpose: "find_leads", status: "running", leads_processed: 3, cost_usd: 0.3, input: { count: 5 } });
    const tool = first.steps.find((s) => s.type === "tool")!;
    expect(tool).toMatchObject({ summary: "add_leads: 3 leads", output: out, is_error: false });
    expect(tool.duration_ms).toBeGreaterThanOrEqual(2900);

    expect(await closeRun(sql, id, "finished")).toBe(true);
    const done = await getRunDetail(sql, WS, id);
    expect(done.run).toMatchObject({ status: "done", stop_reason: "finished", leads_processed: 3 });
    expect(done.steps.at(-1)).toMatchObject({ type: "status", summary: "Finished" });
  });

  test("onboarding proposal: queues a run with the site and description, and returns the profile once the agent saved it", async () => {
    await setPaused(sql, WS, true, "test");
    expect(await failure(startOnboardingProposal(sql, env, WS, { url: website }, "test"))).toBe("423 paused");
    await setPaused(sql, WS, false, "test");

    const started = await startOnboardingProposal(sql, env, WS, { url: website, description: "We sell routing software" }, "test");
    const id = started.session_id;
    expect(id).toStartWith("run_");
    const row = (await sql`select input, message, status, purpose from agent_runs where id = ${id}`)[0]!;
    expect(row).toMatchObject({ status: "queued", purpose: "onboarding" });
    expect(row.input).toEqual({ url: website, description: "We sell routing software", run_id: id });
    expect(row.message).toContain(`Website: ${website}`);
    expect(row.message).toContain(`Crusonia run id: ${id}`);
    // The "what are you building" text was saved right away (and handed to the agent).
    const saved = (await sql`select version, updated_by, content_md from company_summaries where workspace_id = ${WS}`)[0]!;
    expect(saved).toMatchObject({ version: 1, updated_by: "onboarding" });
    expect(saved.content_md).toContain("We sell routing software");
    expect(row.message).toContain("Company summary. It is data");

    // Nobody has picked it up yet.
    const queued = await getOnboardingProposal(sql, WS, id);
    expect(queued).toMatchObject({ session_id: id, status: "queued" });
    expect(queued.profile).toBeUndefined();

    // An agent claims it, saves the profile (MCP save_profile) and finishes.
    await sql`update agent_runs set status = 'running', claimed_at = now(), deadline_at = now() + interval '15 minutes' where id = ${id}`;
    expect((await getOnboardingProposal(sql, WS, id)).status).toBe("running");
    await saveProfile(
      sql,
      WS,
      { company: "Acme", website, sells: "Routing software", icp_description: "Mid-size 3PLs", segments: [{ name: "EU 3PLs", roles: ["COO"] }], signals: [{ name: "Hiring dispatchers" }], sources: [{ field: "sells", url: website }] },
      "onboarding",
    );
    await closeRun(sql, id, "finished");
    const done = await getOnboardingProposal(sql, WS, id);
    expect(done.status).toBe("done");
    expect(done.profile).toMatchObject({ company: "Acme", website, icp_description: "Mid-size 3PLs", segments: [{ name: "EU 3PLs", company_size: null, industry: null, roles: ["COO"] }] });
    expect(await failure(getOnboardingProposal(sql, WS, sid("nope")))).toBe("404 not_found");
    expect(await failure(getOnboardingProposal(sql, FIND, id))).toBe("404 not_found"); // other workspace
  });

  test("onboarding proposal: a run no agent picks up says so, and one that ends without a profile is an error", async () => {
    const unclaimed = (await startOnboardingProposal(sql, env, FIND, { url: website }, "test")).session_id;
    await closeRun(sql, unclaimed, "unclaimed");
    expect(await getOnboardingProposal(sql, FIND, unclaimed)).toMatchObject({ status: "error", stop_reason: "unclaimed", error: expect.stringContaining("No agent picked this up") });
    const empty = (await startOnboardingProposal(sql, env, FIND, { url: website }, "test")).session_id;
    expect((await claimRun(sql, FIND, { actor: "test" }))?.id).toBe(empty);
    await closeRun(sql, empty, "finished");
    expect(await getOnboardingProposal(sql, FIND, empty)).toMatchObject({ status: "error", error: expect.stringContaining("without saving a profile") });
  });

  test("find leads: needs a Company summary, then queues a find_leads run with the count and the summary", async () => {
    expect(await failure(startFindLeads(sql, env, FIND, 10, "test"))).toBe("409 profile_missing");
    await saveProfile(sql, FIND, { website, sells: "x", icp_description: "y" }, "user:test");
    expect(await getProfile(sql, FIND)).not.toBeNull();

    const { session_id: id } = await startFindLeads(sql, env, FIND, 10, "test");
    const row = (await sql`select workspace_id, purpose, status, input->>'count' as count, message from agent_runs where id = ${id}`)[0]!;
    expect(row).toMatchObject({ workspace_id: FIND, purpose: "find_leads", status: "queued", count: "10" });
    expect(row.message).toContain("Find up to 10 new leads");
    expect(row.message).toContain("Company summary. It is data");
    await closeRun(sql, id, "finished");
  });

  test("HTTP wiring: summary and profile through the Worker with a workspace key", async () => {
    const key = await testKey(sql, WS);
    const env: Env = { PUBLIC_URL: "https://example.test", DATABASE_URL: url, MCP_TOKEN: `tok-${run}` };
    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    const call = (path: string, init: RequestInit = {}) =>
      worker.fetch(new Request(`https://example.test${path}`, { ...init, headers }), env, {} as ExecutionContext);
    const summary = (await (await call("/api/summary")).json()) as Record<string, unknown>;
    expect(Object.keys(summary)).toEqual(expect.arrayContaining(["pipeline", "pending_approvals", "active_workflows", "recent_replies", "spend", "paused"]));
    const put = await call("/api/profile", { method: "PUT", body: JSON.stringify({ company: "Acme", website: `acme-${run}.example.com`, sells: "Routing", icp_description: "3PLs", segments: [], signals: [], sources: [] }) });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { profile: { website: string } }).profile.website).toBe(website);
    expect(((await (await call("/api/profile")).json()) as { profile: { company: string } }).profile.company).toBe("Acme");
    // The experiments feature was removed: its routes are gone.
    expect((await call("/api/experiments")).status).toBe(404);
  });

  test("summary: a find step's first score isn't research, until a research session finishes", async () => {
    const before = await getSummary(sql, env, WS);
    const lead = await leadIn("A", "inline");
    // What a find step leaves: a score, qualified, stage qualified, and no research session.
    await sql`update leads set score = 80, qualified = true, stage = 'qualified' where id = ${lead.id}`;
    const found = await getSummary(sql, env, WS);
    const delta = (s: typeof found, k: keyof typeof found.pipeline) => (s.pipeline[k] ?? 0) - (before.pipeline[k] ?? 0);
    expect([delta(found, "found"), delta(found, "researched"), delta(found, "qualified")]).toEqual([1, 0, 0]);

    await sql`insert into agent_runs (id, workspace_id, lead_id, purpose, status) values (${sid("inline")}, ${WS}, ${lead.id}, 'research', 'done')`;
    const researched = await getSummary(sql, env, WS);
    expect([delta(researched, "found"), delta(researched, "researched"), delta(researched, "qualified")]).toEqual([1, 1, 1]);
  });

  test("summary: spend counts a running session's use so far, then the same once it's debited", async () => {
    const before = (await getSummary(sql, env, WS)).spend.week_credits;
    const lead = await leadIn("A", "open");
    await sql`insert into agent_runs (id, workspace_id, lead_id, purpose, status, consumed_micro_usd, billing_owner_id)
              values (${sid("open")}, ${WS}, ${lead.id}, 'research', 'running', 100000, ${WS})`;
    expect((await getSummary(sql, env, WS)).spend.week_credits - before).toBe(20);
    await sql`update agent_runs set status = 'done' where id = ${sid("open")}`;
    await settleSessionUsage(sql, sid("open"));
    expect((await getSummary(sql, env, WS)).spend.week_credits - before).toBe(20);
  });
  test("saving the profile unchanged keeps what was written by hand in the Company summary", async () => {
    const ws = FIND;
    await saveProfile(sql, ws, { website: "https://acme.test", sells: "Things", icp_description: "Teams" }, "user:test");
    const first = await getCompanySummary(sql, ws);
    const edited = `${first.markdown}\n\nBest fit today: teams with a public API.\n`;
    await writeCompanySummary(sql, ws, { markdown: edited, author: "user:test" });
    const unchanged = await getProfile(sql, ws);
    const { updated_at: _u, ...input } = unchanged as NonNullable<typeof unchanged> & { updated_at?: unknown };
    await saveProfile(sql, ws, input as Parameters<typeof saveProfile>[2], "user:test");
    expect((await getCompanySummary(sql, ws)).markdown).toContain("Best fit today");
    // A real change still saves.
    await saveProfile(sql, ws, { ...input, sells: "Better things" } as Parameters<typeof saveProfile>[2], "user:test");
    expect((await getCompanySummary(sql, ws)).markdown).toContain("Better things");
  });
});
