// The supervisor around the live connection, with a fake Spectrum: init failures and ended streams are
// retried with backoff; sends only work while connected; stop() ends everything.
import { describe, expect, test } from "bun:test";
import { setSilent } from "../src/log.ts";
import { backoffDelay, NotConnectedError, SupervisedMessenger, type Connect, type Connection, type InboundMessage } from "../src/messenger.ts";

setSilent(true);

const msg = (id: string): InboundMessage => ({
  id,
  sender: "+15550001111",
  text: "status",
  contentType: "text",
  isDirect: true,
  receivedAt: new Date(),
  reply: async () => {},
});

/** A message stream that yields `items`, then either ends or stays open until stop(). */
function stream(items: InboundMessage[], stayOpen: boolean) {
  let close: () => void = () => {};
  const closed = new Promise<void>((r) => (close = r));
  async function* gen() {
    for (const i of items) yield i;
    if (stayOpen) await closed;
  }
  return { iterable: gen(), close };
}

const waitFor = async (cond: () => boolean, ms = 2_000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("SupervisedMessenger", () => {
  test("reconnects after an init failure and after the stream ends, then delivers messages in order", async () => {
    const sent: string[] = [];
    let attempts = 0;
    let open: { close: () => void } | undefined;
    const connect: Connect = async ({ onHeartbeat }) => {
      attempts++;
      if (attempts === 1) throw new Error("UNAVAILABLE: connection refused");
      const s = attempts === 2 ? stream([msg("a")], false) : stream([msg("b"), msg("c")], true);
      if (attempts === 3) open = s;
      onHeartbeat();
      const conn: Connection = {
        messages: s.iterable,
        openDm: async () => ({ send: async (t) => (sent.push(t), `out-${sent.length}`) }),
        stop: async () => s.close(),
      };
      return conn;
    };
    const m = new SupervisedMessenger({ connect, ownerPhone: "+15550001111", backoff: { initialMs: 5, maxMs: 20, stableMs: 60_000 } });
    const got: string[] = [];
    m.start(async (x) => void got.push(x.id));
    await waitFor(() => got.length === 3);
    expect(got).toEqual(["a", "b", "c"]);
    expect(attempts).toBe(3);
    expect(m.status()).toMatchObject({ state: "connected", reconnects: 2, mode: "live" });
    expect(m.status().last_heartbeat_at).not.toBeNull();

    expect(await m.sendToOwner("hello")).toEqual({ messageId: "out-1" });
    expect(sent).toEqual(["hello"]);

    await m.stop();
    expect(m.status().state).toBe("stopped");
    expect(open).toBeDefined();
    await expect(m.sendToOwner("late")).rejects.toBeInstanceOf(NotConnectedError);
  });

  test("sendToOwner refuses while not connected", async () => {
    const connect: Connect = () => new Promise(() => {}); // never connects
    const m = new SupervisedMessenger({ connect, ownerPhone: "+15550001111" });
    m.start(async () => {});
    await expect(m.sendToOwner("x")).rejects.toBeInstanceOf(NotConnectedError);
    expect(m.status().state).toBe("connecting");
  });

  test("a failed DM send drops the cached conversation so the next send reopens it", async () => {
    let opens = 0;
    let fail = true;
    const s = stream([], true);
    const connect: Connect = async () => ({
      messages: s.iterable,
      openDm: async () => {
        opens++;
        return {
          send: async () => {
            if (fail) throw new Error("Target not allowed for this project");
            return undefined;
          },
        };
      },
      stop: async () => s.close(),
    });
    const m = new SupervisedMessenger({ connect, ownerPhone: "+15550001111" });
    m.start(async () => {});
    await waitFor(() => m.status().state === "connected");
    await expect(m.sendToOwner("x")).rejects.toThrow("Target not allowed");
    fail = false;
    await m.sendToOwner("y");
    expect(opens).toBe(2);
    await m.stop();
  });

  test("backoff doubles from the initial delay up to the cap, with 50-100% jitter", () => {
    const opts = { initialMs: 1_000, maxMs: 60_000, stableMs: 60_000 };
    expect([0, 1, 2, 3, 10].map((a) => backoffDelay(a, opts, () => 1))).toEqual([1_000, 2_000, 4_000, 8_000, 60_000]);
    expect(backoffDelay(0, opts, () => 0)).toBe(500);
  });
});
