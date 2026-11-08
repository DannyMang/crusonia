// The bridge end to end against the mocked iMessage (MockMessenger) and a fake Worker at fetch: owner-only
// filter, command round trip with a signed webhook, the local /notify (operator) endpoint, and the HTTP server.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { Bridge, REPLY_WINDOW_MS } from "../src/bridge.ts";
import type { Config } from "../src/config.ts";
import { loadConfig } from "../src/config.ts";
import { signedHeaders, verify } from "../src/hmac.ts";
import { setSilent } from "../src/log.ts";
import { MockMessenger } from "../src/messenger.ts";
import { isOwner, maskHandle, normalizeHandle } from "../src/phone.ts";
import { buildServer } from "../src/server.ts";
import { toInbound } from "../src/spectrum-map.ts";
import type { FetchFn } from "../src/worker-client.ts";

setSilent(true);

const OWNER = "+15550001111";
const STRANGER = "+15550002222";
const secret = "b".repeat(64);
const config: Config = {
  mode: "mock",
  ownerPhone: OWNER,
  ownerHandles: [OWNER, "owner@example.com"],
  bridgeSecret: secret,
  workerUrl: "https://worker.test",
  pollIntervalMs: 5_000,
  port: 0,
  healthHost: "127.0.0.1",
  version: "test",
  logLevel: "info",
};

type Call = { url: string; body: any; headers: Record<string, string> };

/** A fake Worker: verifies the signature like the real one and answers with `reply`. */
function fakeWorker(reply: (body: any) => { status?: number; json: unknown } = () => ({ json: { ok: true, reply: "Done." } })) {
  const calls: Call[] = [];
  const fn: FetchFn = async (url, init) => {
    const headers = init.headers as Record<string, string>;
    const body = init.body as string;
    calls.push({ url, body: JSON.parse(body), headers });
    const ok = verify({ secret, path: "/webhooks/photon", body, timestamp: headers["x-crusonia-timestamp"], signature: headers["x-crusonia-signature"] });
    if (!ok.ok) return new Response(JSON.stringify({ error: { code: "invalid_signature" } }), { status: 401 });
    const r = reply(JSON.parse(body));
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  };
  return { fn, calls };
}

function setup(reply?: Parameters<typeof fakeWorker>[0]) {
  const messenger = new MockMessenger(OWNER);
  const worker = fakeWorker(reply);
  const bridge = new Bridge({ config, messenger, fetch: worker.fn, workerRetryDelaysMs: [1, 1] });
  messenger.start((m) => bridge.handleInbound(m));
  return { messenger, worker, bridge };
}

const headersOf = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] });

const NOTICE_BUBBLE = "guid-notice-1";
const tap = (emoji = "👍", targetId: string | undefined = NOTICE_BUBBLE) => ({ emoji, targetId });

describe("only the owner's tapbacks do anything", () => {
  test("anyone else's tapback or text: no Worker call, no reply", async () => {
    const { messenger, worker } = setup();
    await messenger.inject({ from: STRANGER, reaction: tap() });
    await messenger.inject({ from: STRANGER, text: "A 7KXM" });
    await messenger.inject({ from: "someone@example.com", reaction: tap() });
    expect(worker.calls).toHaveLength(0);
    expect(messenger.outbox).toHaveLength(0);
  });

  test("the owner's tapback in a group chat is ignored too", async () => {
    const { messenger, worker } = setup();
    await messenger.inject({ from: OWNER, reaction: tap(), isDirect: false });
    expect(worker.calls).toHaveLength(0);
  });

  test("handle normalization: formatting differences and aliases still match; lookalikes do not", () => {
    expect(isOwner("+1 (555) 000-1111", [OWNER])).toBe(true);
    expect(isOwner("tel:+15550001111", [OWNER])).toBe(true);
    expect(isOwner("Owner@Example.com", config.ownerHandles)).toBe(true);
    expect(isOwner("15550001111", [OWNER])).toBe(false); // no + : not E.164
    expect(isOwner("+155500011112", [OWNER])).toBe(false);
    expect(isOwner(undefined, [OWNER])).toBe(false);
    expect(normalizeHandle("garbage")).toBeUndefined();
    expect(maskHandle(OWNER)).toBe("+1******1111");
    expect(maskHandle(OWNER)).not.toContain("0001");
  });
});

// The incident: read receipts come in with the owner as sender and a new id each time. Answering one got the answer
// read, which sent another receipt, which was answered again, until the box was stopped.
describe("no event but a thumb on a notice ever produces a text", () => {
  test("the loop: a notice, then read receipts for everything we send, produces no text at all", async () => {
    const { messenger, worker, bridge } = setup();
    const body = JSON.stringify({ id: "approval:TG36", type: "approval", text: "Request TG36 · draft v1 to Dana: ..." });
    await bridge.handleNotify(body, headersOf(signedHeaders(secret, "/notify", body)));
    expect(messenger.outbox).toHaveLength(1);
    // A faithful phone: each thing it receives is read at once, which is a new receipt event from the owner.
    for (let i = 0; i < 20 && i < messenger.outbox.length; i++) {
      await messenger.inject({ from: OWNER, id: `${messenger.outbox[i]!.id}:read:${i}`, contentType: "read" });
    }
    expect(messenger.outbox).toHaveLength(1); // only the notice
    expect(worker.calls).toHaveLength(0);
  });

  test("receipts, typing, attachments, polls and other content are silent", async () => {
    const { messenger, worker } = setup();
    for (const contentType of ["read", "typing", "attachment", "voice", "contact", "richlink", "poll", "group", "unknown"]) {
      await messenger.inject({ from: OWNER, contentType });
    }
    expect(worker.calls).toHaveLength(0);
    expect(messenger.outbox).toHaveLength(0);
  });

  test("texts get no answer: there are no text commands", async () => {
    const { messenger, worker } = setup();
    for (const text of ["help", "status", "pause", "A 7KXM", "R 7KXM", "E 7KXM new text", "yes", "what is this"]) {
      await messenger.inject({ from: OWNER, text });
    }
    expect(worker.calls).toHaveLength(0);
    expect(messenger.outbox).toHaveLength(0);
  });

  test("our own message echoing back is never acted on or answered, even carrying a thumb", async () => {
    const { messenger, worker } = setup();
    await messenger.inject({ from: OWNER, fromSelf: true, text: "Approved." });
    await messenger.inject({ from: OWNER, fromSelf: true, contentType: "read" });
    await messenger.inject({ from: OWNER, fromSelf: true, reaction: tap() });
    expect(worker.calls).toHaveLength(0);
    expect(messenger.outbox).toHaveLength(0);
  });

  test("other tapbacks, and thumbs without a target, are silent", async () => {
    const { messenger, worker } = setup();
    for (const emoji of ["❤️", "😂", "‼️", "❓"]) await messenger.inject({ from: OWNER, reaction: tap(emoji) });
    await messenger.inject({ from: OWNER, reaction: { emoji: "👍", targetId: undefined } });
    expect(worker.calls).toHaveLength(0);
    expect(messenger.outbox).toHaveLength(0);
  });

  test("a thumb on a bubble that is not a notice: the Worker answers with no reply, so nothing is texted", async () => {
    const { messenger, worker } = setup(() => ({ json: { ok: false, reply: "" } }));
    await messenger.inject({ from: OWNER, reaction: tap("👍", "not-a-notice") });
    expect(worker.calls).toHaveLength(1);
    expect(messenger.outbox).toHaveLength(0);
  });
});

describe("tapbacks on a notice", () => {
  test("👍 is a signed react command bound to that bubble; the Worker's confirmation is texted", async () => {
    const { messenger, worker } = setup(() => ({ json: { ok: true, reply: 'Approved. Sent "Hi" to Dana.' } }));
    await messenger.inject({ from: OWNER, id: "r-1", reaction: tap() });
    expect(worker.calls[0]!.url).toBe("https://worker.test/webhooks/photon");
    expect(worker.calls[0]!.body).toMatchObject({ id: "r-1", from: OWNER, command: { action: "react", reaction: "like", message_id: NOTICE_BUBBLE } });
    expect(messenger.outbox).toEqual([expect.objectContaining({ to: OWNER, text: 'Approved. Sent "Hi" to Dana.' })]);
  });

  test("👎 (any skin tone) is a dislike", async () => {
    const { messenger, worker } = setup();
    await messenger.inject({ from: OWNER, reaction: tap("👎🏽", "guid-9") });
    expect(worker.calls.map((c) => c.body.command)).toEqual([{ action: "react", reaction: "dislike", message_id: "guid-9" }]);
  });

  test("a duplicate delivery of the same tapback acts once", async () => {
    const { messenger, worker } = setup();
    await messenger.inject({ from: OWNER, id: "dup-1", reaction: tap() });
    await messenger.inject({ from: OWNER, id: "dup-1", reaction: tap() });
    expect(worker.calls).toHaveLength(1);
    expect(messenger.outbox).toHaveLength(1);
  });

  test("Worker 5xx is retried with the same event id; a 4xx is not", async () => {
    let n = 0;
    const flaky = setup(() => (++n < 3 ? { status: 503, json: { error: { code: "busy" } } } : { json: { ok: true, reply: "Approved." } }));
    await flaky.messenger.inject({ from: OWNER, id: "retry-1", reaction: tap() });
    expect(flaky.worker.calls.map((c) => c.body.id)).toEqual(["retry-1", "retry-1", "retry-1"]);
    expect(flaky.messenger.outbox.at(-1)!.text).toBe("Approved.");

    const bad = setup(() => ({ status: 400, json: { error: { code: "invalid_payload" } } }));
    await bad.messenger.inject({ from: OWNER, reaction: tap() });
    expect(bad.worker.calls).toHaveLength(1);
    expect(bad.messenger.outbox.at(-1)!.text).toContain("didn't confirm");
  });
});

describe("hard loop guard: one non-notice text per 10 minutes", () => {
  const at = (msg: Parameters<Bridge["handleInbound"]>[0], bridge: Bridge, ms: number) => bridge.handleInbound(msg, ms);
  const msg = (id: string, messenger: MockMessenger) => ({
    id,
    sender: OWNER,
    text: undefined,
    contentType: "reaction",
    reaction: tap(),
    isDirect: true,
    receivedAt: new Date(),
    reply: (text: string) => messenger.sendToOwner(text).then(() => undefined),
  });

  test("every thumb still decides, but only the first confirmation in the window is texted", async () => {
    const { messenger, worker, bridge } = setup();
    const t0 = 1_800_000_000_000;
    await at(msg("a", messenger), bridge, t0);
    await at(msg("b", messenger), bridge, t0 + 1_000);
    await at(msg("c", messenger), bridge, t0 + REPLY_WINDOW_MS - 1);
    expect(worker.calls).toHaveLength(3);
    expect(messenger.outbox).toHaveLength(1);
    await at(msg("d", messenger), bridge, t0 + REPLY_WINDOW_MS);
    expect(messenger.outbox).toHaveLength(2);
  });

  test("notices are not limited by it (the Worker's send cap covers those)", async () => {
    const { messenger, bridge } = setup();
    await bridge.handleInbound(msg("a", messenger));
    const body = JSON.stringify({ id: "approval:7KXM", type: "approval", text: "Request 7KXM" });
    await bridge.handleNotify(body, headersOf(signedHeaders(secret, "/notify", body)));
    expect(messenger.outbox).toHaveLength(2);
  });
});

describe("/notify", () => {
  const notice = (over: Record<string, unknown> = {}) => JSON.stringify({ id: "approval:7KXM", type: "approval", text: "Draft to Dana: reply A 7KXM", ...over });

  test("a signed notice texts the owner once; a replay of the same id is acknowledged without a second text", async () => {
    const { messenger, bridge } = setup();
    const body = notice();
    expect((await bridge.handleNotify(body, headersOf(signedHeaders(secret, "/notify", body)))).status).toBe(200);
    const again = await bridge.handleNotify(body, headersOf(signedHeaders(secret, "/notify", body)));
    expect(again.body).toEqual({ ok: true, duplicate: true });
    expect(messenger.outbox).toEqual([expect.objectContaining({ to: OWNER, text: "Draft to Dana: reply A 7KXM" })]);
  });

  test("bad signature, stale timestamp, wrong path: 401 and nothing sent", async () => {
    const { messenger, bridge } = setup();
    const body = notice();
    expect((await bridge.handleNotify(body, headersOf(signedHeaders("x".repeat(64), "/notify", body)))).status).toBe(401);
    const old = Math.floor(Date.now() / 1000) - 600;
    expect((await bridge.handleNotify(body, headersOf(signedHeaders(secret, "/notify", body, old)))).status).toBe(401);
    expect((await bridge.handleNotify(body, headersOf(signedHeaders(secret, "/webhooks/photon", body)))).status).toBe(401);
    expect(messenger.outbox).toHaveLength(0);
  });

  test("the payload never chooses the recipient: extra fields are ignored, the owner is texted", async () => {
    const { messenger, bridge } = setup();
    const body = notice({ id: "approval:9ABC", to: STRANGER });
    expect((await bridge.handleNotify(body, headersOf(signedHeaders(secret, "/notify", body)))).status).toBe(200);
    expect(messenger.outbox.map((o) => o.to)).toEqual([OWNER]);
  });

  test("while disconnected: 503 and the id is released so the Worker's retry goes through", async () => {
    const { messenger, bridge } = setup();
    messenger.connected = false;
    const body = notice({ id: "approval:RTRY" });
    expect((await bridge.handleNotify(body, headersOf(signedHeaders(secret, "/notify", body)))).status).toBe(503);
    messenger.connected = true;
    expect((await bridge.handleNotify(body, headersOf(signedHeaders(secret, "/notify", body)))).status).toBe(200);
    expect(messenger.outbox).toHaveLength(1);
  });

  test("invalid payloads are 400", async () => {
    const { bridge } = setup();
    for (const body of ["not json", notice({ type: "sms_blast" }), notice({ text: "" })]) {
      expect((await bridge.handleNotify(body, headersOf(signedHeaders(secret, "/notify", body)))).status).toBe(400);
    }
  });
});

describe("HTTP server (mock mode)", () => {
  const messenger = new MockMessenger(OWNER);
  const worker = fakeWorker((b) => ({ json: { ok: true, reply: `ok ${b.command.action}` } }));
  const bridge = new Bridge({ config, messenger, fetch: worker.fn });
  messenger.start((m) => bridge.handleInbound(m));
  const server = buildServer({ bridge, secret, mock: messenger });
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  test("GET /health reports the connection without secrets or numbers", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ ok: true, service: "crusonia-bridge", mode: "mock", state: "connected" });
    expect(text).not.toContain("5550001111");
    expect(text).not.toContain(secret);
  });

  test("POST /notify over HTTP", async () => {
    const body = JSON.stringify({ id: "info:1", type: "info", text: "hello" });
    const res = await fetch(`${base}/notify`, { method: "POST", headers: signedHeaders(secret, "/notify", body), body });
    expect(res.status).toBe(200);
    expect(messenger.outbox.at(-1)).toMatchObject({ to: OWNER, text: "hello" });
    const unsigned = await fetch(`${base}/notify`, { method: "POST", body });
    expect(unsigned.status).toBe(401);
  });

  test("POST /mock/inbound needs a signature and returns the replies", async () => {
    const body = JSON.stringify({ from: OWNER, reaction: { emoji: "👍", targetId: "guid-1" } });
    expect((await fetch(`${base}/mock/inbound`, { method: "POST", body })).status).toBe(401);
    const res = await fetch(`${base}/mock/inbound`, { method: "POST", headers: signedHeaders(secret, "/mock/inbound", body), body });
    expect(((await res.json()) as any).replies).toEqual([expect.objectContaining({ to: OWNER, text: "ok react" })]);
  });

  test("oversized bodies are refused; unknown routes are 404", async () => {
    expect((await fetch(`${base}/notify`, { method: "POST", body: "x".repeat(70 * 1024) }).catch(() => ({ status: 413 }))).status).toBe(413);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe("Spectrum message mapping", () => {
  const space = { type: "dm", sent: [] as string[], send: async function (t: string) { this.sent.push(t); } };

  test("inbound text maps sender, text and DM; replies go to the same space", async () => {
    const m = toInbound(space, { id: "m1", direction: "inbound", sender: { id: OWNER }, content: { type: "text", text: "A 7KXM" } })!;
    expect(m).toMatchObject({ id: "m1", sender: OWNER, text: "A 7KXM", isDirect: true, contentType: "text" });
    await m.reply("ok");
    expect(space.sent).toEqual(["ok"]);
  });

  test("a tapback maps to its emoji and the target message id", () => {
    const m = toInbound(space, { id: "g:reaction:7", sender: { id: OWNER }, content: { type: "reaction", emoji: "👍", target: { id: "guid-123" } } })!;
    expect(m).toMatchObject({ contentType: "reaction", text: undefined, reaction: { emoji: "👍", targetId: "guid-123" } });
  });

  test("a read receipt stays a non-text event from the owner (the bridge drops it)", () => {
    const m = toInbound(space, { id: "g:read:7", sender: { id: OWNER }, content: { type: "read" } })!;
    expect(m).toMatchObject({ contentType: "read", sender: OWNER, text: undefined });
    expect(m.reaction).toBeUndefined();
  });

  test("a message from the line's own number is dropped like any echo", () => {
    expect(toInbound({ ...space, phone: "+15550007777" }, { id: "m6", sender: { id: "+15550007777" }, content: { type: "text", text: "x" } })).toBeNull();
    expect(toInbound({ ...space, phone: "shared" }, { id: "m7", sender: { id: OWNER }, content: { type: "text", text: "x" } })).not.toBeNull();
  });

  test("our own outbound echoes are dropped; non-text content has no text; groups are not direct", () => {
    expect(toInbound(space, { id: "m2", direction: "outbound", content: { type: "text", text: "x" } })).toBeNull();
    expect(toInbound(space, { id: "m3", sender: { id: "a", kind: "agent" }, content: { type: "text", text: "x" } })).toBeNull();
    expect(toInbound(space, { id: "m4", sender: { id: OWNER }, content: { type: "reaction" } })!.text).toBeUndefined();
    expect(toInbound({ ...space, type: "group" }, { id: "m5", sender: { id: OWNER }, content: { type: "text", text: "x" } })!.isDirect).toBe(false);
  });
});

describe("config", () => {
  const base = { OWNER_PHONE: OWNER, BRIDGE_SECRET: secret, WORKER_URL: "https://worker.test/" };

  test("mock mode needs no Spectrum credentials; live mode does", () => {
    expect(loadConfig({ ...base, SPECTRUM_MODE: "mock" })).toMatchObject({
      mode: "mock",
      workerUrl: "https://worker.test",
      port: 8080,
      healthHost: "127.0.0.1", // loopback by default: nothing outside the box can reach it
      pollIntervalMs: 5_000,
    });
    expect(() => loadConfig(base)).toThrow(/SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET/);
  });

  test("errors name the variable, never its value", () => {
    let message = "";
    try {
      loadConfig({ ...base, SPECTRUM_MODE: "mock", OWNER_PHONE: "5550001111", BRIDGE_SECRET: "short-secret-value" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("OWNER_PHONE");
    expect(message).toContain("BRIDGE_SECRET");
    expect(message).not.toContain("5550001111");
    expect(message).not.toContain("short-secret-value");
  });

  test("OWNER_ALIASES adds handles", () => {
    expect(loadConfig({ ...base, SPECTRUM_MODE: "mock", OWNER_ALIASES: "me@example.com, " }).ownerHandles).toEqual([OWNER, "me@example.com"]);
  });
});
