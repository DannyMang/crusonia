// Billing without a database: plans and the credit math, Stripe webhook signatures (real HMAC), event
// interpretation (metadata filter, unpaid sessions, credits from plans.ts), the claw-back math, the 402 gate,
// setup's live-key refusal and idempotency against an in-memory Stripe, and the /api/billing routes' config errors.
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { checkStripeKey, setupStripe } from "../scripts/lib/stripe-setup.ts";
import { creditsEnforcedFor, requireCredits } from "../src/billing/accounts.ts";
import { STRIPE_EVENTS, crusoniaMetadata } from "../src/billing/constants.ts";
import { replayLedger, type LedgerEntry } from "../src/billing/expiry.ts";
import {
  FREE_PLAN,
  FREE_SAMPLE_CREDITS,
  INCLUDED_CREDIT_ROLLOVER_MONTHS,
  OFFERS,
  PACKS,
  PLANS,
  creditsForUsage,
  displayPrice,
  freeSampleCredits,
  offerForPrice,
  packByKey,
  planByKey,
} from "../src/billing/plans.ts";
import { clawbackTarget, interpretStripeEvent, type StripeEvent } from "../src/billing/webhook.ts";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";
import { ApiError } from "../src/lib/errors.ts";
import { signStripe, verifyStripe } from "../src/lib/signatures.ts";
import { STRIPE_API_VERSION, encodeParams, stripeKeyMode } from "../src/providers/stripe.ts";
import { decodeParams, fakeStripe } from "./fake-stripe.ts";

const env = (over: Partial<Env> = {}): Env => ({ PUBLIC_URL: "https://example.test", MCP_TOKEN: "owner-token", ...over });
const call = (path: string, init: RequestInit = {}, e: Env = env()) =>
  worker.fetch(new Request(`https://example.test${path}`, init), e, {} as ExecutionContext);
const nowS = () => Math.floor(Date.now() / 1000);
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

function event(type: string, object: Record<string, unknown>, id = `evt_${crypto.randomUUID().slice(0, 8)}`): StripeEvent {
  return { id, type, created: nowS(), livemode: false, data: { object } };
}
const meta = (extra: Record<string, string> = {}) => ({ app: "crusonia", crusonia_user_id: "user_a", ...extra });

describe("plans", () => {
  test("keys and lookup keys are unique, amounts are positive whole cents", () => {
    expect(new Set(OFFERS.map((o) => o.key)).size).toBe(OFFERS.length);
    expect(new Set(OFFERS.map((o) => o.lookupKey)).size).toBe(OFFERS.length);
    for (const o of OFFERS) {
      expect(Number.isInteger(o.unitAmount) && o.unitAmount > 0).toBe(true);
      expect(o.lookupKey).toMatch(/^crusonia_[a-z0-9_]+$/);
    }
    expect(PLANS.every((p) => p.monthlyCredits > 0)).toBe(true);
    expect(PACKS.every((p) => p.credits > 0)).toBe(true);
  });

  test("the tiers (Free / Pro $20 / Scale $100): 1 credit = $0.01, Pro 2,000 credits, Scale 10,000 credits", () => {
    expect(planByKey("pro")).toMatchObject({ unitAmount: 2_000, monthlyCredits: 2_000, interval: "month", lookupKey: "crusonia_pro_monthly" });
    expect(planByKey("scale")).toMatchObject({ unitAmount: 10_000, monthlyCredits: 10_000, interval: "month", lookupKey: "crusonia_scale_monthly" });
    expect(FREE_PLAN).toMatchObject({ key: "free", unitAmount: 0 });
    expect(INCLUDED_CREDIT_ROLLOVER_MONTHS).toBe(1);
    expect(PACKS.map((p) => [p.unitAmount, p.credits])).toEqual([
      [1_000, 1_000],
      [5_000, 5_000],
      [20_000, 20_000],
    ]);
    expect(displayPrice(planByKey("pro")!)).toBe("$20/mo");
    expect(displayPrice(planByKey("scale")!)).toBe("$100/mo");
    expect(OFFERS.map((o) => o.description).join(" ")).not.toMatch(/hubspot|notion/i);
    expect(displayPrice(packByKey("small")!)).toBe("$10");
  });

  test("usage is debited at 2x provider cost, rounded up to whole credits", () => {
    expect(creditsForUsage(300_000)).toBe(60); // $0.30 of Naive spend -> 60 credits ($0.60)
    expect(creditsForUsage(1_000_000)).toBe(200); // the $1 per-session cap -> 200 credits
    expect(creditsForUsage(1)).toBe(1);
    expect(creditsForUsage(4_999)).toBe(1);
    expect(creditsForUsage(5_001)).toBe(2);
    expect(creditsForUsage(0)).toBe(0);
    expect(creditsForUsage(null)).toBe(0);
    expect(creditsForUsage(-5)).toBe(0);
  });

  test("the free sample is on by default and configurable", () => {
    expect(freeSampleCredits(undefined)).toBe(FREE_SAMPLE_CREDITS);
    expect(FREE_SAMPLE_CREDITS).toBeGreaterThan(0);
    expect(freeSampleCredits("0")).toBe(0);
    expect(freeSampleCredits("500")).toBe(500);
    expect(freeSampleCredits("lots")).toBe(FREE_SAMPLE_CREDITS);
  });

  test("a Stripe price maps to its offer by metadata, which survives a lookup-key move, then by lookup_key", () => {
    const pro = planByKey("pro")!;
    expect(offerForPrice({ lookup_key: null, metadata: { app: "crusonia", crusonia_kind: "subscription", crusonia_key: "pro" } })).toBe(pro);
    expect(offerForPrice({ lookup_key: pro.lookupKey, metadata: {} })).toBe(pro);
    expect(offerForPrice({ lookup_key: "someone_elses_price", metadata: { crusonia_key: "pro" } })).toBeUndefined();
    expect(offerForPrice(null)).toBeUndefined();
  });
});

describe("Stripe webhook signatures", () => {
  const secret = "whsec_test_0123456789abcdef";
  const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
  // Independent of our implementation: Node's HMAC over `${t}.${body}`, keyed by the secret string as given.
  const nodeSignature = (s: string, t: number, b: string) => `t=${t},v1=${createHmac("sha256", s).update(`${t}.${b}`).digest("hex")}`;

  test("a real HMAC signature verifies, and signStripe produces the same header", async () => {
    const t = nowS();
    expect(await verifyStripe({ secret, header: nodeSignature(secret, t, body), body, now: t })).toEqual({ ok: true });
    expect(await signStripe(secret, t, body)).toBe(nodeSignature(secret, t, body));
    // Several v1 entries while a secret rolls, plus a v0 that is ignored.
    const header = `t=${t},v0=deadbeef,v1=${"0".repeat(64)},${nodeSignature(secret, t, body).split(",")[1]}`;
    expect(await verifyStripe({ secret, header, body, now: t })).toEqual({ ok: true });
  });

  test("forged, tampered, stale, unsigned and secret-less requests are refused", async () => {
    const t = nowS();
    const reasons = await Promise.all([
      verifyStripe({ secret, header: nodeSignature("whsec_wrong", t, body), body, now: t }),
      verifyStripe({ secret, header: nodeSignature(secret, t, body), body: body.replace("invoice", "invoicE"), now: t }),
      verifyStripe({ secret, header: nodeSignature(secret, t - 600, body), body, now: t }),
      verifyStripe({ secret, header: undefined, body, now: t }),
      verifyStripe({ secret, header: `t=${t}`, body, now: t }),
      verifyStripe({ secret: "", header: nodeSignature("", t, body), body, now: t }),
    ]);
    expect(reasons.map((r) => r.ok)).toEqual([false, false, false, false, false, false]);
    expect(reasons.map((r) => (r.ok ? "" : r.reason))).toEqual([
      "no matching v1 signature",
      "no matching v1 signature",
      "timestamp outside the tolerance window",
      "missing Stripe-Signature",
      "no v1 signature",
      "no webhook secret configured",
    ]);
  });

  test("route: 503 without a secret even for a validly signed body; 401 when forged; checked before the database", async () => {
    const t = nowS();
    const signed = { method: "POST", body, headers: { "Stripe-Signature": nodeSignature(secret, t, body) } };
    const missing = await call("/webhooks/stripe", signed);
    expect(missing.status).toBe(503);
    expect((await errorOf(missing)).code).toBe("not_configured");

    const forged = await call("/webhooks/stripe", { ...signed, headers: { "Stripe-Signature": nodeSignature("whsec_attacker", t, body) } }, env({ STRIPE_WEBHOOK_SECRET: secret }));
    expect(forged.status).toBe(401);
    expect((await errorOf(forged)).code).toBe("invalid_signature");
    const unsigned = await call("/webhooks/stripe", { method: "POST", body }, env({ STRIPE_WEBHOOK_SECRET: secret }));
    expect(unsigned.status).toBe(401);

    // A valid signature gets past verification and then needs a well-formed event and the database.
    const malformed = await call("/webhooks/stripe", signed, env({ STRIPE_WEBHOOK_SECRET: secret }));
    expect(malformed.status).toBe(400);
    const good = JSON.stringify(event("invoice.paid", { id: "in_1" }));
    const ok = await call("/webhooks/stripe", { method: "POST", body: good, headers: { "Stripe-Signature": nodeSignature(secret, t, good) } }, env({ STRIPE_WEBHOOK_SECRET: secret }));
    expect(ok.status).toBe(503);
    expect((await errorOf(ok)).message).toStartWith("DATABASE_URL is not set");
  });
});

describe("interpretStripeEvent", () => {
  const paidSession = (over: Record<string, unknown> = {}) => ({
    id: "cs_test_1",
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    customer: "cus_1",
    payment_intent: "pi_1",
    amount_total: 1_000,
    currency: "usd",
    metadata: meta({ crusonia_kind: "pack", crusonia_key: "small" }),
    ...over,
  });

  test("metadata filter: objects without app=crusonia are ignored, including ones carrying only a Clerk user id", () => {
    const noApp = interpretStripeEvent(event("checkout.session.completed", paidSession({ metadata: { crusonia_user_id: "user_a", crusonia_kind: "pack", crusonia_key: "small" } })));
    expect(noApp).toEqual({ kind: "ignore", reason: "metadata.app is not crusonia" });
    const clerkKey = interpretStripeEvent(event("checkout.session.completed", paidSession({ metadata: { ["clerk_" + "user_id"]: "user_a" } })));
    expect(clerkKey.kind).toBe("ignore");
    const otherApp = interpretStripeEvent(event("customer.subscription.updated", { id: "sub_1", metadata: { app: "other" } }));
    expect(otherApp.kind).toBe("ignore");
    const invoice = interpretStripeEvent(
      event("invoice.paid", { id: "in_1", billing_reason: "subscription_cycle", parent: { type: "subscription_details", subscription_details: { metadata: {} } } }),
    );
    expect(invoice).toEqual({ kind: "ignore", reason: "subscription metadata.app is not crusonia" });
    expect(interpretStripeEvent(event("checkout.session.completed", paidSession({ metadata: { app: "crusonia" } }))).kind).toBe("ignore");
  });

  test("an unpaid Checkout Session is not credited; it waits for async_payment_succeeded", () => {
    for (const payment_status of ["unpaid", "no_payment_required"]) {
      expect(interpretStripeEvent(event("checkout.session.completed", paidSession({ payment_status })))).toMatchObject({ kind: "checkout_pending", owner: "user_a" });
    }
    const later = interpretStripeEvent(event("checkout.session.async_payment_succeeded", paidSession()));
    expect(later).toMatchObject({ kind: "credit_pack", session: "cs_test_1", paymentIntent: "pi_1" });
  });

  test("credits come from plans.ts, never from the amount paid", () => {
    const action = interpretStripeEvent(event("checkout.session.completed", paidSession({ amount_total: 1, metadata: meta({ crusonia_kind: "pack", crusonia_key: "large" }) })));
    expect(action.kind).toBe("credit_pack");
    if (action.kind !== "credit_pack") return;
    expect(action.pack.credits).toBe(20_000);
    expect(action.amountTotal).toBe(1);
    const unknown = interpretStripeEvent(event("checkout.session.completed", paidSession({ metadata: meta({ crusonia_kind: "pack", crusonia_key: "huge" }) })));
    expect(unknown.kind).toBe("ignore");
  });

  test("subscription checkouts only link the subscription; invoices grant on create and cycle only", () => {
    expect(interpretStripeEvent(event("checkout.session.completed", { ...paidSession(), mode: "subscription", subscription: "sub_1" }))).toMatchObject({
      kind: "link_subscription",
      subscription: "sub_1",
    });
    const invoice = (billing_reason: string) =>
      interpretStripeEvent(
        event("invoice.paid", {
          id: "in_1",
          customer: "cus_1",
          billing_reason,
          parent: { type: "subscription_details", subscription_details: { subscription: "sub_1", metadata: meta() } },
          lines: {
            data: [
              { id: "il_p", parent: { type: "subscription_item_details", subscription_item_details: { proration: true } }, pricing: { price_details: { price: "price_old" } } },
              {
                id: "il_1",
                parent: { type: "subscription_item_details", subscription_item_details: { proration: false } },
                pricing: { price_details: { price: "price_pro" } },
                period: { start: 1_800_000_000, end: 1_802_592_000 },
              },
            ],
          },
        }),
      );
    expect(invoice("subscription_create")).toMatchObject({
      kind: "invoice_paid",
      invoice: "in_1",
      priceId: "price_pro",
      owner: "user_a",
      subscription: "sub_1",
      periodEnd: 1_802_592_000,
    });
    expect(invoice("subscription_cycle")).toMatchObject({ kind: "invoice_paid" });
    expect(invoice("subscription_update")).toEqual({ kind: "ignore", reason: "billing_reason subscription_update does not grant credits" });
    expect(interpretStripeEvent(event("invoice.paid", { id: "in_2", parent: null })).kind).toBe("ignore");
  });

  test("subscription events read the plan from the price and the period from the item (basil+)", () => {
    const action = interpretStripeEvent(
      event("customer.subscription.updated", {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        cancel_at_period_end: true,
        metadata: meta(),
        items: { data: [{ current_period_end: 1_900_000_000, price: { lookup_key: null, metadata: { app: "crusonia", crusonia_kind: "subscription", crusonia_key: "pro" } } }] },
      }),
    );
    expect(action).toMatchObject({ kind: "subscription", plan: "pro", status: "active", currentPeriodEnd: 1_900_000_000, cancelAtPeriodEnd: true, deleted: false });
    expect(interpretStripeEvent(event("customer.subscription.deleted", { id: "sub_1", metadata: meta(), status: "canceled" }))).toMatchObject({ deleted: true });
  });

  test("refunds and unhandled types", () => {
    expect(interpretStripeEvent(event("charge.refunded", { id: "ch_1", payment_intent: "pi_1", customer: "cus_1", amount: 1000, amount_refunded: 400, metadata: {} }))).toEqual({
      kind: "refund",
      charge: "ch_1",
      customer: "cus_1",
      paymentIntent: "pi_1",
      amount: 1000,
      amountRefunded: 400,
      oursByMetadata: false,
    });
    expect(interpretStripeEvent(event("payment_intent.created", {}))).toEqual({ kind: "ignore", reason: "event type payment_intent.created is not handled" });
  });

  test("every subscribed event type is interpreted (none falls through to 'not handled')", () => {
    for (const type of STRIPE_EVENTS) {
      const action = interpretStripeEvent(event(type, { metadata: meta() }));
      expect(action.kind === "ignore" ? action.reason : "").not.toStartWith(`event type ${type}`);
    }
  });
});

describe("included credits roll over for one month, then the unused rest expires", () => {
  const day = 86_400_000;
  const t0 = Date.UTC(2026, 10, 1);
  let id = 0;
  const row = (amount: number, reason: string, at: number, over: Partial<LedgerEntry> = {}): LedgerEntry => ({
    id: ++id,
    amount,
    reason,
    source: `${reason}:${id}`,
    purchase_source: null,
    expires_at: null,
    created_at: new Date(at),
    ...over,
  });
  const plan = (credits: number, at: number, expiresAt: number, source = `invoice:${id + 1}`) => row(credits, "plan", at, { expires_at: new Date(expiresAt), source });

  test("the unused rest of a plan grant expires at its expiry; nothing before", () => {
    const rows = [plan(2_000, t0, t0 + 60 * day, "invoice:a"), row(-500, "usage", t0 + 10 * day)];
    expect(replayLedger(rows, new Date(t0 + 59 * day))).toEqual({
      due: [],
      upcoming: [{ source: "invoice:a", credits: 1_500, expiresAt: new Date(t0 + 60 * day) }],
    });
    expect(replayLedger(rows, new Date(t0 + 61 * day)).due).toEqual([{ source: "invoice:a", credits: 1_500, expiresAt: new Date(t0 + 60 * day) }]);
  });

  test("usage spends expiring credits first, soonest expiry first, then packs and the free sample", () => {
    const rows = [
      row(1_000, "pack", t0, { source: "checkout:pack" }),
      plan(2_000, t0, t0 + 60 * day, "invoice:may"),
      plan(2_000, t0 + 30 * day, t0 + 90 * day, "invoice:june"),
      row(-2_500, "usage", t0 + 40 * day),
    ];
    const at61 = replayLedger(rows, new Date(t0 + 61 * day));
    expect(at61.due).toEqual([]); // May's 2,000 were spent first
    expect(at61.upcoming).toEqual([{ source: "invoice:june", credits: 1_500, expiresAt: new Date(t0 + 90 * day) }]);
  });

  test("spending after the expiry cannot use expired credits; already written-off grants are not due again", () => {
    const rows = [plan(2_000, t0, t0 + 60 * day, "invoice:a"), row(-300, "usage", t0 + 70 * day)];
    expect(replayLedger(rows, new Date(t0 + 71 * day)).due).toEqual([{ source: "invoice:a", credits: 2_000, expiresAt: new Date(t0 + 60 * day) }]);
    const written = [...rows, row(-2_000, "expire", t0 + 60 * day + 60_000, { source: "expire:invoice:a", purchase_source: "invoice:a" })];
    expect(replayLedger(written, new Date(t0 + 71 * day)).due).toEqual([]);
  });

  test("a negative balance is paid off by the next grant before it can roll over", () => {
    const rows = [row(-300, "usage", t0), plan(2_000, t0 + day, t0 + 60 * day, "invoice:a")];
    expect(replayLedger(rows, new Date(t0 + 61 * day)).due).toEqual([{ source: "invoice:a", credits: 1_700, expiresAt: new Date(t0 + 60 * day) }]);
  });

  test("a refund spends its own purchase first", () => {
    const rows = [
      plan(2_000, t0, t0 + 60 * day, "invoice:a"),
      row(1_000, "pack", t0 + day, { source: "checkout:p" }),
      row(-1_000, "refund", t0 + 2 * day, { purchase_source: "checkout:p" }),
    ];
    expect(replayLedger(rows, new Date(t0 + 61 * day)).due).toEqual([{ source: "invoice:a", credits: 2_000, expiresAt: new Date(t0 + 60 * day) }]);
  });
});

describe("claw-back math", () => {
  test("proportional to the cumulative refund, full at 100%, never more than granted", () => {
    expect(clawbackTarget(5_000, 5_000, 5_000)).toBe(5_000);
    expect(clawbackTarget(5_000, 5_000, 2_500)).toBe(2_500);
    expect(clawbackTarget(9_900, 9_900, 1)).toBe(1);
    expect(clawbackTarget(1_000, 1_000, 0)).toBe(0);
    expect(clawbackTarget(1_000, 1_000, 99_999)).toBe(1_000);
    expect(clawbackTarget(1_000, 0, 10)).toBe(1_000);
  });
});

describe("enforcement (402 insufficient_credits)", () => {
  const apiKey = { kind: "api_key" as const, keyId: "key_1", name: "agent", workspaceId: "ws_a" };
  const clerk = { kind: "clerk" as const, userId: "user_a", sessionId: null };
  const failure = async (p: Promise<unknown>) => {
    const e = await p.then(() => undefined, (err) => err);
    return e instanceof ApiError ? `${e.status} ${e.code}` : e;
  };

  test("the owner workspace: off by default (never reads the balance); BILLING_ENFORCED turns it on", async () => {
    let reads = 0;
    const balance = async () => (reads++, -100);
    await requireCredits(env(), clerk, "ws_owner", { balance });
    await requireCredits(env({ BILLING_ENFORCED: "false" }), apiKey, "ws_owner", { balance });
    expect(reads).toBe(0);
    expect(await failure(requireCredits(env({ BILLING_ENFORCED: "true" }), clerk, "ws_owner", { balance }))).toBe("402 insufficient_credits");
  });

  test("every other workspace is always enforced, whatever BILLING_ENFORCED says", async () => {
    const asked: string[] = [];
    const at = (n: number) => async (ws: string) => (asked.push(ws), n);
    for (const e of [env(), env({ BILLING_ENFORCED: "false" }), env({ BILLING_ENFORCED: "true" })]) {
      expect(await failure(requireCredits(e, clerk, "ws_a", { balance: at(0) }))).toBe("402 insufficient_credits");
      expect(await failure(requireCredits(e, apiKey, "ws_a", { balance: at(-5) }))).toBe("402 insufficient_credits");
      expect(await failure(requireCredits(e, clerk, "ws_a", { balance: at(1) }))).toBeUndefined();
    }
    expect(asked).toEqual(Array(9).fill("ws_a"));
    expect(creditsEnforcedFor(env(), "ws_a")).toBe(true);
    expect(creditsEnforcedFor(env(), "ws_owner")).toBe(false);
    expect(creditsEnforcedFor(env({ BILLING_ENFORCED: "true" }), "ws_owner")).toBe(true);
  });

  test("on: balance <= 0 is refused, positive passes, MCP_TOKEN bypasses", async () => {
    const on = env({ BILLING_ENFORCED: "true" });
    const asked: string[] = [];
    const at = (n: number) => async (ws: string) => (asked.push(ws), n);
    expect(await failure(requireCredits(on, clerk, "ws_owner", { balance: at(0) }))).toBe("402 insufficient_credits");
    expect(await failure(requireCredits(on, apiKey, "ws_owner", { balance: at(-5) }))).toBe("402 insufficient_credits");
    expect(await failure(requireCredits(on, clerk, "ws_owner", { balance: at(1) }))).toBeUndefined();
    expect(await failure(requireCredits(on, { kind: "owner_token" }, "ws_owner", { balance: at(-1_000) }))).toBeUndefined();
    expect(asked).toEqual(["ws_owner", "ws_owner", "ws_owner"]);
    const e = (await requireCredits(on, clerk, "ws_owner", { balance: at(0) }).catch((err) => err)) as ApiError;
    expect(e.details).toMatchObject({ balance: 0, billing_url: "https://example.test/app/settings/billing" });
  });

  test("routes: with enforcement on, MCP_TOKEN still gets past the gate (to the missing database)", async () => {
    const on = env({ BILLING_ENFORCED: "true", NAIVE_API_KEY: "nv", NAIVE_AGENT_ID: "agt" });
    const post = (path: string, body: unknown) =>
      call(path, { method: "POST", headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json" }, body: JSON.stringify(body) }, on);
    for (const [path, body] of [
      ["/api/onboarding/propose", { url: "acme.com" }],
      ["/api/leads/find", { count: 5 }],
      ["/api/workflows/research", { lead_ids: ["lead_1"] }],
    ] as const) {
      const res = await post(path, body);
      expect(res.status).toBe(503);
      expect((await errorOf(res)).message).toStartWith("DATABASE_URL is not set");
    }
  });
});

describe("Stripe metadata and encoding", () => {
  test("our metadata always carries app and crusonia_workspace_id, never a Clerk user id key", () => {
    const m = crusoniaMetadata("ws_a", { crusonia_kind: "pack" });
    expect(m).toEqual({ app: "crusonia", crusonia_workspace_id: "ws_a", crusonia_kind: "pack" });
    expect(Object.keys(m)).not.toContain("clerk_" + "user_id");
  });

  test("no source file uses the clerk_user_id metadata key", () => {
    // As an object key or a quoted string, i.e. metadata. (workspace_members.clerk_user_id, a column, is fine.)
    const forbidden = new RegExp(`(["'\`]clerk_${"user_id"}["'\`]|\\bclerk_${"user_id"}\\s*:|\\[clerk_${"user_id"}\\])`);
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
    const root = join(import.meta.dir, "..");
    const files = [...walk(join(root, "src")), ...walk(join(root, "scripts"))].filter((f) => /\.(ts|sql|md)$/.test(f));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) expect({ f, hit: forbidden.test(readFileSync(f, "utf8")) }).toEqual({ f, hit: false });
    expect(forbidden.test(`metadata: { clerk_${"user_id"}: "x" }`)).toBe(true);
    expect(forbidden.test(`where clerk_${"user_id"} = $1`)).toBe(false);
  });

  test("form encoding: nested objects, indexed arrays, booleans, null unsets", () => {
    const body = encodeParams({ mode: "payment", line_items: [{ price: "p", quantity: 1 }], metadata: { app: "crusonia" }, flag: true, gone: null, skip: undefined, list: ["a", "b"] });
    expect(decodeParams(body)).toEqual({ mode: "payment", line_items: [{ price: "p", quantity: "1" }], metadata: { app: "crusonia" }, flag: "true", gone: "", list: ["a", "b"] });
    expect(body).not.toContain("skip");
  });

  test("key mode from the prefix", () => {
    expect(stripeKeyMode("sk_test_abc123")).toBe("test");
    expect(stripeKeyMode("rk_live_abc123")).toBe("live");
    expect(stripeKeyMode("sk_org_live_abc123")).toBe("live");
    expect(stripeKeyMode("rk_scope_test_abc123")).toBe("test");
    expect(stripeKeyMode("sk_abc123")).toBeUndefined();
    expect(stripeKeyMode("pk_test_abc123")).toBeUndefined();
    expect(stripeKeyMode(undefined)).toBeUndefined();
  });
});

describe("setup --stripe", () => {
  test("refuses live keys without --live, test keys with --live, and non-keys, before any request", async () => {
    expect(() => checkStripeKey("sk_live_abc123", false)).toThrow(/Refusing a live Stripe key without --live/);
    expect(() => checkStripeKey("rk_live_abc123", false)).toThrow(/Refusing a live Stripe key without --live/);
    expect(() => checkStripeKey("sk_org_live_abc123", false)).toThrow(/Refusing a live Stripe key without --live/);
    expect(checkStripeKey("rk_live_abc123", true)).toBe("live");
    expect(checkStripeKey("sk_test_abc123", false)).toBe("test");
    expect(() => checkStripeKey("sk_test_abc123", true)).toThrow(/test key/);
    expect(() => checkStripeKey("pk_live_abc123", false)).toThrow(/not a Stripe secret/);
    expect(() => checkStripeKey(undefined, false)).toThrow(/not set/);

    const stripe = fakeStripe();
    const run = setupStripe({ key: "sk_live_abc123", baseUrl: "https://example.test", secretPath: () => "/nonexistent", fetchFn: stripe.fetch });
    await expect(run).rejects.toThrow(/Refusing a live Stripe key/);
    expect(stripe.requests).toHaveLength(0);
  });

  test("idempotent: the second run creates nothing; the secret is written once (mode 600) and never logged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crusonia-stripe-"));
    try {
      const stripe = fakeStripe();
      const lines: string[] = [];
      const opts = {
        key: "sk_test_abc123",
        baseUrl: "https://example.test",
        secretPath: (mode: string) => join(dir, `.dev.vars.stripe.${mode}`),
        fetchFn: stripe.fetch,
        log: (l: string) => lines.push(l),
      };
      const first = await setupStripe({ ...opts, verifyCheckout: true });
      expect(first).toMatchObject({ mode: "test", portal: "created", webhook: "created", secretWritten: true, checkout: "ok" });
      expect(first.offers.every((o) => o.product === "created" && o.price === "created")).toBe(true);
      expect(stripe.products.size).toBe(OFFERS.length);
      expect(stripe.prices.size).toBe(OFFERS.length);
      expect(stripe.requests.every((r) => r.version === STRIPE_API_VERSION)).toBe(true);

      // Every price carries its lookup key and our metadata; the webhook has exactly our events and the pinned version.
      for (const o of OFFERS) {
        const price = [...stripe.prices.values()].find((p) => p.lookup_key === o.lookupKey)!;
        expect(price.metadata).toEqual({ app: "crusonia", crusonia_kind: o.kind, crusonia_key: o.key });
        expect(price.unit_amount).toBe(o.unitAmount);
      }
      const [endpoint] = [...stripe.endpoints.values()];
      expect(endpoint).toMatchObject({ url: "https://example.test/webhooks/stripe", api_version: STRIPE_API_VERSION, metadata: { app: "crusonia" } });
      expect(endpoint!.enabled_events).toEqual([...STRIPE_EVENTS]);
      const [portal] = [...stripe.portals.values()];
      expect(portal).toMatchObject({ metadata: { app: "crusonia" }, default_return_url: "https://example.test/app/settings/billing" });
      expect(portal!.features).toMatchObject({
        invoice_history: { enabled: "true" },
        payment_method_update: { enabled: "true" },
        subscription_cancel: { enabled: "true", mode: "at_period_end" },
        subscription_update: { enabled: "true", default_allowed_updates: ["price"], proration_behavior: "none" },
      });
      // Every plan can be switched to, each with its current price.
      const switchable = portal!.features.subscription_update.products as { product: string; prices: string[] }[];
      expect(switchable.map((p) => stripe.prices.get(p.prices[0]!)!.lookup_key)).toEqual(PLANS.map((p) => p.lookupKey));
      expect([...stripe.sessions.values()][0]).toMatchObject({ status: "expired", metadata: { app: "crusonia", crusonia_workspace_id: "setup-check" } });

      const secretFile = join(dir, ".dev.vars.stripe.test");
      expect(readFileSync(secretFile, "utf8")).toContain(`STRIPE_WEBHOOK_SECRET=${stripe.secrets[0]}\n`);
      expect(statSync(secretFile).mode & 0o777).toBe(0o600);
      const output = [...lines, ...first.notes].join("\n");
      expect(output).not.toContain(stripe.secrets[0]!);
      expect(output).not.toMatch(/(prod|price|bpc|we|cs_test|cus)_fake\d/);

      const before = stripe.requests.length;
      const second = await setupStripe(opts);
      expect(second).toMatchObject({ portal: "updated", webhook: "updated", secretWritten: false, notes: [] });
      expect(second.offers.every((o) => o.product === "unchanged" && o.price === "unchanged")).toBe(true);
      const creates = stripe.requests.slice(before).filter((r) => r.method === "POST" && /^\/v1\/(products|prices|webhook_endpoints|billing_portal\/configurations)$/.test(r.path));
      expect(creates).toEqual([]);
      expect(stripe.products.size).toBe(OFFERS.length);
      expect(stripe.endpoints.size).toBe(1);
      expect(stripe.secrets).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a changed amount gets a new price with the lookup key; the old price is archived; rotation replaces the endpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crusonia-stripe-"));
    try {
      const stripe = fakeStripe();
      const opts = { key: "sk_test_abc123", baseUrl: "https://example.test", secretPath: (m: string) => join(dir, `.dev.vars.stripe.${m}`), fetchFn: stripe.fetch };
      await setupStripe(opts);
      const pro = planByKey("pro")!;
      const old = [...stripe.prices.values()].find((p) => p.lookup_key === pro.lookupKey)!;
      old.unit_amount = 4_900; // as if plans.ts said $49 when it was created

      const again = await setupStripe({ ...opts, rotateWebhookSecret: true });
      expect(again.offers.find((o) => o.key === "pro")!.price).toStartWith("replaced");
      const current = [...stripe.prices.values()].find((p) => p.lookup_key === pro.lookupKey)!;
      expect(current.id).not.toBe(old.id);
      expect(current.unit_amount).toBe(pro.unitAmount);
      expect(old).toMatchObject({ active: false, lookup_key: null, metadata: { crusonia_key: "pro" } });
      expect(again.webhook).toBe("rotated");
      expect(stripe.endpoints.size).toBe(1);
      expect(readFileSync(join(dir, ".dev.vars.stripe.test"), "utf8")).toContain(stripe.secrets[1]!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an existing endpoint without a local secret is kept, with a note (no surprise rotation)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crusonia-stripe-"));
    try {
      const stripe = fakeStripe();
      const secretPath = (m: string) => join(dir, `.dev.vars.stripe.${m}`);
      await setupStripe({ key: "sk_test_abc123", baseUrl: "https://example.test", secretPath, fetchFn: stripe.fetch });
      rmSync(secretPath("test"));
      const again = await setupStripe({ key: "sk_test_abc123", baseUrl: "https://example.test", secretPath, fetchFn: stripe.fetch });
      expect(again.webhook).toBe("updated");
      expect(again.notes.join(" ")).toContain("--rotate-webhook-secret");
      expect(existsSync(secretPath("test"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("/api/billing without a database", () => {
  const auth = { Authorization: "Bearer owner-token" };
  const post = (path: string, body: unknown, e = env()) =>
    call(path, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) }, e);

  test("needs auth", async () => {
    for (const path of ["/api/billing", "/api/billing/checkout", "/api/billing/portal"]) {
      expect((await call(path, path === "/api/billing" ? {} : { method: "POST" })).status).toBe(401);
    }
  });

  test("checkout validates the body and the offer before needing Stripe, then names the missing key", async () => {
    expect((await errorOf(await post("/api/billing/checkout", {}))).code).toBe("invalid_request");
    expect((await errorOf(await post("/api/billing/checkout", { plan: "pro", pack: "small" }))).code).toBe("invalid_request");
    const unknown = await post("/api/billing/checkout", { plan: "enterprise" });
    expect(unknown.status).toBe(400);
    expect((await errorOf(unknown)).code).toBe("unknown_offer");
    const noKey = await post("/api/billing/checkout", { pack: "small" });
    expect(noKey.status).toBe(503);
    expect((await errorOf(noKey)).message).toContain("STRIPE_SECRET_KEY is not set");
    const portal = await post("/api/billing/portal", {});
    expect(portal.status).toBe(503);
    const withKey = await post("/api/billing/checkout", { pack: "small" }, env({ STRIPE_SECRET_KEY: "sk_test_abc123", BILLING_TEST_MODE_OK: "true" }));
    expect((await errorOf(withKey)).message).toStartWith("DATABASE_URL is not set");
  });

  test("/api/status reports billing config without secrets; get_status lists Stripe", async () => {
    const res = await call("/api/status", { headers: auth }, env({ STRIPE_SECRET_KEY: "sk_test_abc123", BILLING_ENFORCED: "true" }));
    const body = (await res.json()) as { billing: unknown; providers: Record<string, { configured: boolean; missing?: string[] }> };
    expect(body.billing).toEqual({ configured: true, webhook_configured: false, mode: "test", payments_live: false, enforced: true });
    expect(body.providers.stripe).toMatchObject({ configured: false, missing: ["STRIPE_WEBHOOK_SECRET"] });
    expect(JSON.stringify(body)).not.toContain("sk_test_abc123");
  });
});
