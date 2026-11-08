// `bun run setup --stripe`: makes Crusonia's own Stripe account match src/billing/plans.ts. Idempotent.
//   - products and prices for every plan and credit pack, found by lookup_key and metadata (created or updated;
//     a changed amount gets a new price, the lookup key moves to it and the old price is archived)
//   - the Customer Portal configuration (metadata app=crusonia): plan changes, cancel at period end, invoices,
//     payment methods
//   - the webhook endpoint ${PUBLIC_URL}/webhooks/stripe for exactly the events we handle, at the pinned API version
// The webhook signing secret goes to a private gitignored file (mode 600) for the owner to upload; it is never
// printed. Live keys are refused unless `live` is set (--live). Nothing printed contains a Stripe object id.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { BILLING_APP_PATH, STRIPE_EVENTS, STRIPE_WEBHOOK_PATH, crusoniaMetadata } from "../../src/billing/constants.ts";
import { CURRENCY, OFFERS, PACKS, PLANS, displayPrice, type Offer } from "../../src/billing/plans.ts";
import type { FetchFn } from "../../src/providers/http.ts";
import {
  STRIPE_API_VERSION,
  StripeClient,
  stripeKeyMode,
  type StripeList,
  type StripeMode,
  type StripePrice,
  type StripeProduct,
} from "../../src/providers/stripe.ts";

/** Throws unless the key is a Stripe secret or restricted key whose mode matches `live`. Runs before any request. */
export function checkStripeKey(key: string | undefined, live: boolean): StripeMode {
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set. Add Crusonia's Stripe test key (sk_test_ or rk_test_) to .dev.vars.");
  const mode = stripeKeyMode(key);
  if (!mode) throw new Error("STRIPE_SECRET_KEY is not a Stripe secret (sk_) or restricted (rk_) key.");
  if (mode === "live" && !live) {
    throw new Error("Refusing a live Stripe key without --live. Set up and test in test mode first; to go live, re-run with --live.");
  }
  if (mode === "test" && live) throw new Error("--live was passed, but STRIPE_SECRET_KEY is a test key.");
  return mode;
}

export type StripeSetupOptions = {
  key: string | undefined;
  /** PUBLIC_URL without a trailing slash. */
  baseUrl: string;
  live?: boolean;
  /** Create a new webhook endpoint (new secret) and delete the old one. */
  rotateWebhookSecret?: boolean;
  /** Test mode only: create one Checkout Session for the smallest pack, check its URL, then expire it. */
  verifyCheckout?: boolean;
  /** Where the webhook secret is written for this mode. */
  secretPath: (mode: StripeMode) => string;
  fetchFn?: FetchFn;
  log?: (line: string) => void;
};

export type StripeSetupResult = {
  mode: StripeMode;
  offers: { key: string; product: string; price: string }[];
  portal: "created" | "updated";
  webhook: "created" | "updated" | "rotated";
  secretWritten: boolean;
  checkout?: "ok";
  notes: string[];
};

type Endpoint = { id: string; url: string; api_version: string | null; metadata: Record<string, string>; status?: string };

async function stableKey(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`crusonia-setup:${seed}`));
  return `crusonia-setup-${Array.from(new Uint8Array(digest).slice(0, 20), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const offerMetadata = (o: Offer) => ({ app: "crusonia", crusonia_kind: o.kind, crusonia_key: o.key });
const sameMetadata = (have: Record<string, string> | undefined, want: Record<string, string>) =>
  Object.entries(want).every(([k, v]) => have?.[k] === v);

function priceMatches(price: StripePrice, offer: Offer, productId: string): boolean {
  const product = typeof price.product === "string" ? price.product : price.product.id;
  if (product !== productId || price.unit_amount !== offer.unitAmount || price.currency !== CURRENCY) return false;
  return offer.kind === "subscription"
    ? price.type === "recurring" && price.recurring?.interval === offer.interval && price.recurring.interval_count === 1
    : price.type === "one_time";
}

export async function setupStripe(opts: StripeSetupOptions): Promise<StripeSetupResult> {
  const mode = checkStripeKey(opts.key, Boolean(opts.live));
  const log = opts.log ?? (() => {});
  const stripe = new StripeClient(opts.key!, opts.fetchFn);
  const notes: string[] = [];
  log(`Stripe ${mode} mode, API version ${STRIPE_API_VERSION}`);

  // ---------- products and prices ----------
  let products: StripeProduct[] | undefined;
  const ids = new Map<string, { product: string; price: string }>();
  const offers: StripeSetupResult["offers"] = [];

  for (const offer of OFFERS) {
    const meta = offerMetadata(offer);
    const existing = (
      await stripe.get<StripeList<StripePrice>>("/v1/prices", { lookup_keys: [offer.lookupKey], limit: 1, expand: ["data.product"] })
    ).data[0];

    let product = existing && typeof existing.product === "object" ? existing.product : undefined;
    if (!product || !sameMetadata(product.metadata, meta)) {
      products ??= await stripe.list<StripeProduct>("/v1/products", {}, 1000);
      const candidates = products.filter((p) => sameMetadata(p.metadata, meta));
      product = candidates.find((p) => p.active) ?? candidates[0];
    }
    let productStatus = "unchanged";
    const productParams = { name: offer.name, description: offer.description, metadata: meta };
    if (!product) {
      product = await stripe.post<StripeProduct>("/v1/products", productParams, await stableKey(`${mode}:product:${JSON.stringify(productParams)}`));
      productStatus = "created";
    } else if (!product.active || product.name !== offer.name || product.description !== offer.description || !sameMetadata(product.metadata, meta)) {
      product = await stripe.post<StripeProduct>(`/v1/products/${product.id}`, { ...productParams, active: true });
      productStatus = "updated";
    }

    let price: StripePrice;
    let priceStatus = "unchanged";
    if (existing && priceMatches(existing, offer, product.id)) {
      price = existing;
      if (!existing.active || !sameMetadata(existing.metadata, meta)) {
        price = await stripe.post<StripePrice>(`/v1/prices/${existing.id}`, { active: true, metadata: meta, nickname: offer.name });
        priceStatus = "updated";
      }
    } else {
      const priceParams = {
        product: product.id,
        currency: CURRENCY,
        unit_amount: offer.unitAmount,
        ...(offer.kind === "subscription" ? { recurring: { interval: offer.interval } } : {}),
        lookup_key: offer.lookupKey,
        transfer_lookup_key: true,
        nickname: offer.name,
        metadata: meta,
      };
      // The seed names the price being replaced, so changing an amount back within Stripe's 24-hour idempotency
      // window creates a new price instead of replaying the archived one.
      const seed = `${mode}:price:${existing?.id ?? "none"}:${JSON.stringify(priceParams)}`;
      price = await stripe.post<StripePrice>("/v1/prices", priceParams, await stableKey(seed));
      priceStatus = existing ? "replaced (amount changed; existing subscribers keep their price)" : "created";
      // The old price lost its lookup key to the new one; archive it so nobody new can buy it.
      if (existing?.active) await stripe.post(`/v1/prices/${existing.id}`, { active: false });
    }
    ids.set(offer.key, { product: product.id, price: price.id });
    offers.push({ key: offer.key, product: productStatus, price: priceStatus });
    log(`  ${offer.kind === "subscription" ? "plan" : "pack"} ${offer.key} (${offer.lookupKey}, ${displayPrice(offer)}): product ${productStatus}, price ${priceStatus}`);
  }

  // ---------- Customer Portal ----------
  const planPrices = PLANS.map((p) => ids.get(p.key)!);
  const portalParams = {
    name: "Crusonia",
    business_profile: { headline: "Crusonia: plan, invoices and payment methods" },
    default_return_url: `${opts.baseUrl}${BILLING_APP_PATH}`,
    features: {
      customer_update: { enabled: true, allowed_updates: ["email", "name", "address", "tax_id"] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: "at_period_end",
        proration_behavior: "none",
        cancellation_reason: { enabled: true, options: ["too_expensive", "missing_features", "switched_service", "unused", "other"] },
      },
      // Switching plans needs two or more plans. No proration: a new plan's credits arrive with its next invoice.
      subscription_update:
        planPrices.length > 1
          ? {
              enabled: true,
              default_allowed_updates: ["price"],
              proration_behavior: "none",
              products: planPrices.map((p) => ({ product: p.product, prices: [p.price] })),
            }
          : { enabled: false },
    },
    metadata: { app: "crusonia" },
  };
  const configs = await stripe.list<{ id: string; active: boolean; metadata: Record<string, string> }>("/v1/billing_portal/configurations", {}, 300);
  const portal = configs.find((c) => c.active && c.metadata?.app === "crusonia");
  if (portal) await stripe.post(`/v1/billing_portal/configurations/${portal.id}`, portalParams);
  else await stripe.post("/v1/billing_portal/configurations", portalParams, await stableKey(`${mode}:portal:${JSON.stringify(portalParams)}`));
  log(`  customer portal: ${portal ? "updated" : "created"}${planPrices.length > 1 ? "" : " (plan switching off: only one plan)"}`);

  // ---------- webhook endpoint ----------
  const url = `${opts.baseUrl}${STRIPE_WEBHOOK_PATH}`;
  const secretFile = opts.secretPath(mode);
  const haveSecret = existsSync(secretFile) && /^STRIPE_WEBHOOK_SECRET=whsec_/m.test(readFileSync(secretFile, "utf8"));
  const endpoints = (await stripe.list<Endpoint>("/v1/webhook_endpoints", {}, 100)).filter((e) => e.metadata?.app === "crusonia");
  const same = endpoints.filter((e) => e.url === url);
  const current = same.find((e) => e.api_version === STRIPE_API_VERSION);
  const description = "Crusonia billing (scripts/setup.ts --stripe)";
  let webhook: StripeSetupResult["webhook"];
  let secretWritten = false;
  if (current && !opts.rotateWebhookSecret) {
    await stripe.post(`/v1/webhook_endpoints/${current.id}`, { enabled_events: [...STRIPE_EVENTS], description, disabled: false });
    webhook = "updated";
    if (same.length > 1) notes.push(`${same.length} Stripe webhook endpoints point at ${url}; keep the one whose secret is on the Worker and delete the rest.`);
    if (!haveSecret) {
      notes.push(
        `The Stripe webhook endpoint exists, but its signing secret is not in ${secretFile} (Stripe shows it only once). ` +
          "If STRIPE_WEBHOOK_SECRET is already on the Worker, nothing to do; otherwise re-run with --rotate-webhook-secret.",
      );
    }
  } else {
    const created = await stripe.post<{ id: string; secret: string }>("/v1/webhook_endpoints", {
      url,
      enabled_events: [...STRIPE_EVENTS],
      api_version: STRIPE_API_VERSION,
      description,
      metadata: { app: "crusonia" },
    });
    writeFileSync(
      secretFile,
      `# Stripe webhook signing secret (${mode} mode) for ${url}. Written by scripts/setup.ts --stripe; do not commit.\n` +
        `# Upload to the Worker: bunx wrangler secret bulk ${secretFile.split("/").pop()}\n` +
        `STRIPE_WEBHOOK_SECRET=${created.secret}\n`,
      { mode: 0o600 },
    );
    chmodSync(secretFile, 0o600);
    secretWritten = true;
    // Older endpoints for this URL (a rotation, an API version change, or a crashed earlier run) stop now.
    for (const old of same) await stripe.del(`/v1/webhook_endpoints/${old.id}`);
    webhook = same.length ? "rotated" : "created";
  }
  log(`  webhook ${url}: ${webhook} (${STRIPE_EVENTS.length} events, API ${STRIPE_API_VERSION})${secretWritten ? `; signing secret written to ${secretFile}` : ""}`);
  for (const other of endpoints.filter((e) => e.url !== url)) {
    notes.push(`Another Crusonia webhook endpoint points at ${new URL(other.url).host}; delete it in the Stripe Dashboard if PUBLIC_URL changed.`);
  }

  // ---------- optional: a real Checkout Session (test mode only) ----------
  let checkout: StripeSetupResult["checkout"];
  if (opts.verifyCheckout) {
    if (mode !== "test") throw new Error("--verify-checkout runs in test mode only.");
    const pack = PACKS[0]!;
    const metadata = crusoniaMetadata("setup-check", { crusonia_kind: pack.kind, crusonia_key: pack.key });
    const session = await stripe.post<{ id: string; url: string | null }>("/v1/checkout/sessions", {
      mode: "payment",
      line_items: [{ price: ids.get(pack.key)!.price, quantity: 1 }],
      success_url: `${opts.baseUrl}${BILLING_APP_PATH}?checkout=success`,
      cancel_url: `${opts.baseUrl}${BILLING_APP_PATH}?checkout=cancelled`,
      metadata,
      payment_intent_data: { metadata },
    });
    const ok = typeof session.url === "string" && session.url.startsWith("https://checkout.stripe.com/");
    await stripe.post(`/v1/checkout/sessions/${session.id}/expire`);
    if (!ok) throw new Error("Stripe created a Checkout Session without a checkout.stripe.com URL.");
    checkout = "ok";
    log(`  checkout: a test Checkout Session for the ${pack.key} pack was created (checkout.stripe.com URL) and expired`);
  }

  return { mode, offers, portal: portal ? "updated" : "created", webhook, secretWritten, ...(checkout ? { checkout } : {}), notes };
}
