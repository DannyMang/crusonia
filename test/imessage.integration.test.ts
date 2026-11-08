// iMessage approvals end to end against a real Postgres (a Neon dev branch, never production), through the real
// Worker routes with signed bridge requests: the poll (notices, acks with bubble ids, reminders), and owner commands
// applying approve / reject / edit / answer / tapbacks through the real approval services, decided_via = 'imessage'.
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
async function bridgeCall(path: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const res = await worker.fetch(
    new Request(`https://example.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-crusonia-timestamp": String(ts), "x-crusonia-signature": await signBridge(secret, ts, path, body) },
      body,
    }),
    env,
    {} as ExecutionContext,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}
let seq = 0;
const say = (command: Record<string, unknown>, id = `it-${run}-${++seq}`) => bridgeCall("/webhooks/photon", { id, from: OWNER, command });

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

async function newLead(name: string) {
  return createLead(sql, WS, { email: email(name), name: `${name} Tester`, company: "Fieldnote", source: "it_test", consent: { text: "integration test opt-in" } }, "test");
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
    expect(notice.text).toContain("Draft to notice Tester (Fieldnote)");
    expect(notice.text).toContain(`Hi notice, worth a chat?`);
    expect(notice.text).toContain(`reply A ${code}`);
    const [row] = await sql`select delivered_at, message_id, draft_id, attempts from imessage_outbox where id = ${`approval:${code}`}`;
    expect(row).toMatchObject({ message_id: notice.bubble, draft_id: draftId, attempts: 1 });
    expect(row!.delivered_at).not.toBeNull();
    expect((await pollFor([])).has(`approval:${code}`)).toBe(false);
    const [bridge] = await sql`select value from settings where key = 'imessage_bridge'`;
    expect(bridge!.value).toMatchObject({ state: "connected", connected: true });
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

  test("A <code>: sends through AgentMail, decided_via imessage", async () => {
    const { code, lead } = await newSendApproval("approve");
    const sent = calls.length;
    const res = await say({ action: "approve", code: code.toLowerCase() });
    expect(res).toMatchObject({ ok: true, reply: `Approved. Sent "Quick question" to approve Tester (Fieldnote).` });
    expect(calls.slice(sent).map((c) => c.body?.to)).toEqual([lead.email]);
    expect(await approvalRow(code)).toMatchObject({ status: "approved", decided_via: "imessage" });
    // Single use: a second A is refused with the current state, and nothing is sent.
    expect((await say({ action: "approve", code })).reply).toBe(`${code} is already closed: approved.`);
    expect(calls.length).toBe(sent + 1);
  });

  test("a retried delivery of the same iMessage returns the first reply without acting again", async () => {
    const { code } = await newSendApproval("dupe");
    const id = `it-${run}-dupe`;
    const first = await say({ action: "approve", code }, id);
    const sent = calls.length;
    expect(await say({ action: "approve", code }, id)).toEqual({ ...first, duplicate: true });
    expect(calls.length).toBe(sent);
  });

  test("R <code> rejects the draft; unknown and expired codes get clear replies", async () => {
    const { code } = await newSendApproval("reject");
    expect((await say({ action: "reject", code, reason: "too pushy" })).reply).toBe("Rejected. The draft to reject Tester (Fieldnote) won't be sent.");
    expect(await approvalRow(code)).toMatchObject({ status: "rejected", decided_via: "imessage", answer: "too pushy" });

    expect((await say({ action: "approve", code: "ZZZZ" })).reply).toBe("No approval ZZZZ. Text status to see what's open.");
    const old = await newSendApproval("expired");
    await sql`update approvals set expires_at = now() - interval '1 minute' where code = ${old.code}`;
    expect((await say({ action: "approve", code: old.code })).reply).toBe(`Code ${old.code} expired.`);
  });

  test("E <code> <text>: a new immutable version + approval; the old code closes; the new one gets its own notice", async () => {
    const { code } = await newSendApproval("edit");
    const res = await say({ action: "edit", code, text: "Hi edit, shorter: 15 minutes this week?" });
    expect(res.ok).toBe(true);
    const newCode = /reply A ([2-9A-Z]{4})/.exec(res.reply)![1]!;
    expect(res.reply).toContain(`Saved as v2 for edit Tester (Fieldnote) (${code} is closed)`);
    expect(await approvalRow(code)).toMatchObject({ status: "expired" });
    const [d] = await sql`select d.version, d.body from approvals a join drafts d on d.id = a.draft_id where a.code = ${newCode}`;
    expect(d).toEqual({ version: 2, body: "Hi edit, shorter: 15 minutes this week?" });
    const notice = (await pollFor([`approval:${newCode}`])).get(`approval:${newCode}`)!;
    expect(notice.text).toContain(", v2:");
    expect(notice.text).toContain("15 minutes this week?");
  });

  test("👍 on a draft's bubble sends exactly that version; 👍 on the bubble of a superseded version cannot", async () => {
    const v1 = await newSendApproval("tap");
    const n1 = (await pollFor([`approval:${v1.code}`])).get(`approval:${v1.code}`)!;
    // The owner edits instead, then taps the OLD bubble: that approval is closed, so nothing is sent.
    const edited = await say({ action: "edit", code: v1.code, text: "v2 body" });
    const v2code = /reply A ([2-9A-Z]{4})/.exec(edited.reply)![1]!;
    const sent = calls.length;
    expect((await say({ action: "react", reaction: "like", message_id: n1.bubble })).reply).toBe(`${v1.code} is already closed: expired.`);
    expect(calls.length).toBe(sent);
    // Tapping the v2 bubble sends v2.
    const n2 = (await pollFor([`approval:${v2code}`])).get(`approval:${v2code}`)!;
    expect((await say({ action: "react", reaction: "like", message_id: n2.bubble })).reply).toContain("Approved. Sent");
    expect(calls.at(-1)!.body).toMatchObject({ text: "v2 body" });
    expect(await approvalRow(v2code)).toMatchObject({ status: "approved", decided_via: "imessage" });
  });

  test("👎 on a bubble rejects; a tapback on a message that is not a notice is ignored silently", async () => {
    const { code } = await newSendApproval("tapno");
    const n = (await pollFor([`approval:${code}`])).get(`approval:${code}`)!;
    expect((await say({ action: "react", reaction: "dislike", message_id: n.bubble })).reply).toContain("Rejected.");
    expect(await approvalRow(code)).toMatchObject({ status: "rejected", decided_via: "imessage" });
    expect(await say({ action: "react", reaction: "like", message_id: `not-a-notice-${run}` })).toEqual({ ok: false, error: "unknown_message", reply: "" });
  });

  test("tool approval: 👍 on its bubble allows the call at Naive; R <code> on another denies it", async () => {
    const allow = await newAgentApproval("toolok", "tool");
    const n = (await pollFor([`approval:${allow.code}`])).get(`approval:${allow.code}`)!;
    expect(n.text).toContain("Agent wants to run apify.run_actor");
    expect((await say({ action: "react", reaction: "like", message_id: n.bubble })).reply).toBe("Allowed. The agent can run apify.run_actor and continues.");
    expect(calls.at(-1)).toMatchObject({ url: expect.stringContaining(`/v1/sessions/${allow.sessionId}/tool_confirmations`), body: { tool_call_id: "tc_toolok", decision: "allow" } });
    expect(await approvalRow(allow.code)).toMatchObject({ status: "approved", decided_via: "imessage" });

    const deny = await newAgentApproval("toolno", "tool");
    expect((await say({ action: "reject", code: deny.code })).reply).toBe("Denied. The agent won't run apify.run_actor.");
    expect(calls.at(-1)!.body).toMatchObject({ tool_call_id: "tc_toolno", decision: "deny" });
  });

  test("question: <code> <answer> is forwarded to Naive; approve/reject on a question explains how to answer", async () => {
    const q = await newAgentApproval("question", "question");
    expect((await say({ action: "approve", code: q.code })).reply).toBe(`${q.code} is a question, not an approval. Reply ${q.code} <your answer>.`);
    expect((await say({ action: "answer", code: q.code, text: "Seed-stage devtools" })).reply).toBe("Answered. The agent continues.");
    expect(calls.at(-1)).toMatchObject({ url: expect.stringContaining(`/v1/sessions/${q.sessionId}/answers`), body: { tool_call_id: "tc_question", answers: { segment: "Seed-stage devtools" } } });
    expect(await approvalRow(q.code)).toMatchObject({ status: "answered", decided_via: "imessage" });
  });

  test("pause, status and resume", async () => {
    expect((await say({ action: "pause" })).reply).toStartWith("Paused.");
    const status = await say({ action: "status" });
    expect(status.reply).toStartWith("Crusonia is PAUSED");
    // While paused, approving a send is refused with a hint and nothing is sent.
    const { code } = await newSendApproval("paused");
    const sent = calls.length;
    expect((await say({ action: "approve", code })).reply).toBe(`Sending is paused. Text resume first, then A ${code}.`);
    expect(calls.length).toBe(sent);
    expect((await say({ action: "resume" })).reply).toStartWith("Resumed.");
    expect((await sql`select paused from workspaces where id = ${WS}`)[0]!.paused).toBe(false);
    const [ev] = await sql`select data from events where kind = 'imessage_command' and data->>'message_id' = ${`it-${run}-${seq}`}`;
    expect(ev!.data).toMatchObject({ action: "resume", ok: true });
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
    expect(seen.get(`warn:${code}`)!.text).toStartWith(`Reminder: ${code} expires in`);
    expect((await pollFor([])).has(`warn:${code}`)).toBe(false);
  });

  test("another workspace's approvals are never texted, and a text cannot decide them", async () => {
    const other = await createTestWorkspace(sql, `imsg_${run}`);
    try {
      const lead = await createLead(sql, other, { email: email("elsewhere"), name: "Else", source: "it_test", consent: { text: "opted in" } }, "test");
      const { approval } = await createDraft(sql, other, { lead_id: lead.id, subject: "Not yours", body: "Body" }, { ttlMinutes: 60, via: "api", actor: "test" });
      const seen = await pollFor([]);
      expect(seen.has(`approval:${approval.code}`)).toBe(false);
      expect((await sql`select count(*)::int as n from imessage_outbox where approval_code = ${approval.code}`)[0]!.n).toBe(0);
      const reply = await say({ action: "approve", code: approval.code });
      expect(reply.ok).toBe(false);
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
