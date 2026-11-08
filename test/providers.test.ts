import { describe, expect, test } from "bun:test";
import { AgentMailClient, draftLabel } from "../src/providers/agentmail.ts";
import { ProviderError, type FetchFn } from "../src/providers/http.ts";
import { NAIVE_POST_ATTEMPTS, NaiveClient } from "../src/providers/naive.ts";

type Call = { url: string; init: RequestInit };

/** A fetch double that records calls and answers from a queue (a Response, or an Error to throw). */
function mockFetch(...answers: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn: FetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const headers = (c: Call) => new Headers(c.init.headers as Record<string, string>);

describe("AgentMailClient", () => {
  test("send posts {to, subject, text, labels} with the bearer key to the inbox", async () => {
    const { fn, calls } = mockFetch(json({ message_id: "<m1@agentmail.to>", thread_id: "t1" }));
    const client = new AgentMailClient("am_key", "crusonia@agentmail.to", fn);
    const sent = await client.send({ to: "ada@acme.com", subject: "Hi", text: "Body", labels: ["crusonia", draftLabel("draft_1")] });
    expect(sent).toEqual({ message_id: "<m1@agentmail.to>", thread_id: "t1" });
    expect(calls[0]!.url).toBe("https://api.agentmail.to/v0/inboxes/crusonia%40agentmail.to/messages/send");
    expect(calls[0]!.init.method).toBe("POST");
    expect(headers(calls[0]!).get("authorization")).toBe("Bearer am_key");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ to: "ada@acme.com", subject: "Hi", text: "Body", labels: ["crusonia", "draft-draft_1"] });
  });

  test("reply URL-encodes the <...> message id", async () => {
    const { fn, calls } = mockFetch(json({ message_id: "<m2@agentmail.to>", thread_id: "t1" }));
    await new AgentMailClient("k", "inbox", fn).reply("<abc@agentmail.to>", { text: "Thanks" });
    expect(calls[0]!.url).toBe("https://api.agentmail.to/v0/inboxes/inbox/messages/%3Cabc%40agentmail.to%3E/reply");
  });

  test("listByLabels sends repeated labels params", async () => {
    const { fn, calls } = mockFetch(json({ count: 1, messages: [{ message_id: "<m>", thread_id: "t", labels: [], timestamp: "x" }] }));
    const found = await new AgentMailClient("k", "inbox", fn).listByLabels(["crusonia", "draft-d1"], 1);
    expect(found).toHaveLength(1);
    expect(new URL(calls[0]!.url).searchParams.getAll("labels")).toEqual(["crusonia", "draft-d1"]);
    expect(calls[0]!.init.method).toBe("GET");
  });

  test("4xx is a definite failure; 5xx and network errors are ambiguous (reconcile, never resend)", async () => {
    const client = (r: Response | Error) => new AgentMailClient("k", "inbox", mockFetch(r).fn);
    const send = (r: Response | Error) => client(r).send({ to: "a@x.com", subject: "s", text: "t" }).then(() => undefined as never, (e) => e as ProviderError);
    const bad = await send(json({ message: "invalid to" }, 400));
    expect(bad).toBeInstanceOf(ProviderError);
    expect([bad.status, bad.ambiguous]).toEqual([400, false]);
    const down = await send(new Response("upstream", { status: 503 }));
    expect([down.status, down.ambiguous]).toEqual([503, true]);
    const net = await send(new TypeError("fetch failed"));
    expect([net.status, net.ambiguous]).toEqual([undefined, true]);
  });

  test("error messages never contain the API key", async () => {
    const err = (await new AgentMailClient("am_secret_key", "inbox", mockFetch(json({}, 401)).fn)
      .send({ to: "a@x.com", subject: "s", text: "t" })
      .catch((e) => e)) as Error;
    expect(err.message).not.toContain("am_secret_key");
  });
});

describe("NaiveClient", () => {
  test("createSession posts to /v1/sessions with bearer auth and a UUID Idempotency-Key", async () => {
    const { fn, calls } = mockFetch(json({ id: "ses_1", status: "queued" }));
    const res = await new NaiveClient("nv_key", fn).createSession({ agent_id: "agt_1", message: "hi", metadata: { lead_id: "lead_1" } });
    expect(res.id).toBe("ses_1");
    expect(calls[0]!.url).toBe("https://api.vetta.sh/v1/sessions");
    const h = headers(calls[0]!);
    expect(h.get("authorization")).toBe("Bearer nv_key");
    expect(h.get("idempotency-key")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ agent_id: "agt_1", message: "hi", metadata: { lead_id: "lead_1" } });
  });

  test("each POST gets its own key; an ambiguous failure is retried with the same key", async () => {
    const { fn, calls } = mockFetch(new Response("", { status: 502 }), json({}, 202), json({}, 202));
    const client = new NaiveClient("k", fn, undefined, 0);
    await client.confirmTool("ses_1", { tool_call_id: "call_1", decision: "allow", scope: "call" });
    await client.answer("ses_1", { tool_call_id: "call_2", answers: { mailbox: "hi@acme.com" } });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.vetta.sh/v1/sessions/ses_1/tool_confirmations",
      "https://api.vetta.sh/v1/sessions/ses_1/tool_confirmations",
      "https://api.vetta.sh/v1/sessions/ses_1/answers",
    ]);
    const keys = calls.map((c) => headers(c).get("idempotency-key"));
    expect(keys[0]).toBe(keys[1]!);
    expect(keys[2]).not.toBe(keys[0]!);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ tool_call_id: "call_1", decision: "allow", scope: "call" });
  });

  test("a 429 (Naive at capacity) is retried with the same key, at most NAIVE_POST_ATTEMPTS times", async () => {
    const busy = () => json({ error: { type: "rate_limit", code: "rate_limited" } }, 429);
    const once = mockFetch(busy(), json({ id: "ses_1", status: "running" }, 201));
    const session = await new NaiveClient("k", once.fn, undefined, 0).createSession({ agent_id: "agt_1", message: "hi" });
    expect(session.id).toBe("ses_1");
    expect(once.calls).toHaveLength(2);
    expect(headers(once.calls[0]!).get("idempotency-key")).toBe(headers(once.calls[1]!).get("idempotency-key")!);

    const always = mockFetch(busy(), busy(), busy(), busy());
    const err = await new NaiveClient("k", always.fn, undefined, 0).createSession({ agent_id: "agt_1", message: "hi" }).catch((e) => e);
    expect(err.status).toBe(429);
    expect(always.calls).toHaveLength(NAIVE_POST_ATTEMPTS);
  });

  test("a 4xx is not retried", async () => {
    const { fn, calls } = mockFetch(json({ error: "validation_failed" }, 400));
    const err = await new NaiveClient("k", fn).answer("ses_1", { tool_call_id: "c", answers: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(1);
  });

  test("getSession and listEvents are GETs with after_seq", async () => {
    const { fn, calls } = mockFetch(
      json({ id: "ses_1", status: "idle", stop_reason: "awaiting_approval", pending_actions: [{ tool_call_id: "c1", name: "gmail.send", args: {} }] }),
      json({ data: [{ seq: 8, type: "session.idle", data: {} }], has_more: false, next_cursor: null }),
    );
    const client = new NaiveClient("k", fn);
    expect((await client.getSession("ses_1")).pending_actions?.[0]?.name).toBe("gmail.send");
    expect((await client.listEvents("ses_1", 7)).data[0]!.seq).toBe(8);
    expect(calls[1]!.url).toBe("https://api.vetta.sh/v1/sessions/ses_1/events?after_seq=7&limit=100");
    expect(calls.every((c) => c.init.method === "GET" && !headers(c).has("idempotency-key"))).toBe(true);
  });
});
