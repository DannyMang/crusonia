import { describe, expect, test } from "bun:test";
import { AgentMailClient, draftLabel } from "../src/providers/agentmail.ts";
import { ProviderError, type FetchFn } from "../src/providers/http.ts";

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
