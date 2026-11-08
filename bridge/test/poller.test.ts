// The outbound-only notice loop against a fake Worker: signed polls, status reporting, texting the owner, acks on the
// next poll, no leases while disconnected, and no double texts when a lease is handed out twice.
import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { verify } from "../src/hmac.ts";
import { setSilent } from "../src/log.ts";
import { MockMessenger } from "../src/messenger.ts";
import { POLL_PATH, Poller } from "../src/poller.ts";
import type { FetchFn } from "../src/worker-client.ts";

setSilent(true);

const OWNER = "+15550001111";
const secret = "p".repeat(64);
const config: Config = {
  mode: "mock",
  ownerPhone: OWNER,
  ownerHandles: [OWNER],
  bridgeSecret: secret,
  workerUrl: "https://worker.test",
  pollIntervalMs: 5_000,
  port: 0,
  healthHost: "127.0.0.1",
  version: "abc1234",
  logLevel: "info",
};

type Notice = { id: string; type: string; text: string };

/** Fake Worker: verifies each poll's signature, records bodies, hands out the queued notice batches in order. */
function worker(batches: Notice[][], over: { status?: number; enabled?: boolean } = {}) {
  const polls: any[] = [];
  const fn: FetchFn = async (url, init) => {
    const headers = init.headers as Record<string, string>;
    const body = init.body as string;
    expect(url).toBe(`https://worker.test${POLL_PATH}`);
    expect(verify({ secret, path: POLL_PATH, body, timestamp: headers["x-crusonia-timestamp"], signature: headers["x-crusonia-signature"] }).ok).toBe(true);
    polls.push(JSON.parse(body));
    if (over.status) return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: over.status });
    return new Response(JSON.stringify({ ok: true, enabled: over.enabled ?? true, notices: batches.shift() ?? [], poll_after_ms: 5000 }));
  };
  return { fn, polls };
}

describe("Poller", () => {
  test("texts the owner what the Worker hands over and acks it on the next poll, with status", async () => {
    const messenger = new MockMessenger(OWNER);
    const w = worker([[{ id: "approval:7KXM", type: "approval", text: "Draft to Dana: reply A 7KXM" }]]);
    const poller = new Poller({ config, messenger, fetch: w.fn, version: config.version });

    expect(await poller.pollOnce()).toMatchObject({ delivered: 1, failed: 0 });
    expect(messenger.outbox).toEqual([expect.objectContaining({ to: OWNER, text: "Draft to Dana: reply A 7KXM" })]);
    expect(w.polls[0]).toMatchObject({ acks: [], max: 5, bridge: { version: "abc1234", mode: "mock", state: "connected", connected: true } });

    await poller.pollOnce();
    // The ack carries the bubble's iMessage id so a later tapback on it can be matched to the approval.
    expect(w.polls[1].acks).toEqual([{ id: "approval:7KXM", ok: true, message_id: messenger.outbox[0]!.id }]);
    expect(poller.status()).toMatchObject({ worker_enabled: true, notices_sent: 1, last_poll_error: null });
  });

  test("while the iMessage connection is down it asks for nothing (max 0) but still reports status", async () => {
    const messenger = new MockMessenger(OWNER);
    messenger.connected = false;
    const w = worker([]);
    await new Poller({ config, messenger, fetch: w.fn }).pollOnce();
    expect(w.polls[0]).toMatchObject({ max: 0, bridge: { connected: false } });
  });

  test("a failed send is acked as failed (the Worker retries it later); a repeated lease is not texted twice", async () => {
    const messenger = new MockMessenger(OWNER);
    const n = { id: "approval:9ABC", type: "approval", text: "hi" };
    const w = worker([[n], [n], [n]]);
    const poller = new Poller({ config, messenger, fetch: w.fn });

    messenger.failSends = true;
    expect(await poller.pollOnce()).toMatchObject({ delivered: 0, failed: 1 });
    messenger.failSends = false;
    expect(await poller.pollOnce()).toMatchObject({ delivered: 1 });
    expect(w.polls[1].acks).toEqual([{ id: "approval:9ABC", ok: false, error: "Error: mock send failure" }]);
    // The Worker hands the same notice out again (say our ack was lost): confirmed, not re-sent.
    expect(await poller.pollOnce()).toMatchObject({ delivered: 0, failed: 0 });
    expect(w.polls[2].acks).toEqual([{ id: "approval:9ABC", ok: true, message_id: messenger.outbox[0]!.id }]);
    await poller.pollOnce();
    expect(messenger.outbox).toHaveLength(1);
    expect(w.polls[3].acks).toEqual([{ id: "approval:9ABC", ok: true }]);
  });

  test("an unreachable or erroring Worker keeps the acks for the next poll", async () => {
    const messenger = new MockMessenger(OWNER);
    const good = worker([[{ id: "warn:7KXM", type: "expiry_warning", text: "Reminder" }]]);
    const poller = new Poller({ config, messenger, fetch: good.fn });
    await poller.pollOnce();

    const down = worker([], { status: 404 });
    (poller as unknown as { fetchFn: FetchFn }).fetchFn = down.fn;
    await expect(poller.pollOnce()).rejects.toThrow("Worker answered 404 not_found");
    (poller as unknown as { fetchFn: FetchFn }).fetchFn = good.fn;
    await poller.pollOnce();
    expect(good.polls.at(-1).acks).toEqual([{ id: "warn:7KXM", ok: true, message_id: messenger.outbox[0]!.id }]);
  });

  test("the Worker can switch iMessage off: nothing to text, status says so", async () => {
    const messenger = new MockMessenger(OWNER);
    const poller = new Poller({ config, messenger, fetch: worker([], { enabled: false }).fn });
    await poller.pollOnce();
    expect(poller.status().worker_enabled).toBe(false);
    expect(messenger.outbox).toHaveLength(0);
  });
});
