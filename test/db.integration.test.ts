// Integration tests against a real Postgres (a Neon dev branch, never production) with AgentMail and Naive
// mocked at fetch. Skipped unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=<dev branch url> bun test test/db.integration.test.ts
// Creates rows marked with source 'it_test' / @it.example.com and deletes them afterwards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getSql, type Sql } from "../src/db.ts";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";
import { ApiError } from "../src/lib/errors.ts";
import type { FetchFn } from "../src/providers/http.ts";
import { sendApprovalTtlMinutes } from "../src/services/approval-ttl.ts";
import { answerQuestion, expireStaleApprovals, getApproval, resolveTool, type Deps } from "../src/services/approvals.ts";
import { createLead } from "../src/services/crm.ts";
import { createDraft } from "../src/services/drafts.ts";
import { handleAgentMailEvent } from "../src/services/inbound.ts";
import { approveAndSend, reconcileSending } from "../src/services/send.ts";
import { handleSessionIdle, reconcileSessions, startResearch } from "../src/services/workflows.ts";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

type Call = { method: string; url: string; body: any };
type Route = (call: Call) => Response | undefined;

/** Fetch double: routes are tried in order; every call is recorded. */
function provider(routes: Route[] = []) {
  const calls: Call[] = [];
  const fn: FetchFn = async (u, init = {}) => {
    const call = { method: init.method ?? "GET", url: u, body: init.body ? JSON.parse(init.body as string) : undefined };
    calls.push(call);
    for (const r of routes) {
      const res = r(call);
      if (res) return res;
    }
    return new Response(JSON.stringify({ error: "unmocked" }), { status: 404 });
  };
  return { fn, calls, routes };
}
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const env: Env = {
  PUBLIC_URL: "https://example.test",
  AGENTMAIL_API_KEY: "am_test",
  AGENTMAIL_INBOX_ID: "it@agentmail.to",
  NAIVE_API_KEY: "nv_test",
  NAIVE_AGENT_ID: "agt_test",
};
const run = crypto.randomUUID().slice(0, 8);
const email = (name: string) => `${name}-${run}@it.example.com`;
let sql: Sql;

async function newLead(name: string) {
  return createLead(sql, { email: email(name), name, source: "it_test", consent: { text: "integration test opt-in" } }, "test");
}
async function newApproval(leadId: string, subject = "Hello") {
  const { approval, draft } = await createDraft(sql, { lead_id: leadId, subject, body: "Body" }, { ttlMinutes: sendApprovalTtlMinutes(env), via: "api", actor: "test" });
  return { code: approval.code, draftId: draft.id };
}
async function failure(p: Promise<unknown>) {
  const e = await p.then(() => undefined, (err) => err);
  expect(e).toBeInstanceOf(ApiError);
  return `${(e as ApiError).status} ${(e as ApiError).code}`;
}

suite("database integration (mocked providers)", () => {
  beforeAll(() => {
    sql = getSql(url);
  });

  afterAll(async () => {
    if (!sql) return;
    const ids = (await sql`select id from leads where source = 'it_test' or email like ${`%-${run}@it.example.com`}`).map((r) => r.id as string);
    await sql.transaction([
      sql`delete from events where lead_id = any(${ids}::text[])
            or (lead_id is null and (data::text like ${`%${run}%`} or data->>'session_id' like ${`ses_it_${run}%`}))`,
      sql`delete from leads where id = any(${ids}::text[])`,
      sql`delete from naive_sessions where id like ${`ses_it_${run}%`}`,
      sql`delete from suppressions where email like ${`%-${run}@it.example.com`}`,
      sql`delete from webhook_events where event_id like ${`%${run}%`}`,
      sql`delete from messages where thread_id like ${`thr_${run}%`}`,
      sql`update settings set value = 'false' where key = 'paused'`,
    ]);
  });

  test("approve sends once, records ids, message and stage; a second approve is refused", async () => {
    const lead = await newLead("send");
    const { code, draftId } = await newApproval(lead.id);
    const am = provider([(c) => (c.url.endsWith("/messages/send") ? ok({ message_id: `<m1-${run}@agentmail.to>`, thread_id: `thr_${run}_1` }) : undefined)]);
    const result = await approveAndSend({ sql, env, actor: "test", fetch: am.fn }, code);
    expect(result).toMatchObject({ status: "sent", draft_id: draftId, thread_id: `thr_${run}_1` });
    expect(am.calls).toHaveLength(1);
    expect(am.calls[0]!.body).toMatchObject({ to: email("send"), subject: "Hello", text: "Body" });
    expect(am.calls[0]!.body.labels).toContain(`draft-${draftId}`);

    const [d] = await sql`select status, provider_message_id, provider_thread_id from drafts where id = ${draftId}`;
    expect(d).toEqual({ status: "sent", provider_message_id: `<m1-${run}@agentmail.to>`, provider_thread_id: `thr_${run}_1` });
    const [m] = await sql`select direction, to_addr from messages where provider_message_id = ${`<m1-${run}@agentmail.to>`}`;
    expect(m).toEqual({ direction: "out", to_addr: email("send") });
    expect((await sql`select stage from leads where id = ${lead.id}`)[0]!.stage).toBe("sent");
    expect((await getApproval(sql, code)).status).toBe("approved");

    expect(await failure(approveAndSend({ sql, env, actor: "test", fetch: am.fn }, code))).toBe("409 approval_not_pending");
    expect(am.calls).toHaveLength(1);
  });

  test("two concurrent approvals of the same code send exactly once", async () => {
    const lead = await newLead("race");
    const { code } = await newApproval(lead.id);
    const am = provider([(c) => (c.url.endsWith("/messages/send") ? ok({ message_id: `<race-${run}@agentmail.to>`, thread_id: `thr_${run}_r` }) : undefined)]);
    const results = await Promise.allSettled([1, 2, 3].map(() => approveAndSend({ sql, env, actor: "test", fetch: am.fn }, code)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(am.calls).toHaveLength(1);
  });

  test("an ambiguous AgentMail failure leaves the draft 'sending'; the cron reconciles it by label", async () => {
    const lead = await newLead("ambiguous");
    const { code, draftId } = await newApproval(lead.id);
    const down = provider([() => new Response("bad gateway", { status: 502 })]);
    expect(await approveAndSend({ sql, env, actor: "test", fetch: down.fn }, code)).toMatchObject({ status: "sending", draft_id: draftId });
    expect((await sql`select status from drafts where id = ${draftId}`)[0]!.status).toBe("sending");

    await sql`update drafts set sending_at = now() - interval '3 minutes' where id = ${draftId}`;
    const am = provider([
      (c) =>
        c.method === "GET" && new URL(c.url).searchParams.getAll("labels").includes(`draft-${draftId}`)
          ? ok({ count: 1, messages: [{ message_id: `<amb-${run}@agentmail.to>`, thread_id: `thr_${run}_a`, labels: [], timestamp: "x" }] })
          : undefined,
      (c) => (c.method === "GET" ? ok({ count: 0, messages: [] }) : undefined),
    ]);
    const settled = await reconcileSending(sql, env, am.fn);
    expect(settled.sent).toBeGreaterThanOrEqual(1);
    expect((await sql`select status, provider_thread_id from drafts where id = ${draftId}`)[0]).toEqual({ status: "sent", provider_thread_id: `thr_${run}_a` });
    expect(am.calls.some((c) => c.method === "POST")).toBe(false); // reconciling never resends
  });

  test("a definite failure marks send_failed; editing the approval is the retry", async () => {
    const lead = await newLead("fail");
    const { code, draftId } = await newApproval(lead.id);
    const bad = provider([() => ok({ message: "Invalid recipient" }, 400)]);
    expect(await failure(approveAndSend({ sql, env, actor: "test", fetch: bad.fn }, code))).toBe("502 send_failed");
    expect((await sql`select status from drafts where id = ${draftId}`)[0]!.status).toBe("send_failed");
    const { editApproval } = await import("../src/services/approvals.ts");
    const deps: Deps = { sql, env, actor: "test", sendTtlMinutes: sendApprovalTtlMinutes(env) };
    const retry = await editApproval(deps, code, {});
    expect(retry.draft.version).toBe(2);
    expect(retry.approval.status).toBe("pending");
  });

  test("approvals are bound to the recipient, the latest version, consent and suppression", async () => {
    const lead = await newLead("bound");
    const first = await newApproval(lead.id, "v1");
    const second = await newApproval(lead.id, "v2");
    const am = provider([() => ok({ message_id: "<never>", thread_id: "never" })]);
    const deps = { sql, env, actor: "test", fetch: am.fn };
    expect(await failure(approveAndSend(deps, first.code))).toBe("409 approval_not_pending"); // closed by v2

    await sql`update leads set email = ${email("bound-changed")} where id = ${lead.id}`;
    expect(await failure(approveAndSend(deps, second.code))).toBe("409 recipient_mismatch");
    await sql`update leads set email = ${email("bound")} where id = ${lead.id}`;

    await sql`insert into suppressions (email, reason) values (${email("bound")}, 'test')`;
    expect(await failure(approveAndSend(deps, second.code))).toBe("403 suppressed");
    await sql`delete from suppressions where email = ${email("bound")}`;

    await sql`update leads set consent_at = null where id = ${lead.id}`;
    expect(await failure(approveAndSend(deps, second.code))).toBe("403 no_consent");
    await sql`update leads set consent_at = now() where id = ${lead.id}`;

    await sql`update approvals set expires_at = now() - interval '1 second' where code = ${second.code}`;
    expect(await failure(approveAndSend(deps, second.code))).toBe("410 approval_expired");
    expect((await getApproval(sql, second.code)).status).toBe("expired");
    expect(am.calls).toHaveLength(0);
  });

  test("a reply on our thread is matched, classified, and stops pending follow-ups", async () => {
    const lead = await newLead("reply");
    const { code } = await newApproval(lead.id, "first touch");
    const am = provider([() => ok({ message_id: `<r1-${run}@agentmail.to>`, thread_id: `thr_${run}_reply` })]);
    await approveAndSend({ sql, env, actor: "test", fetch: am.fn }, code);
    const pending = await newApproval(lead.id, "follow-up");

    const result = await handleAgentMailEvent(sql, {
      event_id: `it_evt_${run}_1`,
      event_type: "message.received",
      message: {
        thread_id: `thr_${run}_reply`,
        message_id: `<in1-${run}@mail.example.com>`,
        from: `Someone Else <other-${run}@it.example.com>`,
        to: ["it@agentmail.to"],
        subject: "Re: first touch",
        extracted_text: "Sounds great, let's chat Tuesday.",
      },
    });
    expect(result.detail).toMatchObject({ lead_id: lead.id, matched_by: "thread", label: "interested", stage: "interested" });
    expect((await getApproval(sql, pending.code)).status).toBe("expired");
    expect((await sql`select status from drafts where id = ${pending.draftId}`)[0]!.status).toBe("cancelled");
  });

  test("Naive idle: allowlisted tools are auto-allowed once, others and questions become approvals", async () => {
    const lead = await newLead("naive");
    const sessionId = `ses_it_${run}_1`;
    await sql`insert into naive_sessions (id, lead_id, purpose, status) values (${sessionId}, ${lead.id}, 'research', 'running')`;
    const nv = provider([(c) => (c.method === "POST" ? ok({}, 202) : undefined)]);
    const pendingActions = [
      { tool_call_id: "c1", name: "crusonia.get_lead", args: { lead_id: lead.id } },
      { tool_call_id: "c2", name: "gmail.send", args: { to: "someone@example.com" } },
      { kind: "question" as const, tool_call_id: "c3", name: "ask_operator", question: { prompt: "Which mailbox?", fields: [{ key: "mailbox" }] } },
    ];
    const first = await handleSessionIdle(sql, env, { sessionId, stopReason: "awaiting_approval", pendingActions }, nv.fn);
    expect(first.auto_allowed).toEqual(["crusonia.get_lead"]);
    expect(first.approvals).toHaveLength(2);
    expect(nv.calls).toHaveLength(1);
    expect(nv.calls[0]).toMatchObject({ url: `https://api.vetta.sh/v1/sessions/${sessionId}/tool_confirmations`, body: { tool_call_id: "c1", decision: "allow", scope: "call" } });

    const again = await handleSessionIdle(sql, env, { sessionId, stopReason: "awaiting_approval", pendingActions }, nv.fn);
    expect(again.approvals).toHaveLength(0);
    expect(nv.calls).toHaveLength(1);

    const deps: Deps = { sql, env, actor: "test", sendTtlMinutes: sendApprovalTtlMinutes(env), fetch: nv.fn };
    const [toolCode, questionCode] = first.approvals as [string, string];
    const tool = await getApproval(sql, toolCode);
    expect(tool).toMatchObject({ kind: "tool", tool_call_id: "c2", payload: { name: "gmail.send" } });
    await resolveTool(deps, tool, { decision: "deny", reason: "not allowed" });
    expect(nv.calls.at(-1)).toMatchObject({ body: { tool_call_id: "c2", decision: "deny", reason: "not allowed" } });
    expect((await getApproval(sql, toolCode)).status).toBe("rejected");

    const question = await getApproval(sql, questionCode);
    expect(await failure(answerQuestion(deps, question, { other: "x" }))).toBe("400 invalid_answers");
    await answerQuestion(deps, question, { mailbox: "hi@example.com" });
    expect(nv.calls.at(-1)).toMatchObject({ url: `https://api.vetta.sh/v1/sessions/${sessionId}/answers`, body: { tool_call_id: "c3", answers: { mailbox: "hi@example.com" } } });
    expect((await sql`select status from naive_sessions where id = ${sessionId}`)[0]!.status).toBe("running");
  });

  test("paused: nothing is auto-allowed", async () => {
    const lead = await newLead("paused");
    const sessionId = `ses_it_${run}_p`;
    await sql`insert into naive_sessions (id, lead_id, purpose, status) values (${sessionId}, ${lead.id}, 'research', 'running')`;
    await sql`update settings set value = 'true' where key = 'paused'`;
    const nv = provider([() => ok({}, 202)]);
    try {
      const res = await handleSessionIdle(sql, env, { sessionId, pendingActions: [{ tool_call_id: "p1", name: "crusonia.get_lead" }] }, nv.fn);
      expect(res).toMatchObject({ auto_allowed: [], approvals: [expect.any(String)] });
      expect(nv.calls).toHaveLength(0);
    } finally {
      await sql`update settings set value = 'false' where key = 'paused'`;
    }
  });

  test("cron: reconciles a session from its events and denies expired tool approvals", async () => {
    const lead = await newLead("cron");
    const sessionId = `ses_it_${run}_c`;
    await sql`insert into naive_sessions (id, lead_id, purpose, status, updated_at) values (${sessionId}, ${lead.id}, 'research', 'running', now() - interval '5 minutes')`;
    const nv = provider([
      (c) =>
        c.url.startsWith(`https://api.vetta.sh/v1/sessions/${sessionId}/events`)
          ? ok({
              data: [
                { seq: 1, type: "session.running", data: {} },
                { seq: 2, type: "session.idle", data: { stop_reason: "awaiting_approval", pending_actions: [{ tool_call_id: "w1", name: "web_fetch" }, { tool_call_id: "x1", name: "shell.exec" }] } },
              ],
              has_more: false,
              next_cursor: null,
            })
          : undefined,
      (c) => (c.url.includes("/events") ? ok({ data: [], has_more: false, next_cursor: null }) : undefined),
      (c) => (c.method === "POST" ? ok({}, 202) : undefined),
    ]);
    expect(await reconcileSessions(sql, env, nv.fn)).toBeGreaterThanOrEqual(1);
    const [s] = await sql`select status, last_seq from naive_sessions where id = ${sessionId}`;
    expect(s).toEqual({ status: "running", last_seq: 2 }); // web_fetch auto-allowed, so it resumed
    const [approval] = await sql`select code from approvals where naive_session_id = ${sessionId} and tool_call_id = 'x1'`;
    expect(approval).toBeDefined();

    await sql`update approvals set expires_at = now() - interval '1 second' where code = ${approval!.code}`;
    expect(await expireStaleApprovals(sql, env, nv.fn)).toBeGreaterThanOrEqual(1);
    expect((await getApproval(sql, approval!.code as string)).status).toBe("expired");
    expect(nv.calls.at(-1)).toMatchObject({ body: { tool_call_id: "x1", decision: "deny" } });
  });

  test("research starts one Naive session per lead and skips leads with an open session", async () => {
    const lead = await newLead("research");
    const nv = provider([(c) => (c.url.endsWith("/v1/sessions") ? ok({ id: `ses_it_${run}_r`, status: "queued" }) : undefined)]);
    const first = await startResearch(sql, env, { lead_ids: [lead.id, "lead_missing"] }, "test", nv.fn);
    expect(first.started).toEqual([{ lead_id: lead.id, session_id: `ses_it_${run}_r` }]);
    expect(first.skipped).toEqual([{ lead_id: "lead_missing", reason: "not_found" }]);
    expect(nv.calls[0]!.body).toMatchObject({ agent_id: "agt_test", metadata: { lead_id: lead.id, purpose: "research" } });
    expect((await sql`select stage from leads where id = ${lead.id}`)[0]!.stage).toBe("researching");
    const second = await startResearch(sql, env, { lead_ids: [lead.id] }, "test", nv.fn);
    expect(second.skipped).toEqual([{ lead_id: lead.id, reason: "session_open" }]);
    expect(nv.calls).toHaveLength(1);
  });

  describe("approval lifetimes", () => {
    const HOUR = 3600;
    // The owner-token check (src/auth.ts) uses a Workers-only Web Crypto method that Bun lacks.
    beforeAll(() => {
      if (typeof crypto.subtle.timingSafeEqual === "function") return;
      Object.defineProperty(crypto.subtle, "timingSafeEqual", {
        configurable: true,
        value: (a: ArrayBuffer, b: ArrayBuffer) => {
          const x = new Uint8Array(a);
          const y = new Uint8Array(b);
          let diff = x.length ^ y.length;
          for (let i = 0; i < Math.min(x.length, y.length); i++) diff |= x[i]! ^ y[i]!;
          return diff === 0;
        },
      });
    });
    const lifetime = async (code: string) =>
      Number((await sql`select extract(epoch from expires_at - created_at) as s from approvals where code = ${code}`)[0]!.s);
    /** The real Worker routes (MCP tools/call, REST), with this database and an owner token. */
    const callWorker = (path: string, body: unknown, over: Partial<Env> = {}) =>
      worker.fetch(
        new Request(`https://example.test${path}`, {
          method: "POST",
          headers: { Authorization: "Bearer it-owner", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify(body),
        }),
        { ...env, DATABASE_URL: url, MCP_TOKEN: "it-owner", ...over },
        {} as ExecutionContext,
      );
    const mcpDraft = async (leadId: string, over: Partial<Env> = {}) => {
      const res = await callWorker(
        "/mcp",
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_draft", arguments: { lead_id: leadId, subject: "Hi", body: "Body" } } },
        over,
      );
      const rpc = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
      expect(rpc.result.isError).toBeFalsy();
      return JSON.parse(rpc.result.content[0]!.text).approval.code as string;
    };

    test("send approvals last 7 days by default, from MCP create_draft and from the REST API", async () => {
      const lead = await newLead("ttl-send");
      expect(await lifetime(await mcpDraft(lead.id))).toBe(168 * HOUR);

      const res = await callWorker(`/api/leads/${lead.id}/drafts`, { subject: "Hi again", body: "Body" });
      expect(res.status).toBe(201);
      const restCode = ((await res.json()) as { approval: { code: string } }).approval.code;
      expect(await lifetime(restCode)).toBe(168 * HOUR);

      // SEND_APPROVAL_TTL_HOURS overrides both paths.
      expect(await lifetime(await mcpDraft(lead.id, { SEND_APPROVAL_TTL_HOURS: "24" }))).toBe(24 * HOUR);
    });

    test("agent tool and question approvals last 1 hour by default", async () => {
      const lead = await newLead("ttl-tool");
      const sessionId = `ses_it_${run}_ttl`;
      await sql`insert into naive_sessions (id, lead_id, purpose, status) values (${sessionId}, ${lead.id}, 'research', 'running')`;
      const nv = provider([() => ok({}, 202)]);
      const res = await handleSessionIdle(
        sql,
        env,
        {
          sessionId,
          stopReason: "awaiting_approval",
          pendingActions: [
            { tool_call_id: "t1", name: "shell.exec", args: {} },
            { kind: "question", tool_call_id: "q1", name: "ask_operator", question: { prompt: "Which one?", fields: [{ key: "pick" }] } },
          ],
        },
        nv.fn,
      );
      expect(res.approvals).toHaveLength(2);
      for (const code of res.approvals) expect(await lifetime(code)).toBe(HOUR);

      const sessionId2 = `ses_it_${run}_ttl2`;
      await sql`insert into naive_sessions (id, lead_id, purpose, status) values (${sessionId2}, ${lead.id}, 'research', 'running')`;
      const custom = await handleSessionIdle(
        sql,
        { ...env, TOOL_APPROVAL_TTL_MINUTES: "5" },
        { sessionId: sessionId2, stopReason: "awaiting_approval", pendingActions: [{ tool_call_id: "t2", name: "shell.exec" }] },
        nv.fn,
      );
      expect(await lifetime(custom.approvals[0]!)).toBe(5 * 60);
    });

    test("after an hour the cron denies a tool approval to Naive; a send approval from the same moment stays open", async () => {
      const lead = await newLead("ttl-cron");
      const sessionId = `ses_it_${run}_ttlc`;
      await sql`insert into naive_sessions (id, lead_id, purpose, status) values (${sessionId}, ${lead.id}, 'research', 'running')`;
      const nv = provider([() => ok({}, 202)]);
      const idle = await handleSessionIdle(
        sql,
        env,
        { sessionId, stopReason: "awaiting_approval", pendingActions: [{ tool_call_id: "tc1", name: "shell.exec" }] },
        nv.fn,
      );
      const toolCode = idle.approvals[0]!;
      const send = await newApproval(lead.id);

      // Move both approvals 61 minutes into the past, as if an hour went by with no decision.
      await sql`update approvals set created_at = created_at - interval '61 minutes', expires_at = expires_at - interval '61 minutes'
                where code = any(${[toolCode, send.code]}::text[])`;
      expect(await expireStaleApprovals(sql, env, nv.fn)).toBeGreaterThanOrEqual(1);
      expect((await getApproval(sql, toolCode)).status).toBe("expired");
      expect(nv.calls.at(-1)).toMatchObject({
        url: `https://api.vetta.sh/v1/sessions/${sessionId}/tool_confirmations`,
        body: { tool_call_id: "tc1", decision: "deny" },
      });
      expect((await getApproval(sql, send.code)).status).toBe("pending");

      // Past 7 days the send approval expires too, and its draft goes back to 'draft' (nothing to deny).
      const calls = nv.calls.length;
      await sql`update approvals set created_at = created_at - interval '7 days', expires_at = expires_at - interval '7 days' where code = ${send.code}`;
      expect(await expireStaleApprovals(sql, env, nv.fn)).toBeGreaterThanOrEqual(1);
      expect((await getApproval(sql, send.code)).status).toBe("expired");
      expect((await sql`select status from drafts where id = ${send.draftId}`)[0]!.status).toBe("draft");
      expect(nv.calls).toHaveLength(calls);
    });
  });
});
