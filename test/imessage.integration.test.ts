// iMessage approvals end to end against a real Postgres (a Neon dev branch, never production), through the real
// Worker routes with signed bridge requests: the poll (notices, acks with bubble ids, reminders), and owner commands
// (👍 / 👎 tapbacks, the only input) applying through the real approval services, decided_via = 'imessage'.
// AgentMail and Naive are mocked at fetch (the Neon driver's own requests pass through). Skipped unless
// TEST_DATABASE_URL is set:  TEST_DATABASE_URL=<dev branch url> bun test test/imessage.integration.test.ts
// The dev branch is shared: polls lease every recent pending approval, so assertions only look at this run's codes.
// iMessage texts the owner's phone, so it works on the owner workspace only (another workspace's approvals are
// neither announced nor decided by text: tested at the end).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getSql, type Sql } from "../src/db.ts";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";
import { signBridge } from "../src/lib/signatures.ts";
import { createAgentApproval } from "../src/services/approvals.ts";
import { createLead } from "../src/services/crm.ts";
import { createDraft } from "../src/services/drafts.ts";
import { setPaused } from "../src/services/settings.ts";
import { createTestWorkspace, deleteTestWorkspaces } from "./helpers/workspace.ts";

const WS = "ws_owner";
let originalPaused = false;

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const run = crypto.randomUUID().slice(0, 8);
const secret = "i".repeat(64);
const OWNER = "+15550009999";
const env: Env = {
  PUBLIC_URL: "https://example.test",
  DATABASE_URL: url,
  IMESSAGE_ENABLED: "true",
  BRIDGE_SECRET: secret,
  OWNER_PHONE: OWNER,
  // This suite's fixtures are test data, which the outbox skips by default; and it texts far more than the cap.
  IMESSAGE_INCLUDE_TEST_DATA: "true",
  IMESSAGE_NOTICE_CAP: "1000",
  AGENTMAIL_API_KEY: "am_test",
  AGENTMAIL_INBOX_ID: "it@agentmail.to",
  NAIVE_API_KEY: "nv_test",
};
const email = (name: string) => `${name}-${run}@it.example.com`;
let sql: Sql;

// ---- provider mocks at fetch: AgentMail sends and Naive decisions are recorded, everything else passes through ----
type Call = { url: string; body: any };
const calls: Call[] = [];
const realFetch = globalThis.fetch;
function installFetchMock() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (u.startsWith("https://api.agentmail.to/") || u.startsWith("https://api.vetta.sh/")) {
      calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (u.endsWith("/messages/send")) return Response.json({ message_id: `<im-${run}-${calls.length}@agentmail.to>`, thread_id: `thr_${run}_${calls.length}` });
      return Response.json({}, { status: 202 });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

// ---- signed bridge calls through the real Worker ----
async function bridgeCall(path: string, payload: unknown, over: Partial<Env> = {}) {
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const res = await worker.fetch(
    new Request(`https://example.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-crusonia-timestamp": String(ts), "x-crusonia-signature": await signBridge(secret, ts, path, body) },
      body,
    }),
    { ...env, ...over },
    {} as ExecutionContext,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}
let seq = 0;
const say = (command: Record<string, unknown>, id = `it-${run}-${++seq}`) => bridgeCall("/webhooks/photon", { id, from: OWNER, command });
const thumb = (reaction: "like" | "dislike", bubble: string) => say({ action: "react", reaction, message_id: bubble });

type Notice = { id: string; type: string; text: string };
/**
 * Polls like the bridge until `want` notice ids showed up (or the queue is drained), acking every notice as delivered
 * with a fake bubble id. Returns this run's notices with the bubble id each was acked with.
 */
async function pollFor(want: string[]): Promise<Map<string, Notice & { bubble: string }>> {
  const seen = new Map<string, Notice & { bubble: string }>();
  let acks: { id: string; ok: boolean; message_id?: string }[] = [];
  for (let i = 0; i < 30; i++) {
    const res = await bridgeCall("/webhooks/photon/poll", { bridge: { state: "connected", connected: true, mode: "mock", version: "it" }, acks, max: 10 });
    acks = (res.notices as Notice[]).map((n) => ({ id: n.id, ok: true, message_id: `bubble-${run}-${n.id}` }));
    for (const n of res.notices as Notice[]) seen.set(n.id, { ...n, bubble: `bubble-${run}-${n.id}` });
    if (want.every((w) => seen.has(w)) && acks.length === 0) break;
    if (res.notices.length === 0 && want.every((w) => seen.has(w))) break;
  }
  if (acks.length) await bridgeCall("/webhooks/photon/poll", { bridge: { state: "connected", connected: true }, acks, max: 0 });
  return seen;
}

async function newLead(name: string, opts: { source?: string } = {}) {
  return createLead(
    sql,
    WS,
    { email: email(name), name: `${name} Tester`, company: "Fieldnote", source: opts.source ?? "it_test", consent: { text: "integration test opt-in" } },
    "test",
  );
}
async function newSendApproval(name: string, subject = "Quick question") {
  const lead = await newLead(name);
  const { approval, draft } = await createDraft(sql, WS, { lead_id: lead.id, subject, body: `Hi ${name}, worth a chat?` }, { ttlMinutes: 60 * 24, via: "api", actor: "test" });
  return { lead, code: approval.code as string, draftId: draft.id as string };
}
async function newAgentApproval(name: string, kind: "tool" | "question") {
  const lead = await newLead(name);
  const sessionId = `ses_it_${run}_${name}`;
  await sql`insert into naive_sessions (id, workspace_id, lead_id, purpose, status) values (${sessionId}, ${WS}, ${lead.id}, 'research', 'idle')`;
  const code = await createAgentApproval(sql, {
    workspaceId: WS,
    sessionId,
    leadId: lead.id,
    ttlMinutes: 60,
    action:
      kind === "tool"
        ? { kind: "tool", tool_call_id: `tc_${name}`, name: "apify.run_actor", args: { actor: "apify/web-search" } }
        : { kind: "question", tool_call_id: `tc_${name}`, name: "ask_operator", question: { prompt: "Which segment first?", fields: [{ key: "segment" }] } },
  });
  return { lead, code: code!, sessionId };
}
const approvalRow = async (code: string) => (await sql`select status, decided_via, answer from approvals where code = ${code}`)[0]!;

suite("iMessage approvals (dev database, mocked providers)", () => {
  beforeAll(async () => {
    sql = getSql(url);
    originalPaused = (await sql`select paused from workspaces where id = ${WS}`)[0]?.paused === true;
    installFetchMock();
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (!sql) return;
    const ids = (await sql`select id from leads where email like ${`%-${run}@it.example.com`}`).map((r) => r.id as string);
    await sql.transaction([
      sql`delete from events where lead_id = any(${ids}::text[]) or (lead_id is null and data::text like ${`%${run}%`})`,
      sql`delete from leads where id = any(${ids}::text[])`, // cascades drafts, approvals, imessage_outbox
      sql`delete from approvals where naive_session_id like ${`ses_it_${run}%`}`, // lead-less agent approvals
      sql`delete from naive_sessions where id like ${`ses_it_${run}%`}`,
      sql`delete from webhook_events where event_id like ${`photon:it-${run}%`}`,
      sql`update workspaces set paused = ${originalPaused} where id = ${WS}`,
    ]);
  });

  test("a new approval becomes one notice with its text; the ack stores the bubble id; it is never handed out again", async () => {
    const { code, draftId } = await newSendApproval("notice");
    const seen = await pollFor([`approval:${code}`]);
    const notice = seen.get(`approval:${code}`)!;
    expect(notice.type).toBe("approval");
    expect(notice.text).toStartWith(`Request ${code} · draft v1 to notice Tester (Fieldnote)`);
    expect(notice.text).toContain(`Hi notice, worth a chat?`);
    expect(notice.text).toEndWith("Tap 👍 to send, 👎 to reject.");
    expect(notice.text).not.toMatch(/reply|Expires/);
    const [row] = await sql`select delivered_at, message_id, draft_id, attempts from imessage_outbox where id = ${`approval:${code}`}`;
    expect(row).toMatchObject({ message_id: notice.bubble, draft_id: draftId, attempts: 1 });
    expect(row!.delivered_at).not.toBeNull();
    expect((await pollFor([])).has(`approval:${code}`)).toBe(false);
    const [bridge] = await sql`select value from settings where key = 'imessage_bridge'`;
    expect(bridge!.value).toMatchObject({ state: "connected", connected: true });
  });

  test("GET /api/approvals shows texted_at once the notice was delivered, null before", async () => {
    const list = async (code: string) => {
      const res = await worker.fetch(
        new Request("https://example.test/api/approvals?limit=200", { headers: { Authorization: "Bearer it" } }),
        { ...env, MCP_TOKEN: "it" },
        {} as ExecutionContext,
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: { code: string; texted_at: string | null }[] }).data.find((a) => a.code === code)!;
    };
    const { code } = await newSendApproval("texted");
    expect((await list(code)).texted_at).toBeNull();
    await pollFor([`approval:${code}`]);
    const row = await list(code);
    const [db] = await sql`select delivered_at from imessage_outbox where id = ${`approval:${code}`}`;
    expect(new Date(row.texted_at!).getTime()).toBe(new Date(db!.delivered_at).getTime());
  });

  test("a failed delivery is released and retried; an unacked lease is not handed to a second poll", async () => {
    await pollFor([]); // drain whatever is queued on the shared branch (acked), then create ours
    const { code } = await newSendApproval("retry");
    const id = `approval:${code}`;
    let res: any;
    for (let i = 0; i < 10 && !(res?.notices ?? []).some((n: Notice) => n.id === id); i++) {
      res = await bridgeCall("/webhooks/photon/poll", { bridge: { state: "connected", connected: true }, acks: [], max: 10 });
    }
    expect(res.notices.some((n: Notice) => n.id === id)).toBe(true);
    // Leased and not acked: a concurrent poll does not get it.
    const again = await bridgeCall("/webhooks/photon/poll", { bridge: { state: "connected", connected: true }, acks: [], max: 10 });
    expect(again.notices.some((n: Notice) => n.id === id)).toBe(false);
    // Acked as failed: released, the next poll hands it out again (attempt 2).
    await bridgeCall("/webhooks/photon/poll", { bridge: { state: "connected", connected: true }, acks: [{ id, ok: false, error: "Target not allowed" }], max: 0 });
    expect((await sql`select last_error, leased_at from imessage_outbox where id = ${id}`)[0]).toEqual({ last_error: "Target not allowed", leased_at: null });
    expect((await pollFor([id])).has(id)).toBe(true);
    expect((await sql`select attempts from imessage_outbox where id = ${id}`)[0]!.attempts).toBe(2);
  });

  test("👍 on a notice sends through AgentMail, decided_via imessage, once", async () => {
    const { code, lead } = await newSendApproval("approve");
    const n = (await pollFor([`approval:${code}`])).get(`approval:${code}`)!;
    const sent = calls.length;
    expect(await thumb("like", n.bubble)).toMatchObject({ ok: true, reply: `Approved. Sent "Quick question" to approve Tester (Fieldnote).`, code });
    expect(calls.slice(sent).map((c) => c.body?.to)).toEqual([lead.email]);
    expect(await approvalRow(code)).toMatchObject({ status: "approved", decided_via: "imessage" });
    // Single use: a second 👍 (a new tapback event) is refused with the current state, and nothing is sent.
    expect((await thumb("like", n.bubble)).reply).toBe(`Request ${code} is already closed: approved.`);
    expect(calls.length).toBe(sent + 1);
  });

  test("a retried delivery of the same tapback returns the first reply without acting again", async () => {
    const { code } = await newSendApproval("dupe");
    const n = (await pollFor([`approval:${code}`])).get(`approval:${code}`)!;
    const id = `it-${run}-dupe`;
    const first = await say({ action: "react", reaction: "like", message_id: n.bubble }, id);
    const sent = calls.length;
    expect(await say({ action: "react", reaction: "like", message_id: n.bubble }, id)).toEqual({ ok: true, duplicate: true, reply: first.reply });
    expect(calls.length).toBe(sent);
  });

  test("👎 on a notice rejects it; 👍 on an expired request gets a clear reply and sends nothing", async () => {
    const { code } = await newSendApproval("reject");
    const n = (await pollFor([`approval:${code}`])).get(`approval:${code}`)!;
    expect((await thumb("dislike", n.bubble)).reply).toBe("Rejected. The draft to reject Tester (Fieldnote) won't be sent.");
    expect(await approvalRow(code)).toMatchObject({ status: "rejected", decided_via: "imessage", answer: "Rejected with a 👎 tapback" });

    const old = await newSendApproval("expired");
    const oldNotice = (await pollFor([`approval:${old.code}`])).get(`approval:${old.code}`)!;
    await sql`update approvals set expires_at = now() - interval '1 minute' where code = ${old.code}`;
    const sent = calls.length;
    expect((await thumb("like", oldNotice.bubble)).reply).toBe(`Request ${old.code} expired.`);
    expect(calls.length).toBe(sent);
  });

  test("editing a texted draft closes its request: the new notice says it changed, and 👍 approves only the version on that bubble", async () => {
    const v1 = await newSendApproval("tap");
    const n1 = (await pollFor([`approval:${v1.code}`])).get(`approval:${v1.code}`)!;
    // The edit happens in the app.
    const res = await worker.fetch(
      new Request(`https://example.test/api/approvals/${v1.code}/edit`, {
        method: "POST",
        headers: { Authorization: "Bearer it", "Content-Type": "application/json" },
        body: JSON.stringify({ body: "v2 body" }),
      }),
      { ...env, MCP_TOKEN: "it" },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(201);
    const v2code = ((await res.json()) as { approval: { code: string } }).approval.code;
    expect(await approvalRow(v1.code)).toMatchObject({ status: "expired" });

    const n2 = (await pollFor([`approval:${v2code}`])).get(`approval:${v2code}`)!;
    const [changed, request] = n2.text.split("\n");
    expect(changed).toBe("That draft changed; here's the new one (v1 is closed).");
    expect(request).toStartWith(`Request ${v2code} · draft v2 to tap Tester`);
    expect(n2.text).toContain("v2 body");

    // A 👍 on the old bubble cannot send anything.
    const sent = calls.length;
    expect((await thumb("like", n1.bubble)).reply).toBe(`Request ${v1.code} is already closed: expired.`);
    expect(calls.length).toBe(sent);
    // A 👍 on the new bubble sends exactly the new version.
    expect((await thumb("like", n2.bubble)).reply).toContain("Approved. Sent");
    expect(calls.at(-1)!.body).toMatchObject({ text: "v2 body" });
    expect(await approvalRow(v2code)).toMatchObject({ status: "approved", decided_via: "imessage" });
  });

  test("switched off: no new notices, but acks are recorded and a thumb on a delivered notice still applies", async () => {
    const off = { IMESSAGE_ENABLED: "false" };
    const { code } = await newSendApproval("off");
    const id = `approval:${code}`;
    // Off: the approval is not queued or handed out.
    const quiet = await bridgeCall("/webhooks/photon/poll", { bridge: { state: "connected", connected: true }, acks: [], max: 10 }, off);
    expect(quiet).toEqual({ ok: true, enabled: false, notices: [], poll_after_ms: 60_000 });
    expect((await sql`select count(*)::int as n from imessage_outbox where id = ${id}`)[0]!.n).toBe(0);

    // It was leased while on, and the ack arrives after the switch went off: the bubble id is still recorded.
    let leased = false;
    for (let i = 0; i < 10 && !leased; i++) {
      const res = await bridgeCall("/webhooks/photon/poll", { bridge: { state: "connected", connected: true }, acks: [], max: 10 });
      leased = (res.notices as Notice[]).some((n) => n.id === id);
    }
    expect(leased).toBe(true);
    const bubble = `bubble-${run}-off`;
    await bridgeCall("/webhooks/photon/poll", { bridge: { state: "connected", connected: true }, acks: [{ id, ok: true, message_id: bubble }], max: 10 }, off);
    expect((await sql`select message_id from imessage_outbox where id = ${id}`)[0]!.message_id).toBe(bubble);

    // The owner taps it while off: applied.
    const body = JSON.stringify({ id: `it-${run}-off-tap`, from: OWNER, command: { action: "react", reaction: "like", message_id: bubble } });
    const ts = Math.floor(Date.now() / 1000);
    const res = await worker.fetch(
      new Request("https://example.test/webhooks/photon", {
        method: "POST",
        headers: { "content-type": "application/json", "x-crusonia-timestamp": String(ts), "x-crusonia-signature": await signBridge(secret, ts, "/webhooks/photon", body) },
        body,
      }),
      { ...env, ...off },
      {} as ExecutionContext,
    );
    expect(((await res.json()) as { reply: string }).reply).toContain("Approved. Sent");
    expect(await approvalRow(code)).toMatchObject({ status: "approved", decided_via: "imessage" });
  });

  test("a thumb on a message that is not a notice does nothing and asks for no reply", async () => {
    expect(await thumb("like", `not-a-notice-${run}`)).toEqual({ ok: false, error: "unknown_message", reply: "" });
    expect(await thumb("dislike", `not-a-notice-${run}`)).toEqual({ ok: false, error: "unknown_message", reply: "" });
  });

  test("tool approval: 👍 on its bubble allows the call at Naive; 👎 on another denies it", async () => {
    const allow = await newAgentApproval("toolok", "tool");
    const n = (await pollFor([`approval:${allow.code}`])).get(`approval:${allow.code}`)!;
    expect(n.text).toStartWith(`Request ${allow.code} · agent wants to run apify.run_actor`);
    expect((await thumb("like", n.bubble)).reply).toBe("Allowed. The agent can run apify.run_actor and continues.");
    expect(calls.at(-1)).toMatchObject({ url: expect.stringContaining(`/v1/sessions/${allow.sessionId}/tool_confirmations`), body: { tool_call_id: "tc_toolok", decision: "allow" } });
    expect(await approvalRow(allow.code)).toMatchObject({ status: "approved", decided_via: "imessage" });

    const deny = await newAgentApproval("toolno", "tool");
    const m = (await pollFor([`approval:${deny.code}`])).get(`approval:${deny.code}`)!;
    expect((await thumb("dislike", m.bubble)).reply).toBe("Denied. The agent won't run apify.run_actor.");
    expect(calls.at(-1)!.body).toMatchObject({ tool_call_id: "tc_toolno", decision: "deny" });
  });

  test("question: thumbs can't answer it; it points to the app and stays open", async () => {
    const q = await newAgentApproval("question", "question");
    const n = (await pollFor([`approval:${q.code}`])).get(`approval:${q.code}`)!;
    expect(n.text).toEndWith("Answer it in the app.");
    const sent = calls.length;
    for (const reaction of ["like", "dislike"] as const) {
      expect((await thumb(reaction, n.bubble)).reply).toBe(`Request ${q.code} is a question: answer it in the app.`);
    }
    expect(calls.length).toBe(sent);
    expect(await approvalRow(q.code)).toMatchObject({ status: "pending" });
  });

  test("while paused, 👍 is refused with a hint and nothing is sent", async () => {
    const { code } = await newSendApproval("paused");
    const n = (await pollFor([`approval:${code}`])).get(`approval:${code}`)!;
    await setPaused(sql, WS, true, "test");
    try {
      const sent = calls.length;
      expect((await thumb("like", n.bubble)).reply).toBe("Sending is paused. Resume in the app, then tap 👍 again.");
      expect(calls.length).toBe(sent);
      const [ev] = await sql`select data from events where kind = 'imessage_command' and data->>'target_message_id' = ${n.bubble}`;
      expect(ev!.data).toMatchObject({ action: "react", reaction: "like", code, ok: false, error: "paused" });
    } finally {
      await setPaused(sql, WS, false, "test");
    }
  });

  test("an expiry reminder is queued once, 10+ minutes after the notice, in the last quarter of the approval's life", async () => {
    const { code } = await newSendApproval("remind");
    await pollFor([`approval:${code}`]);
    // Age it: created 23h ago, expires in 1h (last quarter), notice delivered 20 minutes ago.
    await sql.transaction([
      sql`update approvals set created_at = now() - interval '23 hours', expires_at = now() + interval '1 hour' where code = ${code}`,
      sql`update imessage_outbox set delivered_at = now() - interval '20 minutes' where id = ${`approval:${code}`}`,
    ]);
    const seen = await pollFor([`warn:${code}`]);
    expect(seen.get(`warn:${code}`)!.text).toStartWith(`Reminder: request ${code} expires in`);
    expect((await pollFor([])).has(`warn:${code}`)).toBe(false);
  });

  test("test fixtures are never queued unless IMESSAGE_INCLUDE_TEST_DATA=true", async () => {
    const strict = { IMESSAGE_INCLUDE_TEST_DATA: undefined };
    const poll = (over: Partial<Env>) => bridgeCall("/webhooks/photon/poll", { bridge: { state: "connected", connected: true }, acks: [], max: 0 }, over);
    // An it_* source; a reserved example domain (with a non-test source); an ses_it_* session without a lead.
    const bySource = await newSendApproval("fixture-source");
    const byDomain = await newLead("fixture-domain", { source: "manual_qa" });
    const domainCode = (await createDraft(sql, WS, { lead_id: byDomain.id, subject: "Hi", body: "Body" }, { ttlMinutes: 60, via: "api", actor: "test" })).approval.code as string;
    await sql`insert into naive_sessions (id, workspace_id, lead_id, purpose, status) values (${`ses_it_${run}_nolead`}, ${WS}, null, 'research', 'idle')`;
    const sessionCode = (await createAgentApproval(sql, {
      workspaceId: WS,
      sessionId: `ses_it_${run}_nolead`,
      leadId: null,
      ttlMinutes: 60,
      action: { kind: "tool", tool_call_id: "tc_nolead", name: "web_fetch", args: {} },
    }))!;
    const codes = [bySource.code, domainCode, sessionCode];
    const queued = async () => (await sql`select approval_code from imessage_outbox where approval_code = any(${codes}::text[])`).map((r) => r.approval_code);
    await poll(strict);
    expect(await queued()).toEqual([]);
    await poll({});
    expect((await queued()).sort()).toEqual([...codes].sort());
  });

  test("send cap: beyond the cap, due notices collapse into one '+N more' summary, once per window", async () => {
    await pollFor([]); // nothing of ours outstanding
    const [{ n: used }] = (await sql`
      select count(*)::int as n from imessage_outbox
      where workspace_id = ${WS} and (delivered_at > now() - interval '10 minutes'
         or (delivered_at is null and skipped_at is null and leased_at > now() - interval '120 seconds'))`) as { n: number }[];
    const capped = { IMESSAGE_NOTICE_CAP: String(used + 2) };
    await sql`delete from settings where key = 'imessage_summary'`;
    const made = [];
    for (const name of ["cap1", "cap2", "cap3", "cap4", "cap5"]) made.push((await newSendApproval(name)).code);
    const ids = made.map((c) => `approval:${c}`);
    const res = await bridgeCall("/webhooks/photon/poll", { bridge: { state: "connected", connected: true }, acks: [], max: 10 }, capped);
    const ours = (res.notices as Notice[]).filter((n) => ids.includes(n.id));
    expect(ours.length).toBeLessThanOrEqual(2);
    const summary = (res.notices as Notice[]).find((n) => n.type === "summary");
    expect(summary?.text).toMatch(/^\+\d+ more approvals? waiting: open Crusonia \(https:\/\/example\.test\/app\/approvals\)\.$/);
    expect(res.notices.at(-1).type).toBe("summary");
    const skipped = await sql`select id from imessage_outbox where id = any(${ids}::text[]) and skip_reason = 'rate_limited'`;
    expect(skipped.length).toBe(5 - ours.length);
    // Within the window: no second summary, and the collapsed notices are never texted one by one.
    await bridgeCall("/webhooks/photon/poll", { bridge: { state: "connected", connected: true }, acks: ours.map((n) => ({ id: n.id, ok: true })), max: 10 }, capped);
    const again = await bridgeCall("/webhooks/photon/poll", { bridge: { state: "connected", connected: true }, acks: [], max: 10 }, { IMESSAGE_NOTICE_CAP: "1000" });
    expect((again.notices as Notice[]).some((n) => n.type === "summary" || skipped.some((s) => s.id === n.id))).toBe(false);
  });

  test("another workspace's approvals are never texted, and a thumb cannot decide them", async () => {
    const other = await createTestWorkspace(sql, `imsg_${run}`);
    try {
      const lead = await createLead(sql, other, { email: email("elsewhere"), name: "Else", source: "it_test", consent: { text: "opted in" } }, "test");
      const { approval } = await createDraft(sql, other, { lead_id: lead.id, subject: "Not yours", body: "Body" }, { ttlMinutes: 60, via: "api", actor: "test" });
      const seen = await pollFor([]);
      expect(seen.has(`approval:${approval.code}`)).toBe(false);
      expect((await sql`select count(*)::int as n from imessage_outbox where approval_code = ${approval.code}`)[0]!.n).toBe(0);
      // Even a bubble recorded for that approval does not reach it from the owner's phone.
      const bubble = `bubble-${run}-elsewhere`;
      await sql`insert into imessage_outbox (id, workspace_id, approval_code, kind, draft_id, message_id, delivered_at)
                values (${`approval:${approval.code}`}, ${other}, ${approval.code}, 'approval', ${approval.draft_id}, ${bubble}, now())`;
      expect(await thumb("like", bubble)).toEqual({ ok: false, error: "unknown_message", reply: "" });
      expect((await approvalRow(approval.code)).status).toBe("pending");
      expect(calls.some((c) => String(c.url).endsWith("/messages/send") && c.body?.subject === "Not yours")).toBe(false);
    } finally {
      await deleteTestWorkspaces(sql, [other]);
    }
  });

  test("/api/status shows the bridge as online from its last poll", async () => {
    await pollFor([]);
    const res = await worker.fetch(new Request("https://example.test/api/status", { headers: { Authorization: "Bearer it" } }), { ...env, MCP_TOKEN: "it" }, {} as ExecutionContext);
    const body = (await res.json()) as any;
    expect(body.imessage).toMatchObject({ enabled: true, active: true, owner_phone_set: true, bridge: { online: true, connected: true } });
  });
});
