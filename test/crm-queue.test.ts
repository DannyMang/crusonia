// The CRM sync queue's retry policy and drain loop (src/services/crm-queue.ts) against an in-memory store.
import { describe, expect, test } from "bun:test";
import { ProviderError, RateLimitError } from "../src/providers/http.ts";
import { backoffMs, classifyError, drain, MAX_ATTEMPTS, type HandleResult, type QueueItem, type QueueStore } from "../src/services/crm-queue.ts";

type Row = QueueItem & { status: "pending" | "failed" | "deleted"; next: number; last_error: string | null; locked: boolean };

function memoryStore(now: () => number) {
  const rows = new Map<string, Row>();
  const log: string[] = [];
  const store: QueueStore = {
    async claim() {
      return [];
    },
    async complete(item, result) {
      const r = rows.get(item.id)!;
      log.push(`complete ${item.id}${result.more ? " more" : ""}`);
      if (result.more) Object.assign(r, { locked: false, attempts: 0, next: now(), payload: result.payload ?? r.payload });
      else if (r.version === item.version) r.status = "deleted";
      else Object.assign(r, { locked: false, attempts: 0 });
    },
    async retry(item, error, at) {
      log.push(`retry ${item.id}`);
      Object.assign(rows.get(item.id)!, { attempts: item.attempts + 1, last_error: error, next: at.getTime(), locked: false });
    },
    async giveUp(item, error) {
      log.push(`giveUp ${item.id}`);
      Object.assign(rows.get(item.id)!, { attempts: item.attempts + 1, last_error: error, status: "failed", locked: false });
    },
    async defer(item, at) {
      log.push(`defer ${item.id}`);
      Object.assign(rows.get(item.id)!, { next: at.getTime(), locked: false });
    },
    async release(items) {
      for (const i of items) {
        log.push(`release ${i.id}`);
        rows.get(i.id)!.locked = false;
      }
    },
  };
  const add = (id: string, over: Partial<Row> = {}): Row => {
    const row: Row = { id, target: "hubspot", entity: "lead", lead_id: `lead_${id}`, reason: "lead_scored", payload: {}, attempts: 0, version: 1, status: "pending", next: now(), last_error: null, locked: true, ...over };
    rows.set(id, row);
    return row;
  };
  return { store, rows, add, log };
}

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe("backoff", () => {
  test("doubles from one minute, capped at six hours, with +-20% jitter", () => {
    const mid = () => 0.5;
    expect(backoffMs(1, mid)).toBe(60_000);
    expect(backoffMs(2, mid)).toBe(120_000);
    expect(backoffMs(3, mid)).toBe(240_000);
    expect(backoffMs(7, mid)).toBe(64 * 60_000);
    expect(backoffMs(20, mid)).toBe(6 * 3600_000);
    expect(backoffMs(1, () => 0)).toBe(48_000);
    expect(backoffMs(1, () => 0.999999)).toBeCloseTo(72_000, -2);
  });
});

describe("error classification", () => {
  test("data errors are permanent; outages, auth and missing scopes retry and stop the target", () => {
    expect(classifyError(new ProviderError("hubspot", "bad property", 400, false))).toMatchObject({ retry: false, stopTarget: false });
    expect(classifyError(new ProviderError("notion", "gone", 404, false))).toMatchObject({ retry: false, stopTarget: false });
    expect(classifyError(new ProviderError("hubspot", "down", 503, true))).toMatchObject({ retry: true, stopTarget: true });
    expect(classifyError(new ProviderError("hubspot", "no response", undefined, true))).toMatchObject({ retry: true, stopTarget: true });
    expect(classifyError(new ProviderError("hubspot", "expired token", 401, false))).toMatchObject({ retry: true, stopTarget: true });
    const scope = new ProviderError("hubspot", "forbidden", 403, false, {
      category: "MISSING_SCOPES",
      errors: [{ context: { requiredGranularScopes: ["crm.objects.companies.write"] } }],
    });
    const plan = classifyError(scope);
    expect(plan).toMatchObject({ retry: true, stopTarget: true });
    expect(plan.message).toContain("crm.objects.companies.write");
    expect(classifyError(new Error("relation does not exist"))).toMatchObject({ retry: true, stopTarget: false });
  });
});

describe("drain", () => {
  test("success completes every item; warnings are collected once", async () => {
    const c = clock();
    const { store, rows, add } = memoryStore(c.now);
    const items = [add("1"), add("2")];
    const report = await drain(store, items, async () => ({ warnings: ["companies not synced"] }), { now: c.now });
    expect(report).toMatchObject({ claimed: 2, done: 2, failed: 0, warnings: ["companies not synced"] });
    expect([...rows.values()].every((r) => r.status === "deleted")).toBe(true);
  });

  test("a change queued while the item ran keeps the row due (version moved)", async () => {
    const c = clock();
    const { store, rows, add } = memoryStore(c.now);
    const item = add("1");
    await drain(store, [{ ...item }], async () => {
      rows.get("1")!.version = 2; // an event re-queued it mid-sync
      return {};
    });
    expect(rows.get("1")!.status).toBe("pending");
  });

  test("`more` keeps the item due now with its new payload (import pages, capped notes)", async () => {
    const c = clock();
    const { store, rows, add } = memoryStore(c.now);
    const item = add("1", { entity: "import", lead_id: null, payload: { pages: 0 } });
    await drain(store, [item], async (): Promise<HandleResult> => ({ more: true, payload: { pages: 1 } }));
    expect(rows.get("1")).toMatchObject({ status: "pending", payload: { pages: 1 }, next: c.now() });
  });

  test("a transient error retries with backoff; other items still run", async () => {
    const c = clock();
    const { store, rows, add } = memoryStore(c.now);
    const items = [add("1"), add("2")];
    const report = await drain(
      store,
      items,
      async (i) => {
        if (i.id === "1") throw new Error("database hiccup");
        return {};
      },
      { now: c.now, random: () => 0.5 },
    );
    expect(report).toMatchObject({ retried: 1, done: 1 });
    expect(rows.get("1")).toMatchObject({ status: "pending", attempts: 1, next: c.now() + 60_000, last_error: "database hiccup" });
    expect(rows.get("2")!.status).toBe("deleted");
  });

  test("backoff grows per attempt and the item is given up after MAX_ATTEMPTS", async () => {
    const c = clock();
    const { store, rows, add } = memoryStore(c.now);
    add("1");
    const delays: number[] = [];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const row = rows.get("1")!;
      const before = c.now();
      await drain(store, [{ ...row }], async () => {
        throw new Error("still broken");
      }, { now: c.now, random: () => 0.5 });
      if (rows.get("1")!.status === "pending") delays.push(rows.get("1")!.next - before);
    }
    expect(delays).toEqual([1, 2, 4, 8, 16, 32, 64].map((m) => m * 60_000));
    expect(rows.get("1")).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
  });

  test("a permanent error gives up at once and continues with the next item", async () => {
    const c = clock();
    const { store, rows, add } = memoryStore(c.now);
    const report = await drain(store, [add("1"), add("2")], async (i) => {
      if (i.id === "1") throw new ProviderError("hubspot", "Property values were not valid", 400, false);
      return {};
    });
    expect(report).toMatchObject({ failed: 1, done: 1 });
    expect(rows.get("1")!.status).toBe("failed");
    expect(rows.get("2")!.status).toBe("deleted");
  });

  test("429: deferred to Retry-After without counting an attempt; the rest of the batch is released untouched", async () => {
    const c = clock();
    const { store, rows, add, log } = memoryStore(c.now);
    const items = [add("1"), add("2", { attempts: 3 }), add("3")];
    let calls = 0;
    const report = await drain(
      store,
      items,
      async (i) => {
        calls++;
        if (i.id === "2") throw new RateLimitError("hubspot", "rate limited", 10_000);
        return {};
      },
      { now: c.now },
    );
    expect(calls).toBe(2);
    expect(report).toMatchObject({ done: 1, deferred: 1, released: 1, retried: 0, failed: 0 });
    expect(rows.get("2")).toMatchObject({ status: "pending", attempts: 3, next: c.now() + 10_000, locked: false });
    expect(rows.get("3")).toMatchObject({ status: "pending", attempts: 0, locked: false });
    expect(report.rate_limited_until).toBe(new Date(c.now() + 10_000).toISOString());
    expect(log).toEqual(["complete 1", "defer 2", "release 3"]);
  });

  test("an outage stops the target for this run instead of failing every item", async () => {
    const c = clock();
    const { store, rows, add } = memoryStore(c.now);
    let calls = 0;
    const report = await drain(store, [add("1"), add("2"), add("3")], async () => {
      calls++;
      throw new ProviderError("notion", "notion POST /v1/pages failed (502)", 502, true);
    }, { now: c.now });
    expect(calls).toBe(1);
    expect(report).toMatchObject({ retried: 1, released: 2, stopped: "notion POST /v1/pages failed (502)" });
    expect(rows.get("2")!.attempts).toBe(0);
  });
});
