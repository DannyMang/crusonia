// Integration tests against a real Postgres (a Neon dev branch, never production) with AgentMail
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
import { expireStaleApprovals, getApproval, type Deps } from "../src/services/approvals.ts";
import { createLead } from "../src/services/crm.ts";
import { createDraft } from "../src/services/drafts.ts";
import { handleAgentMailEvent } from "../src/services/inbound.ts";
import { approveAndSend, reconcileSending } from "../src/services/send.ts";
import { startResearch } from "../src/services/workflows.ts";
import { createTestWorkspace, deleteTestWorkspaces, testKey } from "./helpers/workspace.ts";

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
  // Earlier tests leave sessions 'running' in this workspace; the per-workspace limits have their own tests.
  MAX_ACTIVE_SESSIONS: "100",
};
const run = crypto.randomUUID().slice(0, 8);
const email = (name: string) => `${name}-${run}@it.example.com`;
let sql: Sql;
/** This suite's own workspace (deleted afterwards), so the shared dev database's owner workspace is never touched. */
let WS: string;

async function newLead(name: string) {
  return createLead(sql, WS, { email: email(name), name, source: "it_test", consent: { text: "integration test opt-in" } }, "test");
}
async function newApproval(leadId: string, subject = "Hello") {
  const { approval, draft } = await createDraft(sql, WS, { lead_id: leadId, subject, body: "Body" }, { ttlMinutes: sendApprovalTtlMinutes(env), via: "api", actor: "test" });
  return { code: approval.code, draftId: draft.id };
}
async function failure(p: Promise<unknown>) {
  const e = await p.then(() => undefined, (err) => err);
  expect(e).toBeInstanceOf(ApiError);
  return `${(e as ApiError).status} ${(e as ApiError).code}`;
}

suite("database integration (mocked providers)", () => {
  beforeAll(async () => {
    sql = getSql(url);
    WS = await createTestWorkspace(sql, `db_${run}`);
    env.SEND_WORKSPACE_IDS = WS; // not the owner workspace: sending must be enabled for it
  });

  afterAll(async () => {
    if (!sql) return;
    await deleteTestWorkspaces(sql, [WS]);
    await sql`delete from webhook_events where event_id like ${`%${run}%`}`;
  });

  test("approve sends once, records ids, message and stage; a second approve is refused", async () => {
    const lead = await newLead("send");
    const { code, draftId } = await newApproval(lead.id);
    const am = provider([(c) => (c.url.endsWith("/messages/send") ? ok({ message_id: `<m1-${run}@agentmail.to>`, thread_id: `thr_${run}_1` }) : undefined)]);
    const result = await approveAndSend({ sql, ws: WS, env, actor: "test", fetch: am.fn }, code);
    expect(result).toMatchObject({ status: "sent", draft_id: draftId, thread_id: `thr_${run}_1` });
    expect(am.calls).toHaveLength(1);
    expect(am.calls[0]!.body).toMatchObject({ to: email("send"), subject: "Hello", text: "Body" });
    expect(am.calls[0]!.body.labels).toContain(`draft-${draftId}`);

    const [d] = await sql`select status, provider_message_id, provider_thread_id from drafts where id = ${draftId}`;
    expect(d).toEqual({ status: "sent", provider_message_id: `<m1-${run}@agentmail.to>`, provider_thread_id: `thr_${run}_1` });
    const [m] = await sql`select direction, to_addr from messages where provider_message_id = ${`<m1-${run}@agentmail.to>`}`;
    expect(m).toEqual({ direction: "out", to_addr: email("send") });
    expect((await sql`select stage from leads where id = ${lead.id}`)[0]!.stage).toBe("sent");
    expect((await getApproval(sql, WS, code)).status).toBe("approved");

    expect(await failure(approveAndSend({ sql, ws: WS, env, actor: "test", fetch: am.fn }, code))).toBe("409 approval_not_pending");
    expect(am.calls).toHaveLength(1);
  });

  test("two concurrent approvals of the same code send exactly once", async () => {
    const lead = await newLead("race");
    const { code } = await newApproval(lead.id);
    const am = provider([(c) => (c.url.endsWith("/messages/send") ? ok({ message_id: `<race-${run}@agentmail.to>`, thread_id: `thr_${run}_r` }) : undefined)]);
    const results = await Promise.allSettled([1, 2, 3].map(() => approveAndSend({ sql, ws: WS, env, actor: "test", fetch: am.fn }, code)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(am.calls).toHaveLength(1);
  });

  test("an ambiguous AgentMail failure leaves the draft 'sending'; the cron reconciles it by label", async () => {
    const lead = await newLead("ambiguous");
    const { code, draftId } = await newApproval(lead.id);
    const down = provider([() => new Response("bad gateway", { status: 502 })]);
    expect(await approveAndSend({ sql, ws: WS, env, actor: "test", fetch: down.fn }, code)).toMatchObject({ status: "sending", draft_id: draftId });
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
    expect(await failure(approveAndSend({ sql, ws: WS, env, actor: "test", fetch: bad.fn }, code))).toBe("502 send_failed");
    expect((await sql`select status from drafts where id = ${draftId}`)[0]!.status).toBe("send_failed");
    const { editApproval } = await import("../src/services/approvals.ts");
    const deps: Deps = { sql, ws: WS, env, actor: "test", sendTtlMinutes: sendApprovalTtlMinutes(env) };
    const retry = await editApproval(deps, code, {});
    expect(retry.draft.version).toBe(2);
    expect(retry.approval.status).toBe("pending");
  });

  test("approvals are bound to the recipient, the latest version, consent and suppression", async () => {
    const lead = await newLead("bound");
    const first = await newApproval(lead.id, "v1");
    const second = await newApproval(lead.id, "v2");
    const am = provider([() => ok({ message_id: "<never>", thread_id: "never" })]);
    const deps = { sql, ws: WS, env, actor: "test", fetch: am.fn };
    expect(await failure(approveAndSend(deps, first.code))).toBe("409 approval_not_pending"); // closed by v2

    await sql`update leads set email = ${email("bound-changed")} where id = ${lead.id}`;
    expect(await failure(approveAndSend(deps, second.code))).toBe("409 recipient_mismatch");
    await sql`update leads set email = ${email("bound")} where id = ${lead.id}`;

    await sql`insert into suppressions (workspace_id, email, reason) values (${WS}, ${email("bound")}, 'test')`;
    expect(await failure(approveAndSend(deps, second.code))).toBe("403 suppressed");
    await sql`delete from suppressions where workspace_id = ${WS} and email = ${email("bound")}`;

    await sql`update leads set consent_at = null where id = ${lead.id}`;
    expect(await failure(approveAndSend(deps, second.code))).toBe("403 no_consent");
    await sql`update leads set consent_at = now() where id = ${lead.id}`;

    await sql`update approvals set expires_at = now() - interval '1 second' where code = ${second.code}`;
    expect(await failure(approveAndSend(deps, second.code))).toBe("410 approval_expired");
    expect((await getApproval(sql, WS, second.code)).status).toBe("expired");
    expect(am.calls).toHaveLength(0);
  });

  test("a reply on our thread is matched, classified, and stops pending follow-ups", async () => {
    const lead = await newLead("reply");
    const { code } = await newApproval(lead.id, "first touch");
    const am = provider([() => ok({ message_id: `<r1-${run}@agentmail.to>`, thread_id: `thr_${run}_reply` })]);
    await approveAndSend({ sql, ws: WS, env, actor: "test", fetch: am.fn }, code);
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
    expect((await getApproval(sql, WS, pending.code)).status).toBe("expired");
    expect((await sql`select status from drafts where id = ${pending.draftId}`)[0]!.status).toBe("cancelled");
  });

  test("research queues one run per lead, with its first message and limits, and skips leads with an open run", async () => {
    const lead = await newLead("research");
    const first = await startResearch(sql, env, WS, { lead_ids: [lead.id, "lead_missing"] }, "test");
    expect(first.failed).toEqual([]);
    expect(first.started).toHaveLength(1);
    expect(first.started[0]).toMatchObject({ lead_id: lead.id });
    expect(first.skipped).toEqual([{ lead_id: "lead_missing", reason: "not_found" }]);
    const runId = first.started[0]!.session_id;
    expect(runId).toStartWith("run_");
    expect((await sql`select stage from leads where id = ${lead.id}`)[0]!.stage).toBe("researching");
    const [row] = await sql`select workspace_id, billing_owner_id, workflow_version, status, role, message, input, max_minutes, max_tool_calls, max_cost_micro_usd::text
                            from agent_runs where id = ${runId}`;
    expect(row).toMatchObject({ workspace_id: WS, billing_owner_id: WS, workflow_version: "research@11", status: "queued", role: "researcher", max_minutes: 15, max_tool_calls: 60, max_cost_micro_usd: "1000000" });
    expect(row!.input).toMatchObject({ run_id: runId });
    expect(row!.message).toStartWith(`Research lead ${lead.id} for Crusonia.`);
    expect(row!.message).toContain(`Crusonia run id: ${runId}`);
    expect(row!.message).toContain("There is no Company summary yet");
    const second = await startResearch(sql, env, WS, { lead_ids: [lead.id] }, "test");
    expect(second.skipped).toEqual([{ lead_id: lead.id, reason: "session_open" }]);
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
    /** The real Worker routes (MCP tools/call, REST), with this database and a key of this suite's workspace. */
    let key = "";
    const callWorker = async (path: string, body: unknown, over: Partial<Env> = {}) => {
      key ||= await testKey(sql, WS);
      return worker.fetch(
        new Request(`https://example.test${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify(body),
        }),
        { ...env, DATABASE_URL: url, MCP_TOKEN: "it-owner", ...over },
        {} as ExecutionContext,
      );
    };
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

    test("a send approval stays open for its 7 days, then the cron expires it and its draft goes back to 'draft'", async () => {
      const lead = await newLead("ttl-cron");
      const send = await newApproval(lead.id);

      await sql`update approvals set created_at = created_at - interval '61 minutes', expires_at = expires_at - interval '61 minutes' where code = ${send.code}`;
      await expireStaleApprovals(sql);
      expect((await getApproval(sql, WS, send.code)).status).toBe("pending");

      await sql`update approvals set created_at = created_at - interval '7 days', expires_at = expires_at - interval '7 days' where code = ${send.code}`;
      expect(await expireStaleApprovals(sql)).toBeGreaterThanOrEqual(1);
      expect((await getApproval(sql, WS, send.code)).status).toBe("expired");
      expect((await sql`select status from drafts where id = ${send.draftId}`)[0]!.status).toBe("draft");
    });
  });
});
