// The public price list in the shape GET /api/billing returns (`plans` without `current`, `packs`, `credit`).
// Pure: it imports only plans.ts, so the web app imports this file too. The signed-out /pricing page renders it
// (it cannot call /api/billing), and overview.ts builds the API response from it, so the two never drift.
import {
  FREE_PLAN,
  FREE_SAMPLE_CREDITS,
  INCLUDED_CREDIT_ROLLOVER_MONTHS,
  MICRO_USD_PER_CREDIT,
  PACKS,
  PLANS,
  TYPICAL_LEAD_CREDITS,
  USAGE_MARKUP_BPS,
  displayPrice,
} from "./plans.ts";

export type CatalogPlan = {
  key: string;
  kind: "free" | "subscription";
  name: string;
  description: string;
  /** Cents per month. */
  unit_amount: number;
  interval: "month";
  monthly_credits: number;
  /** "$20/mo". */
  price: string;
  /** False for Free (no Stripe object): there is nothing to check out. */
  checkout: boolean;
};

export type CatalogPack = {
  key: string;
  kind: "pack";
  name: string;
  description: string;
  unit_amount: number;
  credits: number;
  /** "$10". */
  price: string;
};

export type CreditFacts = {
  /** Dollars per credit (0.01). */
  usd: number;
  /** Provider cost multiplier for metered usage (2 = 2x). */
  usage_markup: number;
  free_sample_credits: number;
  /** Months unused included plan credit carries over; null = never expires. */
  included_rollover_months: number | null;
};

export function planCatalog(): CatalogPlan[] {
  return [
    {
      key: FREE_PLAN.key,
      kind: "free",
      name: FREE_PLAN.name,
      description: FREE_PLAN.description,
      unit_amount: FREE_PLAN.unitAmount,
      interval: FREE_PLAN.interval,
      monthly_credits: FREE_PLAN.monthlyCredits,
      price: displayPrice(FREE_PLAN),
      checkout: false,
    },
    ...PLANS.map((p) => ({
      key: p.key,
      kind: p.kind,
      name: p.name,
      description: p.description,
      unit_amount: p.unitAmount,
      interval: p.interval,
      monthly_credits: p.monthlyCredits,
      price: displayPrice(p),
      checkout: true,
    })),
  ];
}

export function packCatalog(): CatalogPack[] {
  return PACKS.map((p) => ({
    key: p.key,
    kind: p.kind,
    name: p.name,
    description: p.description,
    unit_amount: p.unitAmount,
    credits: p.credits,
    price: displayPrice(p),
  }));
}

/** The credit definition. `freeSample` is the deployment's grant (BILLING_FREE_CREDITS) when known. */
export function creditFacts(freeSample = FREE_SAMPLE_CREDITS): CreditFacts {
  return {
    usd: MICRO_USD_PER_CREDIT / 1_000_000,
    usage_markup: USAGE_MARKUP_BPS / 10_000,
    free_sample_credits: freeSample,
    included_rollover_months: INCLUDED_CREDIT_ROLLOVER_MONTHS,
  };
}

/** Display only: about how many hosted-agent leads a credit amount covers (rounded down). */
export const leadsFor = (credits: number) => Math.floor(credits / TYPICAL_LEAD_CREDITS);

export { TYPICAL_LEAD_CREDITS };
