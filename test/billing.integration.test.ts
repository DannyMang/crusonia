// Billing against a real Postgres (a Neon dev branch, never production), with Stripe and Naive faked at fetch.
// Skipped unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=<dev branch url> bun test test/billing.integration.test.ts
// Every owner, event and session id carries this run's id; the rows are deleted afterwards.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setupStripe } from "../scripts/lib/stripe-setup.ts";
import { addLedgerRow, ensureAccount, getAccount, getBalance } from "../src/billing/accounts.ts";
import { createCheckout, createPortal, resetBillingCaches } from "../src/billing/checkout.ts";
import { expireCredits } from "../src/billing/expiry.ts";
import { settleSessionUsage, settleUsage } from "../src/billing/usage.ts";
import { handleStripeEvent, type StripeEvent } from "../src/billing/webhook.ts";
import { getSql, type Sql } from "../src/db.ts";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";
import { ApiError } from "../src/lib/errors.ts";
import { signStripe } from "../src/lib/signatures.ts";
import type { FetchFn } from "../src/providers/http.ts";
import { setPaused } from "../src/services/settings.ts";
import { handleSessionIdle } from "../src/services/workflows.ts";
import { fakeStripe, type FakeStripe } from "./fake-stripe.ts";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const run = crypto.randomUUID().slice(0, 8);
const owner = (name: string) => `user_it_${run}_${name}`;
const cus = (name: string) => `cus_it_${run}_${name}`;
const sid = (name: string) => `ses_bill_${run}_${name}`;
let n = 0;
const evtId = () => `evt_it_${run}_${++n}`;
const secret = "whsec_integration_test_secret";
const ctx = {} as ExecutionContext;
let sql: Sql;
let originalPaused: unknown;

const baseEnv = (): Env => ({ PUBLIC_URL: "https://example.test", DATABASE_URL: url, MCP_TOKEN: "owner-token-it", STRIPE_WEBHOOK_SECRET: secret, STRIPE_SECRET_KEY: "sk_test_fake123", BILLING_FREE_CREDITS: "0" });

function stripeEvent(type: string, object: Record<string, unknown>, created = Math.floor(Date.now() / 1000)): StripeEvent {
  return { id: evtId(), type, created, livemode: false, data: { object } };
}

async function deliver(evt: StripeEvent, env = baseEnv()) {
  const body = JSON.stringify(evt);
  const signature = await signStripe(secret, Math.floor(Date.now() / 1000), body);
  const res = await worker.fetch(new Request("https://example.test/webhooks/stripe", { method: "POST", body, headers: { "Stripe-Signature": signature } }), env, ctx);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const meta = (o: string, extra: Record<string, string> = {}) => ({ app: "crusonia", crusonia_user_id: o, ...extra });
const packSession = (o: string, name: string, over: Record<string, unknown> = {}) => ({
  id: `cs_it_${run}_${name}`,
  object: "checkout.session",
  mode: "payment",
  payment_status: "paid",
  customer: cus(name),
  payment_intent: `pi_it_${run}_${name}`,
  amount_total: 1,
  currency: "usd",
  metadata: meta(o, { crusonia_kind: "pack", crusonia_key: "large" }),
  ...over,
});
const invoice = (o: string, name: string, id: string, priceId: string, billing_reason = "subscription_cycle", periodEnd?: number) => ({
  id,
  object: "invoice",
  customer: cus(name),
  billing_reason,
  status: "paid",
  amount_paid: 2_000,
  parent: { type: "subscription_details", subscription_details: { subscription: `sub_it_${run}_${name}`, metadata: meta(o) } },
  lines: {
    data: [
      {
        id: "il_1",
        parent: { type: "subscription_item_details", subscription_item_details: { proration: false } },
        pricing: { price_details: { price: priceId } },
        ...(periodEnd ? { period: { start: periodEnd - 30 * 86_400, end: periodEnd } } : {}),
      },
    ],
  },
});

async function ledger(o: string) {
  return (await sql`select amount::int, reason, source, stripe_payment_intent, purchase_source from credit_ledger where owner_id = ${o} order by id`) as {
    amount: number;
    reason: string;
    source: string;
    stripe_payment_intent: string | null;
    purchase_source: string | null;
  }[];
}

const link = (o: string, name: string) =>
  sql`insert into billing_accounts (owner_id, stripe_customer_id) values (${o}, ${cus(name)}) on conflict (owner_id) do update set stripe_customer_id = excluded.stripe_customer_id`;

/** A fake Stripe with the Pro price registered (metadata as setup writes it). */
function stripeWithPro(opts: { invoicePayments?: Record<string, string> } = {}): FakeStripe {
  const stripe = fakeStripe(opts);
  stripe.prices.set("price_pro_it", {
    id: "price_pro_it",
    object: "price",
    active: true,
    currency: "usd",
    unit_amount: 2_000,
    type: "recurring",
    recurring: { interval: "month", interval_count: 1 },
    lookup_key: null, // moved to a newer price: metadata still resolves the plan
    metadata: { app: "crusonia", crusonia_kind: "subscription", crusonia_key: "pro" },
    product: "prod_pro_it",
  });
  return stripe;
}

// Clerk session tokens signed with a key generated here (networkless verification with CLERK_JWT_KEY).
let keys: CryptoKeyPair;
let pem: string;
const b64url = (d: Uint8Array | string) => Buffer.from(typeof d === "string" ? new TextEncoder().encode(d) : d).toString("base64url");
async function clerkToken(sub: string) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "ins_test" }));
  const body = b64url(JSON.stringify({ sub, sid: "sess_it", iss: "https://clerk.crusonia.dev", iat: now - 10, nbf: now - 10, exp: now + 120 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

suite("billing (database, faked Stripe and Naive)", () => {
  beforeAll(async () => {
    sql = getSql(url);
    originalPaused = (await sql`select value from settings where key = 'paused'`)[0]?.value ?? false;
    await setPaused(sql, false, "test");
    const params = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
    keys = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
    const spki = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64");
    pem = `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----`;
  });

  afterAll(async () => {
    if (!sql) return;
    const pattern = `%_it_${run}_%`;
    await sql.transaction([
      sql`set local crusonia.allow_ledger_delete = 'on'`,
      sql`delete from credit_ledger where owner_id like ${pattern}`,
      sql`delete from billing_accounts where owner_id like ${pattern}`,
      sql`delete from events where data->>'owner_id' like ${pattern} or data->>'event_id' like ${`evt_it_${run}_%`}
            or data->>'session_id' like ${`ses_bill_${run}_%`} or (kind in ('settings_paused', 'settings_resumed') and data->>'actor' = 'test')`,
      sql`delete from webhook_events where event_id like ${`evt_it_${run}_%`}`,
      sql`delete from naive_sessions where id like ${`ses_bill_${run}_%`}`,
      sql`update settings set value = ${JSON.stringify(originalPaused)}::jsonb where key = 'paused'`,
    ]);
  });

  test("the ledger is append-only", async () => {
    const o = owner("ledger");
    await addLedgerRow(sql, { ownerId: o, amount: 5, reason: "adjustment", source: `adjustment:${o}` });
    // Neon queries are thenables; wrap them so `rejects` sees a real Promise.
    await expect(Promise.resolve(sql`update credit_ledger set amount = 500 where owner_id = ${o}`)).rejects.toThrow(/append-only/);
    await expect(Promise.resolve(sql`delete from credit_ledger where owner_id = ${o}`)).rejects.toThrow(/append-only/);
    expect(await getBalance(sql, o)).toBe(5);
  });

  test("free sample: granted once per owner on first sight, and BILLING_FREE_CREDITS=0 turns it off", async () => {
    const o = owner("sample");
    const env: Env = { ...baseEnv(), BILLING_FREE_CREDITS: undefined };
    await ensureAccount(sql, env, o);
    await ensureAccount(sql, env, o);
    expect(await ledger(o)).toEqual([{ amount: 300, reason: "grant", source: `signup:${o}`, stripe_payment_intent: null, purchase_source: null }]);
    const off = owner("nosample");
    await ensureAccount(sql, baseEnv(), off);
    expect(await ledger(off)).toEqual([]);
    expect(await getAccount(sql, off)).toMatchObject({ owner_id: off, stripe_customer_id: null, plan: null });
  });

  test("webhook: deduped by event id; a pack is credited once per session, with credits from plans.ts", async () => {
    const o = owner("pack");
    await link(o, "pack");
    const evt = stripeEvent("checkout.session.completed", packSession(o, "pack"));
    const first = await deliver(evt);
    expect(first).toEqual({ status: 200, body: { ok: true, type: "checkout.session.completed", action: "credit_pack", credits: 20_000, duplicate_source: false } });
    expect((await deliver(evt)).body).toEqual({ ok: true, duplicate: true });
    // A different event about the same session (async success after completed) does not credit again.
    const again = await deliver(stripeEvent("checkout.session.async_payment_succeeded", packSession(o, "pack")));
    expect(again.body).toMatchObject({ action: "credit_pack", credits: 0, duplicate_source: true });
    expect(await ledger(o)).toEqual([
      { amount: 20_000, reason: "pack", source: `checkout:cs_it_${run}_pack`, stripe_payment_intent: `pi_it_${run}_pack`, purchase_source: null },
    ]);
    const audit = await sql`select kind from events where data->>'event_id' = ${evt.id}`;
    expect(audit.map((r) => r.kind)).toEqual(["billing_credited"]);
  });

  test("an unpaid Checkout Session is not credited until async_payment_succeeded", async () => {
    const o = owner("async");
    await link(o, "async");
    const pending = await deliver(stripeEvent("checkout.session.completed", packSession(o, "async", { payment_status: "unpaid", metadata: meta(o, { crusonia_kind: "pack", crusonia_key: "small" }) })));
    expect(pending.body).toMatchObject({ action: "checkout_pending" });
    expect(await ledger(o)).toEqual([]);
    const paid = await deliver(stripeEvent("checkout.session.async_payment_succeeded", packSession(o, "async", { metadata: meta(o, { crusonia_kind: "pack", crusonia_key: "small" }) })));
    expect(paid.body).toMatchObject({ action: "credit_pack", credits: 1_000 });
    expect((await ledger(o)).map((r) => r.amount)).toEqual([1_000]);
  });

  test("metadata filter: events without app=crusonia change nothing and are audited as ignored", async () => {
    const o = owner("filter");
    await link(o, "filter");
    const evt = stripeEvent("checkout.session.completed", packSession(o, "filter", { metadata: { crusonia_user_id: o, crusonia_kind: "pack", crusonia_key: "large" } }));
    expect((await deliver(evt)).body).toMatchObject({ action: "ignore", reason: "metadata.app is not crusonia" });
    expect(await ledger(o)).toEqual([]);
    const [audit] = await sql`select kind, data->>'reason' as reason from events where data->>'event_id' = ${evt.id}`;
    expect(audit).toEqual({ kind: "billing_event_ignored", reason: "metadata.app is not crusonia" });
    // A customer that belongs to another owner is refused, not guessed.
    const other = await deliver(stripeEvent("checkout.session.completed", packSession(owner("intruder"), "filter")));
    expect(other.body).toMatchObject({ action: "ignore", reason: "customer belongs to another owner" });
    expect(await ledger(owner("intruder"))).toEqual([]);
  });

  test("invoice.paid grants the plan's monthly credits once per invoice; other billing reasons and prices grant nothing", async () => {
    resetBillingCaches();
    const o = owner("invoice");
    await link(o, "invoice");
    const stripe = stripeWithPro();
    const env = baseEnv();
    const inv = `in_it_${run}_1`;
    const first = await handleStripeEvent(sql, env, stripeEvent("invoice.paid", invoice(o, "invoice", inv, "price_pro_it", "subscription_create")), { fetchFn: stripe.fetch });
    expect(first).toEqual({ action: "invoice_paid", credits: 2_000, duplicate_source: false });
    const replay = await handleStripeEvent(sql, env, stripeEvent("invoice.paid", invoice(o, "invoice", inv, "price_pro_it")), { fetchFn: stripe.fetch });
    expect(replay).toEqual({ action: "invoice_paid", credits: 0, duplicate_source: true });
    const update = await handleStripeEvent(sql, env, stripeEvent("invoice.paid", invoice(o, "invoice", `in_it_${run}_2`, "price_pro_it", "subscription_update")), { fetchFn: stripe.fetch });
    expect(update.action).toBe("ignore");
    const foreign = await handleStripeEvent(sql, env, stripeEvent("invoice.paid", invoice(o, "invoice", `in_it_${run}_3`, "price_not_ours")), { fetchFn: stripe.fetch });
    expect(foreign).toMatchObject({ action: "ignore" });
    expect(await ledger(o)).toEqual([{ amount: 2_000, reason: "plan", source: `invoice:${inv}`, stripe_payment_intent: null, purchase_source: null }]);
    // The price was looked up once (then cached), with the pinned API version.
    expect(stripe.requests.filter((r) => r.path === "/v1/prices/price_pro_it")).toHaveLength(1);
  });

  test("included plan credits roll over one month after their period, then the unused rest expires (cron), once", async () => {
    resetBillingCaches();
    const o = owner("rollover");
    await link(o, "rollover");
    const inv = `in_it_${run}_rollover`;
    const pi = `pi_it_${run}_rollover`;
    const stripe = stripeWithPro({ invoicePayments: { [pi]: inv } });
    const env = baseEnv();
    // Far enough out that no other test's grant expires within the cron's 3-day window around it.
    const periodEnd = Math.floor(Date.now() / 1000) + 200 * 86_400;
    await handleStripeEvent(sql, env, stripeEvent("invoice.paid", invoice(o, "rollover", inv, "price_pro_it", "subscription_create", periodEnd)), { fetchFn: stripe.fetch });
    const [grant] = await sql`select expires_at, expires_at = to_timestamp(${periodEnd}) + interval '1 month' as one_month_after from credit_ledger where source = ${`invoice:${inv}`}`;
    expect(grant!.one_month_after).toBe(true);
    await addLedgerRow(sql, { ownerId: o, amount: 1_000, reason: "pack", source: `checkout:cs_it_${run}_rollover` });
    await addLedgerRow(sql, { ownerId: o, amount: -500, reason: "usage", source: `usage:ses_it_${run}_rollover` });

    // Before the expiry nothing happens; after it the unused 1,500 included credits go, the pack stays.
    expect(await expireCredits(sql, new Date())).toBe(0);
    const after = new Date(new Date(grant!.expires_at).getTime() + 3_600_000);
    expect(await expireCredits(sql, after)).toBe(1);
    expect(await expireCredits(sql, after)).toBe(0);
    expect((await ledger(o)).at(-1)).toEqual({ amount: -1_500, reason: "expire", source: `expire:invoice:${inv}`, stripe_payment_intent: null, purchase_source: `invoice:${inv}` });
    expect(await getBalance(sql, o)).toBe(1_000);

    // Refunding that invoice now claws back only the 500 credits that were used, not the 1,500 that expired.
    const res = await handleStripeEvent(
      sql,
      env,
      stripeEvent("charge.refunded", { id: `ch_it_${run}_rollover`, customer: cus("rollover"), payment_intent: pi, amount: 2_000, amount_refunded: 2_000, metadata: {} }),
      { fetchFn: stripe.fetch },
    );
    expect(res).toEqual({ action: "refund", credits: -500 });
    expect(await getBalance(sql, o)).toBe(500);
  });

  test("subscription events update the account in order; a stale event is ignored; deletion clears the plan", async () => {
    const o = owner("sub");
    await link(o, "sub");
    const t = Math.floor(Date.now() / 1000);
    const sub = (status: string, over: Record<string, unknown> = {}) => ({
      id: `sub_it_${run}_sub`,
      object: "subscription",
      customer: cus("sub"),
      status,
      cancel_at_period_end: false,
      metadata: meta(o),
      items: { data: [{ current_period_end: t + 30 * 86_400, price: { lookup_key: "crusonia_pro_monthly", metadata: {} } }] },
      ...over,
    });
    await deliver(stripeEvent("customer.subscription.updated", sub("active"), t));
    expect(await getAccount(sql, o)).toMatchObject({ plan: "pro", subscription_status: "active", stripe_subscription_id: `sub_it_${run}_sub`, cancel_at_period_end: false });
    expect(new Date((await getAccount(sql, o))!.current_period_end!).getTime()).toBe((t + 30 * 86_400) * 1000);

    // A plan checkout while subscribed is refused (change plans in the portal instead).
    const e = await createCheckout(sql, baseEnv(), { kind: "clerk", userId: o, sessionId: null }, { plan: "pro" }, fakeStripe().fetch).catch((err) => err);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe("already_subscribed");

    await deliver(stripeEvent("customer.subscription.updated", sub("past_due"), t - 100));
    expect((await getAccount(sql, o))!.subscription_status).toBe("active");
    await deliver(stripeEvent("customer.subscription.updated", sub("active", { cancel_at_period_end: true }), t + 5));
    expect((await getAccount(sql, o))!.cancel_at_period_end).toBe(true);
    await deliver(stripeEvent("customer.subscription.deleted", sub("canceled"), t + 10));
    expect(await getAccount(sql, o)).toMatchObject({ plan: null, subscription_status: "canceled", cancel_at_period_end: false });
  });

  test("charge.refunded claws back a pack proportionally, idempotently, and only for our purchases", async () => {
    const o = owner("refund");
    await link(o, "refund");
    await deliver(stripeEvent("checkout.session.completed", packSession(o, "refund", { metadata: meta(o, { crusonia_kind: "pack", crusonia_key: "medium" }) })));
    const charge = (refunded: number, over: Record<string, unknown> = {}) => ({
      id: `ch_it_${run}_refund`,
      object: "charge",
      customer: cus("refund"),
      payment_intent: `pi_it_${run}_refund`,
      amount: 5_000,
      amount_refunded: refunded,
      metadata: {},
      ...over,
    });
    expect((await deliver(stripeEvent("charge.refunded", charge(2_500)))).body).toMatchObject({ action: "refund", credits: -2_500 });
    expect((await deliver(stripeEvent("charge.refunded", charge(2_500)))).body).toMatchObject({ action: "refund", credits: 0 });
    expect((await deliver(stripeEvent("charge.refunded", charge(5_000)))).body).toMatchObject({ action: "refund", credits: -2_500 });
    const rows = await ledger(o);
    expect(rows.map((r) => [r.amount, r.reason, r.purchase_source])).toEqual([
      [5_000, "pack", null],
      [-2_500, "refund", `checkout:cs_it_${run}_refund`],
      [-2_500, "refund", `checkout:cs_it_${run}_refund`],
    ]);
    expect(await getBalance(sql, o)).toBe(0);
    // Someone else's charge (no app metadata, unknown customer) is ignored.
    const foreign = await deliver(stripeEvent("charge.refunded", charge(5_000, { id: `ch_it_${run}_x`, customer: "cus_unknown", payment_intent: "pi_unknown" })));
    expect(foreign.body).toMatchObject({ action: "ignore" });
  });

  test("a refunded subscription payment is matched to its invoice through the Invoice Payments API", async () => {
    resetBillingCaches();
    const o = owner("subrefund");
    await link(o, "subrefund");
    const inv = `in_it_${run}_subrefund`;
    const pi = `pi_it_${run}_subrefund`;
    const stripe = stripeWithPro({ invoicePayments: { [pi]: inv } });
    const env = baseEnv();
    await handleStripeEvent(sql, env, stripeEvent("invoice.paid", invoice(o, "subrefund", inv, "price_pro_it", "subscription_create")), { fetchFn: stripe.fetch });
    const res = await handleStripeEvent(
      sql,
      env,
      stripeEvent("charge.refunded", { id: `ch_it_${run}_subrefund`, customer: cus("subrefund"), payment_intent: pi, amount: 2_000, amount_refunded: 2_000, metadata: {} }),
      { fetchFn: stripe.fetch },
    );
    expect(res).toEqual({ action: "refund", credits: -2_000 });
    expect(await getBalance(sql, o)).toBe(0);
  });

  test("checkout and portal: customer found or created by owner id only, our metadata everywhere, never a Clerk user id key", async () => {
    resetBillingCaches();
    const stripe = fakeStripe();
    const dir = mkdtempSync(join(tmpdir(), "crusonia-billing-it-"));
    try {
      await setupStripe({ key: "sk_test_fake123", baseUrl: "https://example.test", secretPath: (m) => join(dir, `.dev.vars.stripe.${m}`), fetchFn: stripe.fetch });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const o = owner("checkout");
    const principal = { kind: "clerk" as const, userId: o, sessionId: null, email: "billing-it@example.com" };
    const env = baseEnv();
    const before = stripe.requests.length;

    const pack = await createCheckout(sql, env, principal, { pack: "small" }, stripe.fetch);
    expect(pack.url).toStartWith("https://checkout.stripe.com/");
    const plan = await createCheckout(sql, env, principal, { plan: "pro" }, stripe.fetch);
    expect(plan.url).toStartWith("https://checkout.stripe.com/");

    const mine = stripe.requests.slice(before);
    const customers = mine.filter((r) => r.method === "POST" && r.path === "/v1/customers");
    expect(customers).toHaveLength(1);
    expect(customers[0]!.params).toMatchObject({ email: "billing-it@example.com", metadata: { app: "crusonia", crusonia_user_id: o } });
    const sessions = mine.filter((r) => r.method === "POST" && r.path === "/v1/checkout/sessions");
    expect(sessions.map((s) => s.params.mode)).toEqual(["payment", "subscription"]);
    const customerId = (await getAccount(sql, o))!.stripe_customer_id;
    expect(customerId).toBeTruthy();
    for (const s of sessions) {
      expect(s.params.customer).toBe(customerId);
      expect(s.params.metadata).toMatchObject({ app: "crusonia", crusonia_user_id: o });
      expect(s.params.success_url).toBe("https://example.test/app/settings/billing?checkout=success");
      expect(s.params.cancel_url).toBe("https://example.test/app/settings/billing?checkout=cancelled");
    }
    expect(sessions[0]!.params.payment_intent_data.metadata).toEqual({ app: "crusonia", crusonia_user_id: o, crusonia_kind: "pack", crusonia_key: "small" });
    expect(sessions[1]!.params.subscription_data.metadata).toEqual({ app: "crusonia", crusonia_user_id: o, crusonia_kind: "subscription", crusonia_key: "pro" });
    for (const r of mine) expect(r.raw).not.toContain("clerk_" + "user_id");
    // Never matched by email: no customer search or list happened.
    expect(mine.some((r) => r.path.startsWith("/v1/customers") && r.method === "GET")).toBe(false);

    const portal = await createPortal(sql, env, principal, stripe.fetch);
    expect(portal.url).toStartWith("https://billing.stripe.com/");
    const portalReq = stripe.requests.find((r) => r.path === "/v1/billing_portal/sessions")!;
    expect(portalReq.params).toMatchObject({ customer: customerId, return_url: "https://example.test/app/settings/billing", configuration: [...stripe.portals.keys()][0] });

    const nobody = await createPortal(sql, env, { kind: "clerk", userId: owner("nocustomer"), sessionId: null }, stripe.fetch).catch((err) => err);
    expect((nobody as ApiError).code).toBe("no_billing_account");

    // A Stripe price that drifted from plans.ts is refused instead of charged.
    resetBillingCaches();
    [...stripe.prices.values()].find((p) => p.lookup_key === "crusonia_credits_small")!.unit_amount = 999;
    const drift = await createCheckout(sql, env, principal, { pack: "small" }, stripe.fetch).catch((err) => err);
    expect((drift as ApiError).code).toBe("prices_out_of_date");
  });

  test("usage: a finished session is debited once at 2x its spend, topped up if it spends more, safe under concurrency", async () => {
    const o = owner("usage");
    const s = sid("usage");
    await sql`insert into naive_sessions (id, purpose, status, consumed_micro_usd, billing_owner_id) values (${s}, 'research', 'done', 300000, ${o})`;
    expect(await settleSessionUsage(sql, s)).toBe(60);
    expect(await settleSessionUsage(sql, s)).toBe(0);
    expect((await Promise.all(Array.from({ length: 5 }, () => settleSessionUsage(sql, s)))).reduce((a, b) => a + b, 0)).toBe(0);
    await sql`update naive_sessions set consumed_micro_usd = 450000 where id = ${s}`;
    expect((await Promise.all(Array.from({ length: 4 }, () => settleSessionUsage(sql, s)))).reduce((a, b) => a + b, 0)).toBe(30);
    expect((await ledger(o)).map((r) => [r.amount, r.source])).toEqual([
      [-60, `usage:${s}`],
      [-30, `usage:${s}:450000`],
    ]);

    // Not billed: no billing owner (started before billing), still running, or no spend.
    await sql`insert into naive_sessions (id, purpose, status, consumed_micro_usd, billing_owner_id) values
      (${sid("legacy")}, 'research', 'done', 300000, null),
      (${sid("running")}, 'research', 'running', 300000, ${o}),
      (${sid("free")}, 'research', 'done', 0, ${o})`;
    for (const name of ["legacy", "running", "free"]) expect(await settleSessionUsage(sql, sid(name))).toBe(0);
  });

  test("a session that finishes through handleSessionIdle is debited from its reported spend", async () => {
    const o = owner("idle");
    const s = sid("idle");
    await sql`insert into naive_sessions (id, purpose, status, billing_owner_id) values (${s}, 'onboarding', 'running', ${o})`;
    const naive: FetchFn = async (u) =>
      u.endsWith(`/v1/sessions/${s}`)
        ? new Response(JSON.stringify({ id: s, status: "completed", stop_reason: "end_turn", pending_actions: [], consumed_micro_usd: 123_457 }))
        : new Response("{}", { status: 404 });
    const result = await handleSessionIdle(sql, { PUBLIC_URL: "https://example.test", NAIVE_API_KEY: "nv_test" }, { sessionId: s }, naive);
    expect(result.known).toBe(true);
    expect(await ledger(o)).toEqual([{ amount: -25, reason: "usage", source: `usage:${s}`, stripe_payment_intent: null, purchase_source: null }]);
  });

  test("the cron fills in unreported spend and debits sessions that still owe", async () => {
    const o = owner("cron");
    const s = sid("cron");
    await sql`insert into naive_sessions (id, purpose, status, billing_owner_id) values (${s}, 'find_leads', 'done', ${o})`;
    const naive: FetchFn = async (u) =>
      u.includes(`/v1/sessions/${s}`)
        ? new Response(JSON.stringify({ id: s, status: "completed", consumed_micro_usd: 50_000 }))
        : new Response(JSON.stringify({ id: "x", status: "completed", consumed_micro_usd: null }));
    await settleUsage(sql, { PUBLIC_URL: "https://example.test", NAIVE_API_KEY: "nv_test" }, naive);
    expect((await ledger(o)).map((r) => r.amount)).toEqual([-10]);
    await settleUsage(sql, { PUBLIC_URL: "https://example.test", NAIVE_API_KEY: "nv_test" }, naive);
    expect((await ledger(o)).map((r) => r.amount)).toEqual([-10]);
  });

  test("402 through the routes for a Clerk user: on with no credits, off, MCP_TOKEN bypass, and after a top-up", async () => {
    const o = owner("gate");
    const env: Env = {
      ...baseEnv(),
      CLERK_JWT_KEY: pem,
      CLERK_ALLOWED_USER_IDS: o,
      BILLING_ENFORCED: "true",
      NAIVE_API_KEY: "nv_test",
      NAIVE_AGENT_ID: "agt_test",
    };
    const token = await clerkToken(o);
    const post = (path: string, body: unknown, e: Env = env, bearer = token) =>
      worker.fetch(
        new Request(`https://example.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        e,
        ctx,
      );
    const research = { lead_ids: [`lead_missing_${run}`] }; // no lead matches, so no Naive session is started

    for (const [path, body] of [
      ["/api/workflows/research", research],
      ["/api/leads/find", { count: 5 }],
      ["/api/onboarding/propose", { url: "acme.example" }],
    ] as const) {
      const res = await post(path, body);
      expect(res.status).toBe(402);
      expect(((await res.json()) as { error: { code: string; details: { balance: number } } }).error).toMatchObject({ code: "insufficient_credits", details: { balance: 0 } });
    }
    expect((await post("/api/workflows/research", research, { ...env, BILLING_ENFORCED: undefined })).status).toBe(200);
    expect((await post("/api/workflows/research", research, env, "owner-token-it")).status).toBe(200);
    await addLedgerRow(sql, { ownerId: o, amount: 100, reason: "adjustment", source: `adjustment:${o}` });
    const ok = await post("/api/workflows/research", research);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ started: [], skipped: [{ lead_id: `lead_missing_${run}`, reason: "not_found" }], failed: [] });

    // GET /api/billing for the same user: plan, balance, ledger and the catalogue.
    const res = await worker.fetch(new Request("https://example.test/api/billing", { headers: { Authorization: `Bearer ${token}` } }), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body).toMatchObject({
      owner_id: o,
      billing: { configured: true, webhook_configured: true, mode: "test", enforced: true },
      plan: { key: "free", status: null },
      has_customer: false,
      balance: 100,
      balance_usd: 1,
      credit: { usd: 0.01, usage_markup: 2, free_sample_credits: 0, included_rollover_months: 1 },
      expiring: [],
    });
    expect(body.ledger).toHaveLength(1);
    expect(body.plans.map((p: { key: string; price: string }) => `${p.key} ${p.price}`)).toEqual(["free $0/mo", "pro $20/mo", "scale $100/mo"]);
    expect(body.packs.map((p: { key: string; credits: number }) => `${p.key} ${p.credits}`)).toEqual(["small 1000", "medium 5000", "large 20000"]);
  });
});
