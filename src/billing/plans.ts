// Billing tiers, credit packs and the credit definition. Changing pricing is an edit to this one file plus
// `bun run setup --stripe` (creates or updates the Stripe products and prices by lookup_key) and a deploy.
//
// TODO(owner): pending pricing decision. Every name, price and credit amount below is a placeholder (the owner's
// Free / Pro $20 / Scale $100 structure on top of the "Pricing research" proposal in Notion); nothing is public yet.
//
// The credit
// - credit_ledger.amount is in whole credits (signed bigint): + grants and purchases, - usage and refunds.
// - 1 credit = $0.01 of list value (MICRO_USD_PER_CREDIT micro-USD): $10 buys 1,000 credits.
// - Usage is debited at our provider cost times USAGE_MARKUP_BPS, rounded up to whole credits. Today the only
//   metered cost is hosted agent time: a Naive session that reported $0.30 of spend debits
//   ceil(300,000 x 2.0 / 10,000) = 60 credits. At 2x every credit spent at list price carries a 50% gross margin
//   on provider cost (before Stripe fees). Data calls (Apify search and page reads) are not metered yet.
// - Packs and plans grant the fixed amounts below. The amount a customer paid never sets the credits (coupons,
//   taxes and currency rounding change what is paid, not what is granted).
// - Included plan credits roll over for INCLUDED_CREDIT_ROLLOVER_MONTHS after the period they were granted for,
//   then the unused rest expires (an `expire` ledger row, written by the minute cron). Usage spends the
//   soonest-expiring credits first. Top-up packs and the free sample never expire.
// - Plan changes in the Customer Portal apply without proration: the new plan's credits arrive with its next paid
//   invoice (an upgrade can top up with a pack meanwhile). TODO(owner): prorated upgrades would need a rule for
//   the credits granted mid-period.
//
// Stripe objects are found by `lookupKey` (prices) and by metadata `crusonia_key` + `crusonia_kind` (products and
// prices), never by id, so no Stripe ids live in this repo. Changing an amount makes setup create a new price and
// move the lookup key to it; existing subscribers stay on their old price, which keeps its metadata, so their
// invoices still resolve to the right plan. Renaming a `key` or `lookupKey` creates new Stripe objects instead.

export const CURRENCY = "usd";

/** One credit is worth $0.01: 10,000 micro-USD (1,000,000 micro-USD = $1). */
export const MICRO_USD_PER_CREDIT = 10_000;

/** Provider cost multiplier for metered usage, in basis points: 20,000 = 2.0x. */
export const USAGE_MARKUP_BPS = 20_000;

/**
 * Free sample granted once per billing account when it is first seen ("first 5 leads free"): 5 leads at about
 * 60 credits for a hosted-agent lead end to end. The BILLING_FREE_CREDITS var overrides it; "0" turns it off.
 */
export const FREE_SAMPLE_CREDITS = 300;

/**
 * About what one lead costs end to end with the hosted agent (found, researched with sources, scored, drafted).
 * Display only: /pricing turns credit amounts into "about N researched leads". Usage is metered, not this.
 */
export const TYPICAL_LEAD_CREDITS = 60;

/**
 * How long unused included plan credits carry over after the billing period they were granted for: 1 = credits
 * for March can still be spent in April and expire at the end of April. null = they never expire.
 */
export const INCLUDED_CREDIT_ROLLOVER_MONTHS: number | null = 1;

export type SubscriptionPlan = {
  kind: "subscription";
  /** Stable id used by the API (`POST /api/billing/checkout {plan}`) and in Stripe metadata. */
  key: string;
  name: string;
  description: string;
  lookupKey: string;
  /** Price in the smallest currency unit (cents). */
  unitAmount: number;
  interval: "month";
  /** Granted on every paid subscription invoice (first payment and each renewal). */
  monthlyCredits: number;
};

export type CreditPack = {
  kind: "pack";
  key: string;
  name: string;
  description: string;
  lookupKey: string;
  unitAmount: number;
  /** Granted once when the one-time Checkout payment is paid. */
  credits: number;
};

export type Offer = SubscriptionPlan | CreditPack;

/** Shown in GET /api/billing only: no Stripe object (the hosted default before any subscription). */
export const FREE_PLAN = {
  key: "free",
  name: "Free",
  description: "$0/month. The first 5 leads are free; top up credits from $10.",
  unitAmount: 0,
  interval: "month" as const,
  monthlyCredits: 0,
};

export const PLANS: readonly SubscriptionPlan[] = [
  {
    kind: "subscription",
    key: "pro",
    name: "Crusonia Pro",
    description: "2,000 credits ($20 of usage) every month. Unused credit rolls over for one month.",
    lookupKey: "crusonia_pro_monthly",
    unitAmount: 2_000,
    interval: "month",
    monthlyCredits: 2_000,
  },
  {
    kind: "subscription",
    key: "scale",
    name: "Crusonia Scale",
    description: "10,000 credits ($100 of usage) every month. Unused credit rolls over for one month.",
    lookupKey: "crusonia_scale_monthly",
    unitAmount: 10_000,
    interval: "month",
    monthlyCredits: 10_000,
  },
];

export const PACKS: readonly CreditPack[] = [
  {
    kind: "pack",
    key: "small",
    name: "1,000 Crusonia credits",
    description: "$10 of usage. One-time top-up.",
    lookupKey: "crusonia_credits_small",
    unitAmount: 1_000,
    credits: 1_000,
  },
  {
    kind: "pack",
    key: "medium",
    name: "5,000 Crusonia credits",
    description: "$50 of usage. One-time top-up.",
    lookupKey: "crusonia_credits_medium",
    unitAmount: 5_000,
    credits: 5_000,
  },
  {
    kind: "pack",
    key: "large",
    name: "20,000 Crusonia credits",
    description: "$200 of usage. One-time top-up.",
    lookupKey: "crusonia_credits_large",
    unitAmount: 20_000,
    credits: 20_000,
  },
];

export const OFFERS: readonly Offer[] = [...PLANS, ...PACKS];

export const planByKey = (key: string | null | undefined) => PLANS.find((p) => p.key === key);
export const packByKey = (key: string | null | undefined) => PACKS.find((p) => p.key === key);

/**
 * The offer a Stripe price belongs to: its metadata (set by setup, survives a lookup-key move) first, then its
 * lookup_key. Undefined for prices that are not ours.
 */
export function offerForPrice(price: { lookup_key?: string | null; metadata?: Record<string, string> | null } | null | undefined): Offer | undefined {
  if (!price) return undefined;
  const meta = price.metadata ?? {};
  if (meta.app === "crusonia" && meta.crusonia_key) {
    const found = OFFERS.find((o) => o.key === meta.crusonia_key && o.kind === meta.crusonia_kind);
    if (found) return found;
  }
  return price.lookup_key ? OFFERS.find((o) => o.lookupKey === price.lookup_key) : undefined;
}

/** Credits debited for metered provider spend: cost x markup, rounded up to whole credits. 0 for no spend. */
export function creditsForUsage(consumedMicroUsd: number | null | undefined): number {
  if (!consumedMicroUsd || consumedMicroUsd <= 0 || !Number.isFinite(consumedMicroUsd)) return 0;
  // Integer math: micro-USD x bps can exceed 2^53 only past ~$450M of spend.
  return Math.ceil((Math.round(consumedMicroUsd) * USAGE_MARKUP_BPS) / (10_000 * MICRO_USD_PER_CREDIT));
}

/** List value of a credit amount in USD (1 credit = $0.01). */
export const creditsToUsd = (credits: number) => Math.round(credits * MICRO_USD_PER_CREDIT) / 1_000_000;

/** "$99/mo", "$10", "$0/mo". */
export function displayPrice(o: { unitAmount: number; interval?: "month" }): string {
  const dollars = o.unitAmount / 100;
  const text = Number.isInteger(dollars) ? `$${dollars.toLocaleString("en-US")}` : `$${dollars.toFixed(2)}`;
  return o.interval ? `${text}/mo` : text;
}

/** The free-sample grant for a new billing account (BILLING_FREE_CREDITS overrides the default; "0" disables it). */
export function freeSampleCredits(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return FREE_SAMPLE_CREDITS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : FREE_SAMPLE_CREDITS;
}
