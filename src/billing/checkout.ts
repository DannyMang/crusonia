// Checkout and Customer Portal sessions, and the Stripe lookups behind them. Prices are found by lookup_key and
// checked against plans.ts before a customer is sent to pay; the portal configuration is found by metadata.
// Nothing here stores or needs a Stripe object id in config.
import { logEvent, type Sql } from "../db.ts";
import type { Env } from "../env.ts";
import type { Principal } from "../lib/context.ts";
import { ApiError } from "../lib/errors.ts";
import { sha256, toHex } from "../lib/crypto.ts";
import type { FetchFn } from "../providers/http.ts";
import { StripeClient, StripeError, type StripeList, type StripePrice } from "../providers/stripe.ts";
import { missingKey } from "../services/errors.ts";
import { ensureAccount, getAccount } from "./accounts.ts";
import { BILLING_APP_PATH, crusoniaMetadata } from "./constants.ts";
import { CURRENCY, offerForPrice, packByKey, planByKey, type Offer } from "./plans.ts";

/** Stripe client from STRIPE_SECRET_KEY; 503 not_configured without it. */
export function stripeFor(env: Env, fetchFn?: FetchFn): StripeClient {
  if (!env.STRIPE_SECRET_KEY) throw missingKey("STRIPE_SECRET_KEY", "billing");
  return new StripeClient(env.STRIPE_SECRET_KEY, fetchFn);
}

export const billingUrl = (env: Env) => `${env.PUBLIC_URL.replace(/\/+$/, "")}${BILLING_APP_PATH}`;

// Per-isolate caches. Prices and the portal configuration change only when setup runs.
const PRICE_TTL_MS = 5 * 60_000;
const priceByLookupKey = new Map<string, { price: StripePrice; at: number }>();
const offerByPriceId = new Map<string, Offer | null>();
let portalConfiguration: { id: string | null; at: number } | undefined;

export function resetBillingCaches(): void {
  priceByLookupKey.clear();
  offerByPriceId.clear();
  portalConfiguration = undefined;
}

function upstream(err: unknown): never {
  if (err instanceof StripeError) throw new ApiError(502, "stripe_error", err.message);
  throw err;
}

/** The active Stripe price for an offer, checked against plans.ts so nobody pays a price we do not show. */
export async function priceForOffer(stripe: StripeClient, offer: Offer): Promise<StripePrice> {
  const cached = priceByLookupKey.get(offer.lookupKey);
  if (cached && Date.now() - cached.at < PRICE_TTL_MS) return cached.price;
  const list = await stripe
    .get<StripeList<StripePrice>>("/v1/prices", { lookup_keys: [offer.lookupKey], active: true, limit: 1 })
    .catch(upstream);
  const price = list.data[0];
  if (!price) {
    throw new ApiError(503, "not_configured", `No Stripe price for ${offer.key} yet: run \`bun run setup --stripe\`.`);
  }
  const recurring = offer.kind === "subscription";
  const matches =
    price.unit_amount === offer.unitAmount &&
    price.currency === CURRENCY &&
    (recurring ? price.type === "recurring" && price.recurring?.interval === offer.interval && price.recurring.interval_count === 1 : price.type === "one_time");
  if (!matches) {
    throw new ApiError(409, "prices_out_of_date", `The Stripe price for ${offer.key} does not match src/billing/plans.ts: run \`bun run setup --stripe\`.`);
  }
  priceByLookupKey.set(offer.lookupKey, { price, at: Date.now() });
  offerByPriceId.set(price.id, offer);
  return price;
}

/** The plans.ts offer a Stripe price id belongs to (price metadata, then lookup_key). Cached per isolate. */
export async function offerForPriceId(stripe: StripeClient, priceId: string): Promise<Offer | undefined> {
  if (offerByPriceId.has(priceId)) return offerByPriceId.get(priceId) ?? undefined;
  let price: StripePrice | undefined;
  try {
    price = await stripe.get<StripePrice>(`/v1/prices/${encodeURIComponent(priceId)}`);
  } catch (err) {
    // A missing price is permanent (not ours); anything else is transient and the webhook delivery is retried.
    if (!(err instanceof StripeError && err.status === 404)) throw err;
  }
  const offer = offerForPrice(price);
  offerByPriceId.set(priceId, offer ?? null);
  return offer;
}

/**
 * The workspace's Stripe customer, created on first use with our metadata. Looked up by workspace only (never by
 * email). A deterministic Idempotency-Key makes concurrent first calls return the same customer.
 */
export async function findOrCreateCustomer(sql: Sql, env: Env, stripe: StripeClient, ws: string, principal?: Principal): Promise<string> {
  await ensureAccount(sql, env, ws);
  const existing = (await getAccount(sql, ws))?.stripe_customer_id;
  if (existing) return existing;
  const params = {
    description: "Crusonia billing account",
    metadata: crusoniaMetadata(ws),
    ...(principal?.kind === "clerk" && principal.email ? { email: principal.email } : {}),
    ...(principal?.kind === "clerk" && principal.name ? { name: principal.name } : {}),
  };
  const key = `crusonia-customer-${toHex(await sha256(`${ws}\n${JSON.stringify(params)}`)).slice(0, 40)}`;
  const customer = await stripe.post<{ id: string }>("/v1/customers", params, key).catch(upstream);
  const linked = await sql`
    update billing_accounts set stripe_customer_id = ${customer.id}, updated_at = now()
    where workspace_id = ${ws} and stripe_customer_id is null
    returning stripe_customer_id`;
  if (linked.length) {
    await logEvent(sql, ws, null, "billing_customer_created", { workspace_id: ws });
    return customer.id;
  }
  // Another request linked one first; keep theirs.
  return (await getAccount(sql, ws))!.stripe_customer_id!;
}

/** Checkout Studio settings on every Checkout Session. payment_method_collection is added for subscriptions only: Stripe refuses it without a recurring price. */
const CHECKOUT_SETTINGS = {
  ui_mode: "hosted_page",
  billing_address_collection: "auto",
  phone_number_collection: { enabled: false },
  automatic_tax: { enabled: false },
  allow_promotion_codes: false,
  submit_type: "auto",
  integration_identifier: "hosted_web_0001",
  origin_context: "web",
};

const LIVE_SUBSCRIPTION = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);

export function resolveOffer(input: { plan?: string; pack?: string }): Offer {
  const offer = input.plan ? planByKey(input.plan) : packByKey(input.pack);
  if (!offer) {
    const what = input.plan ? `plan "${input.plan}"` : `pack "${input.pack}"`;
    throw new ApiError(400, "unknown_offer", `Unknown ${what}. GET /api/billing lists the plans and packs.`);
  }
  return offer;
}

/** POST /api/billing/checkout: a Checkout Session for a monthly plan (subscription) or a credit pack (payment). */
export async function createCheckout(
  sql: Sql,
  env: Env,
  principal: Principal,
  ws: string,
  input: { plan?: string; pack?: string },
  fetchFn?: FetchFn,
) {
  const offer = resolveOffer(input);
  const stripe = stripeFor(env, fetchFn);

  if (offer.kind === "subscription") {
    const account = await getAccount(sql, ws);
    if (account?.stripe_subscription_id && LIVE_SUBSCRIPTION.has(account.subscription_status ?? "")) {
      throw new ApiError(409, "already_subscribed", "This account already has a subscription. Change or cancel it in the billing portal (POST /api/billing/portal).");
    }
  }
  const price = await priceForOffer(stripe, offer);
  const customer = await findOrCreateCustomer(sql, env, stripe, ws, principal);
  const metadata = crusoniaMetadata(ws, { crusonia_kind: offer.kind, crusonia_key: offer.key });
  const base = billingUrl(env);
  const session = await stripe
    .post<{ id: string; url: string | null }>(
      "/v1/checkout/sessions",
      {
        ...CHECKOUT_SETTINGS,
        mode: offer.kind === "subscription" ? "subscription" : "payment",
        customer,
        line_items: [{ price: price.id, quantity: 1 }],
        success_url: `${base}?checkout=success`,
        cancel_url: `${base}?checkout=cancelled`,
        metadata,
        ...(offer.kind === "subscription" ? { payment_method_collection: "always", subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
      },
      `crusonia-checkout-${crypto.randomUUID()}`,
    )
    .catch(upstream);
  if (!session.url) throw new ApiError(502, "stripe_error", "Stripe returned a Checkout Session without a URL");
  await logEvent(sql, ws, null, "billing_checkout_created", { workspace_id: ws, kind: offer.kind, key: offer.key, checkout_session: session.id });
  return { url: session.url };
}

async function portalConfigurationId(stripe: StripeClient): Promise<string | null> {
  if (portalConfiguration && Date.now() - portalConfiguration.at < PRICE_TTL_MS) return portalConfiguration.id;
  const configs = await stripe
    .list<{ id: string; active: boolean; metadata: Record<string, string> }>("/v1/billing_portal/configurations", { active: true }, 300)
    .catch(upstream);
  const ours = configs.find((c) => c.active && c.metadata?.app === "crusonia");
  portalConfiguration = { id: ours?.id ?? null, at: Date.now() };
  return portalConfiguration.id;
}

/** POST /api/billing/portal: a Customer Portal session (change or cancel the plan, invoices, payment methods). */
export async function createPortal(sql: Sql, env: Env, ws: string, fetchFn?: FetchFn) {
  const stripe = stripeFor(env, fetchFn);
  const customer = (await getAccount(sql, ws))?.stripe_customer_id;
  if (!customer) {
    throw new ApiError(409, "no_billing_account", "No Stripe customer yet: buy a credit pack or subscribe first (POST /api/billing/checkout).");
  }
  const configuration = await portalConfigurationId(stripe);
  if (!configuration) throw new ApiError(503, "not_configured", "The Stripe Customer Portal is not configured: run `bun run setup --stripe`.");
  const session = await stripe
    .post<{ url: string }>("/v1/billing_portal/sessions", { customer, configuration, return_url: billingUrl(env) })
    .catch(upstream);
  await logEvent(sql, ws, null, "billing_portal_opened", { workspace_id: ws });
  return { url: session.url };
}
