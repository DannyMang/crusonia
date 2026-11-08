// Web app endpoints against a real Postgres (a Neon dev branch, never production) with Naive mocked at fetch.
// Skipped unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=<dev branch url> bun test test/web-api.integration.test.ts
// Rows are marked with this run's id and deleted afterwards; the saved profile and pause flag are restored.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { settleSessionUsage } from "../src/billing/usage.ts";
import { getSql, type Sql } from "../src/db.ts";
import type { Env } from "../src/env.ts";
import { variantFor } from "../src/ids.ts";
import worker from "../src/index.ts";
import { ApiError } from "../src/lib/errors.ts";
import type { FetchFn } from "../src/providers/http.ts";
import { createApiKey, listApiKeys, revokeApiKey, verifyApiKey } from "../src/services/api-keys.ts";
import { createAgentApproval, rejectApproval } from "../src/services/approvals.ts";
import { createLead, patchLead } from "../src/services/crm.ts";
import { createDraft } from "../src/services/drafts.ts";
import { createExperiment, enrollLeads, getExperiment, listExperiments, stopExperiment } from "../src/services/experiments.ts";
import { getProfile, saveProfile } from "../src/services/profile.ts";
import { listReplies } from "../src/services/replies.ts";
import { getOnboardingProposal, getRunDetail, listWorkflows, startFindLeads, startOnboardingProposal } from "../src/services/runs.ts";
import { setPaused } from "../src/services/settings.ts";
import { getSummary } from "../src/services/summary.ts";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const run = crypto.randomUUID().slice(0, 8);
const sid = (name: string) => `ses_it_${run}_${name}`;
const website = `https://acme-${run}.example.com`;
let sql: Sql;
let originalProfile: unknown;
let originalPaused: unknown;
const experimentIds: string[] = [];
const keyIds: string[] = [];

type Call = { method: string; url: string; body: any };
function naive(routes: ((c: Call) => unknown)[]) {
  const calls: Call[] = [];
  const fn: FetchFn = async (u, init = {}) => {
    const call = { method: init.method ?? "GET", url: u, body: init.body ? JSON.parse(init.body as string) : undefined };
    calls.push(call);
    for (const r of routes) {
      const body = r(call);
      if (body !== undefined) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unmocked" }), { status: 404 });
  };
  return { fn, calls };
}

const naiveEnv: Env = { PUBLIC_URL: "https://example.test", NAIVE_API_KEY: "nv_test", NAIVE_AGENT_ID: "agt_test" };

/** An opted-in lead whose email hashes to the wanted variant. */
async function leadIn(variant: "A" | "B", name: string) {
  for (let i = 0; ; i++) {
    const email = `${name}${i}-${run}@it.example.com`;
    if ((await variantFor(email)) === variant) {
      return createLead(sql, { email, name, company: `Co ${name}`, source: "it_web", consent: { text: "integration test opt-in" } }, "test");
    }
  }
}

async function failure(p: Promise<unknown>) {
  const e = await p.then(() => undefined, (err) => err);
  expect(e).toBeInstanceOf(ApiError);
  return `${(e as ApiError).status} ${(e as ApiError).code}`;
}

suite("web app API (database, mocked Naive)", () => {
  beforeAll(async () => {
    sql = getSql(url);
    originalProfile = (await sql`select value from settings where key = 'profile'`)[0]?.value ?? null;
    originalPaused = (await sql`select value from settings where key = 'paused'`)[0]?.value ?? false;
    await setPaused(sql, false, "test");
  });

  afterAll(async () => {
    if (!sql) return;
    const ids = (await sql`select id from leads where email like ${`%-${run}@it.example.com`}`).map((r) => r.id as string);
    await sql.transaction([
      sql`delete from events where lead_id = any(${ids}::text[])
            or data->>'session_id' like ${`ses_it_${run}%`}
            or data->>'experiment_id' = any(${experimentIds}::text[])
            or data->>'key_id' = any(${keyIds}::text[])
            or (kind = 'profile_saved' and data->>'website' = ${website})
            or (kind in ('settings_paused', 'settings_resumed') and data->>'actor' = 'test')`,
      sql`delete from leads where id = any(${ids}::text[])`,
      sql`delete from naive_sessions where id like ${`ses_it_${run}%`}`,
      sql`delete from experiments where id = any(${experimentIds}::text[])`,
      sql`delete from api_keys where id = any(${keyIds}::text[])`,
      originalProfile
        ? sql`update settings set value = ${JSON.stringify(originalProfile)}::jsonb where key = 'profile'`
        : sql`delete from settings where key = 'profile'`,
      sql`update settings set value = ${JSON.stringify(originalPaused)}::jsonb where key = 'paused'`,
    ]);
    await sql.transaction([
      sql`set local crusonia.allow_ledger_delete = 'on'`,
      sql`delete from credit_ledger where owner_id = ${`it-owner-${run}`}`,
    ]);
    await sql`delete from events where kind = 'billing_usage_debited' and data->>'owner_id' = ${`it-owner-${run}`}`;
  });

  test("API keys: created once, stored hashed, accepted by /api and /mcp, refused after revoke", async () => {
    const { api_key, key } = await createApiKey(sql, `it-${run}`, "test");
    keyIds.push(api_key.id);
    expect(key).toMatch(/^crs_live_[0-9a-f]{64}$/);
    expect(api_key).toMatchObject({ name: `it-${run}`, prefix: key.slice(0, 17), status: "active", revoked_at: null, last_used_at: null });
    const listed = (await listApiKeys(sql)).find((k) => k.id === api_key.id)!;
    expect(JSON.stringify(listed)).not.toContain(key.slice(9));
    expect(Object.keys(listed)).not.toContain("hash");
    const [stored] = await sql`select hash from api_keys where id = ${api_key.id}`;
    expect(stored!.hash).not.toContain(key.slice(9));

    const env: Env = { PUBLIC_URL: "https://example.test", DATABASE_URL: url };
    const get = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://example.test${path}`, init), env, {} as ExecutionContext);
    const headers = { Authorization: `Bearer ${key}` };
    const me = await get("/api/me", { headers });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ user: { id: `api_key:${api_key.id}`, name: `it-${run}` }, auth: "token", key: { id: api_key.id, name: `it-${run}` } });
    const mcp = await get("/mcp", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "it", version: "0" } } }),
    });
    expect(mcp.status).toBe(200);
    expect(((await mcp.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("crusonia");
    expect((await sql`select last_used_at from api_keys where id = ${api_key.id}`)[0]!.last_used_at).not.toBeNull();

    const revoked = await revokeApiKey(sql, api_key.id, "test");
    expect(revoked.status).toBe("revoked");
    expect(await verifyApiKey(sql, key)).toBeNull();
    expect((await get("/api/me", { headers })).status).toBe(401);
    expect((await get("/mcp", { method: "POST", headers, body: "{}" })).status).toBe(401);
  });

  test("summary: cumulative funnel, where leads are now, pending approvals with lead/company/subject, spend in credits", async () => {
    const before = await getSummary(sql, naiveEnv);
    const fresh = await leadIn("A", "fresh");
    const met = await leadIn("A", "met");
    await patchLead(sql, met.id, { stage: "meeting_booked" }, "test");
    const awaiting = await leadIn("A", "awaiting");
    await createDraft(sql, { lead_id: awaiting.id, subject: `Hello ${run}`, body: "Body" }, { ttlMinutes: 30, via: "api", actor: "test" });
    const drafted = await leadIn("B", "drafted");
    const d = await createDraft(sql, { lead_id: drafted.id, subject: "Rejected", body: "Body" }, { ttlMinutes: 30, via: "api", actor: "test" });
    await rejectApproval({ sql, env: naiveEnv, actor: "test", sendTtlMinutes: 30 }, d.approval.code, "no");
    await sql`insert into naive_sessions (id, lead_id, purpose, status, consumed_micro_usd, billing_owner_id)
              values (${sid("spend")}, ${fresh.id}, 'research', 'done', 1500000, ${`it-owner-${run}`})`;
    // Spend is what was charged: the session debits 1.5 USD x 2 = 300 credits.
    expect(await settleSessionUsage(sql, sid("spend"))).toBe(300);

    const after = await getSummary(sql, { ...naiveEnv, WEEKLY_BUDGET_USD: "20" });
    // Cumulative: 4 leads found; met, awaiting and drafted got at least to drafted (met is a meeting, so it counts in
    // every step); now: one lead in each bucket it sits in.
    const delta = (k: keyof typeof after.pipeline) => after.pipeline[k] - before.pipeline[k];
    expect([delta("found"), delta("researched"), delta("drafted"), delta("sent"), delta("replied"), delta("meetings")]).toEqual([4, 3, 3, 1, 1, 1]);
    expect(delta("awaiting_approval")).toBe(1);
    for (const [a, b] of [["found", "researched"], ["researched", "drafted"], ["drafted", "sent"], ["sent", "replied"], ["replied", "meetings"]] as const) {
      expect(after.pipeline[a]).toBeGreaterThanOrEqual(after.pipeline[b]);
    }
    const now = (k: keyof typeof after.pipeline_now) => after.pipeline_now[k] - before.pipeline_now[k];
    expect([now("found"), now("meetings"), now("awaiting_approval"), now("drafted")]).toEqual([1, 1, 1, 1]);
    expect(after.pending_approvals_total - before.pending_approvals_total).toBe(1);
    expect(after.pending_sends_total - before.pending_sends_total).toBe(1);
    const mine = after.pending_approvals.find((a) => a.lead_id === awaiting.id);
    expect(mine).toMatchObject({ kind: "send", lead_name: "awaiting", company: "Co awaiting", subject: `Hello ${run}` });
    expect(after.spend.budget_usd).toBe(20);
    expect(Math.round(((after.spend.week_usd ?? 0) - (before.spend.week_usd ?? 0)) * 100)).toBe(300);
    expect(after.spend.week_credits - before.spend.week_credits).toBe(300);
    expect(Math.round(((after.spend.provider_usd ?? 0) - (before.spend.provider_usd ?? 0)) * 1e6)).toBe(1_500_000);
    expect(after.paused).toBe(false);
    expect(after.total_leads - before.total_leads).toBe(4);
  });

  test("experiments: enrollment, drafts tagged per arm, stats from sends and reply labels, daily series, stop", async () => {
    const a = await leadIn("A", "expa");
    const b = await leadIn("B", "expb");
    const { experiment, enrollment } = await createExperiment(
      sql,
      { name: `it-${run}`, hypothesis: "Short subject lines get more replies", metric: "positive_reply_rate", stop_rule_sends_per_arm: 1, variants: { A: { name: "Short" }, B: { name: "Long" } }, lead_ids: [a.id, b.id, "lead_missing"] },
      "test",
    );
    experimentIds.push(experiment.id);
    expect(enrollment).toEqual({ enrolled: 2, skipped: ["lead_missing"] });
    expect(experiment).toMatchObject({ status: "running", enrolled: { A: 1, B: 1 }, variants: { A: { name: "Short" }, B: { name: "Long" } } });

    const da = await createDraft(sql, { lead_id: a.id, subject: "Hi", body: "A" }, { ttlMinutes: 30 });
    const db = await createDraft(sql, { lead_id: b.id, subject: "Hello there", body: "B" }, { ttlMinutes: 30 });
    expect([da.draft.experiment_id, db.draft.experiment_id]).toEqual([experiment.id, experiment.id]);
    // Simulate the send path's result, then a positive reply from A.
    await sql`update drafts set status = 'sent', sending_at = now() - interval '1 minute' where id = any(${[da.draft.id, db.draft.id]}::text[])`;
    await sql`insert into messages (lead_id, direction, provider_message_id, thread_id, from_addr, subject, body, label)
              values (${a.id}, 'in', ${`it-${run}-reply-a`}, ${`thr_${run}_a`}, ${a.email}, 'Re: Hi', 'Sounds good, let''s talk', 'interested')`;
    await sql`insert into naive_sessions (id, lead_id, purpose, status, consumed_micro_usd) values (${sid("expcost")}, ${a.id}, 'research', 'done', 250000)`;

    const { experiment: detail, daily } = await getExperiment(sql, experiment.id);
    expect(detail.stats).toEqual({ A: { sent: 1, replies: 1, positive: 1, cost_usd: 0.25 }, B: { sent: 1, replies: 0, positive: 0, cost_usd: null } });
    expect(detail).toMatchObject({ stop_rule_met: true, stop_rule_reason: "Both arms reached 1 sends" });
    expect(daily.at(-1)).toMatchObject({ A_replies: 1, B_replies: 0, A_sent: 1, B_sent: 1 });
    expect((await listExperiments(sql)).find((e) => e.id === experiment.id)?.stats.A.replies).toBe(1);

    // A lead in a running experiment is not enrolled in another one.
    const other = await createExperiment(sql, { name: `it-${run}-other`, metric: "reply_rate", lead_ids: [a.id] }, "test");
    experimentIds.push(other.experiment.id);
    expect(other.enrollment).toEqual({ enrolled: 0, skipped: [a.id] });

    const stopped = await stopExperiment(sql, experiment.id, "test");
    expect(stopped.status).toBe("stopped");
    expect(stopped.stopped_at).not.toBeNull();
    expect(stopped.stop_rule_met).toBe(false);
    const late = await createDraft(sql, { lead_id: b.id, subject: "Follow-up", body: "B2" }, { ttlMinutes: 30 });
    expect(late.draft.experiment_id).toBeNull();
    await expect(enrollLeads(sql, experiment.id, [b.id], "test")).rejects.toThrow("only running experiments take new leads");
  });

  test("replies: inbound messages with the lead, preview, label and cursor pagination", async () => {
    const lead = await leadIn("B", "replier");
    for (const [i, body] of ["First  reply\n\nwith   spaces", "Second", "Third"].entries()) {
      await sql`insert into messages (lead_id, direction, provider_message_id, thread_id, from_addr, subject, body, label)
                values (${lead.id}, 'in', ${`it-${run}-r${i}`}, ${`thr_${run}_r`}, ${lead.email}, ${`Re ${i}`}, ${body}, ${i === 0 ? "out_of_office" : "other"})`;
    }
    const page1 = await listReplies(sql, { limit: 2, lead_id: lead.id });
    expect(page1.data.map((r) => r.subject)).toEqual(["Re 2", "Re 1"]);
    expect(page1.next_cursor).not.toBeNull();
    const page2 = await listReplies(sql, { limit: 2, lead_id: lead.id, cursor: page1.next_cursor! });
    expect(page2.next_cursor).toBeNull();
    expect(page2.data[0]).toMatchObject({ lead_id: lead.id, from: lead.email, subject: "Re 0", preview: "First reply with spaces", label: "out_of_office" });
    expect(page2.data[0]!.lead).toMatchObject({ id: lead.id, name: "replier", company: "Co replier" });
    expect((await listReplies(sql, { limit: 10, lead_id: lead.id, label: "out_of_office" })).data).toHaveLength(1);
  });

  test("workflows and run detail from stored events (no Naive key), with approvals and the lead", async () => {
    const lead = await leadIn("A", "runner");
    const id = sid("research");
    await sql`insert into naive_sessions (id, lead_id, purpose, status, stop_reason, created_at, updated_at)
              values (${id}, ${lead.id}, 'research', 'idle', 'budget_paused', now() - interval '5 minutes', now())`;
    const t = (s: number) => new Date(Date.now() - 300_000 + s * 1000).toISOString();
    const events = [
      { seq: 1, type: "message.completed", data: { role: "user", content: "Research lead" }, created_at: t(1) },
      { seq: 2, type: "tool.started", data: { tool_call_id: "tc1", name: "crusonia.get_lead", args: { lead_id: lead.id } }, created_at: t(2) },
      { seq: 3, type: "tool.completed", data: { tool_call_id: "tc1", name: "crusonia.get_lead", output: "{}", is_error: false }, created_at: t(3) },
      { seq: 4, type: "session.idle", data: { stop_reason: "budget_paused" }, created_at: t(4) },
    ];
    await sql`insert into naive_session_events (session_id, seq, type, data, created_at)
              select ${id}, x.seq, x.type, x.data, x.created_at
              from jsonb_to_recordset(${JSON.stringify(events)}::jsonb) as x(seq int, type text, data jsonb, created_at timestamptz)`;
    await sql`insert into events (lead_id, kind, data, created_at) values (${lead.id}, 'research_started', ${JSON.stringify({ session_id: id, actor: "test" })}::jsonb, ${t(0)}::timestamptz)`;
    const code = await createAgentApproval(sql, { sessionId: id, leadId: lead.id, action: { tool_call_id: "tc9", name: "web_fetch", args: { url: "https://x.test" } }, ttlMinutes: 30 });

    const detail = await getRunDetail(sql, { PUBLIC_URL: "https://example.test" }, id);
    expect(detail.run).toMatchObject({ id, purpose: "research", name: "Lead research", status: "paused", lead_id: lead.id, leads_processed: 1 });
    // The approval was requested just now, after the stored events: steps are in time order.
    expect(detail.steps.map((s) => s.type)).toEqual(["crusonia", "message", "tool", "status", "crusonia"]);
    expect(detail.steps.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(detail.steps.find((s) => s.type === "tool")).toMatchObject({ tool: "get_lead", duration_ms: 1000 });
    expect(detail.lead).toMatchObject({ id: lead.id, name: "runner" });
    expect(detail.approvals.map((a) => a.code)).toContain(code);
    expect(detail.sync.skipped).toContain("NAIVE_API_KEY");

    const workflows = await listWorkflows(sql, { recentRuns: 50 });
    const research = workflows.find((w) => w.purpose === "research")!;
    expect(research).toMatchObject({ name: "Lead research", status: "paused" }); // our budget_paused run
    expect(research.runs.find((r) => r.id === id)).toMatchObject({ status: "paused" });
    await expect(getRunDetail(sql, naiveEnv, sid("missing"))).rejects.toThrow("No workflow run");
  });

  test("run detail syncs Naive events once per change: counts add_leads results and spend", async () => {
    const id = sid("find");
    await sql`insert into naive_sessions (id, lead_id, purpose, status, input) values (${id}, null, 'find_leads', 'running', '{"count": 5}')`;
    const t = (s: number) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
    const out = JSON.stringify({ results: [], counts: { added: 2, updated: 1, skipped: 0 } });
    let served = false;
    const mock = naive([
      (c) => {
        if (!c.url.includes(`/v1/sessions/${id}/events`)) return undefined;
        const page = served
          ? []
          : [
              { seq: 1, type: "session.running", data: {}, created_at: t(0) },
              { seq: 2, type: "tool.started", data: { tool_call_id: "a", name: "crusonia.add_leads", args: { leads: [{}, {}, {}] } }, created_at: t(1) },
              { seq: 3, type: "tool.completed", data: { tool_call_id: "a", name: "crusonia.add_leads", output: out, is_error: false }, created_at: t(4) },
              { seq: 4, type: "session.usage", data: { consumed_micro_usd: 300000 }, created_at: t(5) },
            ];
        served = true;
        return { data: page, has_more: false, next_cursor: null };
      },
    ]);
    const first = await getRunDetail(sql, naiveEnv, id, mock.fn);
    expect(first.sync).toEqual({ ok: true, fetched: 4 });
    expect(first.run).toMatchObject({ purpose: "find_leads", status: "running", leads_processed: 3, cost_usd: 0.3, input: { count: 5 } });
    expect(first.steps.find((s) => s.type === "tool")).toMatchObject({ summary: "add_leads: 3 leads", duration_ms: 3000 });
    expect(mock.calls[0]!.url).toContain("after_seq=0");
    expect(mock.calls[0]!.url).toContain("include_accepted=true");

    await getRunDetail(sql, naiveEnv, id, mock.fn); // synced < 2 s ago: served from the cache
    expect(mock.calls).toHaveLength(1);

    await sql`update naive_sessions set status = 'done', updated_at = now() where id = ${id}`;
    const done = await getRunDetail(sql, naiveEnv, id, mock.fn); // changed since the last sync: one more read
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]!.url).toContain("after_seq=4");
    expect(done.run).toMatchObject({ status: "done", leads_processed: 3 });
    await getRunDetail(sql, naiveEnv, id, mock.fn); // finished and synced: no more reads
    expect(mock.calls).toHaveLength(2);
  });

  test("onboarding proposal: starts a session, polls Naive while active, returns the saved profile", async () => {
    const id = sid("onb");
    const mock = naive([
      (c) => (c.method === "POST" && c.url.endsWith("/v1/sessions") ? { id, status: "queued" } : undefined),
      (c) =>
        c.method === "GET" && c.url.endsWith(`/v1/sessions/${id}`)
          ? { id, status: "idle", stop_reason: "end_turn", pending_actions: [], consumed_micro_usd: 420000 }
          : undefined,
    ]);
    await setPaused(sql, true, "test");
    expect(await failure(startOnboardingProposal(sql, naiveEnv, { url: website }, "test", mock.fn))).toBe("423 paused");
    await setPaused(sql, false, "test");

    const started = await startOnboardingProposal(sql, naiveEnv, { url: website, description: "We sell routing software" }, "test", mock.fn);
    expect(started).toEqual({ session_id: id });
    const create = mock.calls.find((c) => c.method === "POST")!;
    expect(create.body).toMatchObject({ agent_id: "agt_test", metadata: { purpose: "onboarding" } });
    expect(create.body.message).toContain(`Website: ${website}`);
    expect((await sql`select input from naive_sessions where id = ${id}`)[0]!.input).toEqual({ url: website, description: "We sell routing software" });

    // Fresh row: answered locally, no Naive read yet.
    const running = await getOnboardingProposal(sql, naiveEnv, id, mock.fn);
    expect(running).toMatchObject({ session_id: id, status: "running", waiting_on: null });
    expect(running.profile).toBeUndefined();
    expect(mock.calls.filter((c) => c.method === "GET")).toHaveLength(0);

    // The agent saves the profile (MCP save_profile), Naive reports the turn finished.
    await saveProfile(sql, { company: "Acme", website, sells: "Routing software", icp_description: "Mid-size 3PLs", segments: [{ name: "EU 3PLs", roles: ["COO"] }], signals: [{ name: "Hiring dispatchers" }], sources: [{ field: "sells", url: website }] });
    await sql`update naive_sessions set updated_at = now() - interval '10 seconds' where id = ${id}`;
    const done = await getOnboardingProposal(sql, naiveEnv, id, mock.fn);
    expect(done.status).toBe("done");
    expect(done.profile).toMatchObject({ company: "Acme", website, icp_description: "Mid-size 3PLs", segments: [{ name: "EU 3PLs", company_size: null, industry: null, roles: ["COO"] }] });
    expect((await sql`select status, consumed_micro_usd::int as micro from naive_sessions where id = ${id}`)[0]).toEqual({ status: "done", micro: 420000 });
    expect(await failure(getOnboardingProposal(sql, naiveEnv, sid("nope"), mock.fn))).toBe("404 not_found");
  });

  test("find leads: needs a saved profile, then starts a find_leads session with the count", async () => {
    const id = sid("findstart");
    const mock = naive([(c) => (c.method === "POST" && c.url.endsWith("/v1/sessions") ? { id, status: "queued" } : undefined)]);
    const saved = (await sql`select value from settings where key = 'profile'`)[0]?.value;
    await sql`delete from settings where key = 'profile'`;
    expect(await failure(startFindLeads(sql, naiveEnv, 10, "test", mock.fn))).toBe("409 profile_missing");
    expect(mock.calls).toHaveLength(0);
    if (saved) await sql`insert into settings (key, value) values ('profile', ${JSON.stringify(saved)}::jsonb)`;
    else await saveProfile(sql, { website, sells: "x", icp_description: "y" });
    expect(await getProfile(sql)).not.toBeNull();

    expect(await startFindLeads(sql, naiveEnv, 10, "test", mock.fn)).toEqual({ session_id: id });
    expect(mock.calls[0]!.body.message).toContain("Find up to 10 new leads");
    expect((await sql`select purpose, status, input from naive_sessions where id = ${id}`)[0]).toEqual({ purpose: "find_leads", status: "running", input: { count: 10 } });
  });

  test("HTTP wiring: summary, profile and experiments through the Worker with MCP_TOKEN", async () => {
    const env: Env = { PUBLIC_URL: "https://example.test", DATABASE_URL: url, MCP_TOKEN: `tok-${run}` };
    const headers = { Authorization: `Bearer tok-${run}`, "Content-Type": "application/json" };
    const call = (path: string, init: RequestInit = {}) =>
      worker.fetch(new Request(`https://example.test${path}`, { ...init, headers }), env, {} as ExecutionContext);
    const summary = (await (await call("/api/summary")).json()) as Record<string, unknown>;
    expect(Object.keys(summary)).toEqual(expect.arrayContaining(["pipeline", "pending_approvals", "active_workflows", "recent_replies", "spend", "paused"]));
    const put = await call("/api/profile", { method: "PUT", body: JSON.stringify({ company: "Acme", website: `acme-${run}.example.com`, sells: "Routing", icp_description: "3PLs", segments: [], signals: [], sources: [] }) });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { profile: { website: string } }).profile.website).toBe(website);
    expect(((await (await call("/api/profile")).json()) as { profile: { company: string } }).profile.company).toBe("Acme");
    const created = await call("/api/experiments", { method: "POST", body: JSON.stringify({ name: `it-${run}-http` }) });
    expect(created.status).toBe(201);
    const exp = ((await created.json()) as { experiment: { id: string } }).experiment;
    experimentIds.push(exp.id);
    const patched = await call(`/api/experiments/${exp.id}`, { method: "PATCH", body: JSON.stringify({ status: "stopped" }) });
    expect(((await patched.json()) as { experiment: { status: string } }).experiment.status).toBe("stopped");
    expect((await call("/api/experiments/exp_missing")).status).toBe(404);
  });
});
