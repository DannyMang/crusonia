// GET /api/billing: the caller's plan, subscription status, balance, recent ledger rows, and what they can buy.
// Display prices come from plans.ts (setup keeps Stripe in step with it), so this works without a Stripe key.
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { stripeKeyMode } from "../providers/stripe.ts";
import { billingEnforced, ensureAccount, getAccount, getBalance, recentLedger } from "./accounts.ts";
import {
  FREE_PLAN,
  MICRO_USD_PER_CREDIT,
  PACKS,
  PLANS,
  USAGE_MARKUP_BPS,
  creditsToUsd,
  displayPrice,
  freeSampleCredits,
  planByKey,
} from "./plans.ts";

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

/** Configuration flags shared by GET /api/billing and GET /api/status. Never includes key material. */
export function billingConfig(env: Env) {
  return {
    configured: Boolean(env.STRIPE_SECRET_KEY),
    webhook_configured: Boolean(env.STRIPE_WEBHOOK_SECRET),
    mode: stripeKeyMode(env.STRIPE_SECRET_KEY) ?? null,
    enforced: billingEnforced(env),
  };
}

export async function getBillingOverview(sql: Sql, env: Env, ownerId: string) {
  await ensureAccount(sql, env, ownerId);
  const [account, balance, ledger] = await Promise.all([getAccount(sql, ownerId), getBalance(sql, ownerId), recentLedger(sql, ownerId, 20)]);
  const plan = planByKey(account?.plan);
  const currentKey = plan?.key ?? FREE_PLAN.key;
  return {
    owner_id: ownerId,
    billing: billingConfig(env),
    plan: {
      key: currentKey,
      name: plan?.name ?? FREE_PLAN.name,
      status: account?.subscription_status ?? null,
      current_period_end: iso(account?.current_period_end),
      cancel_at_period_end: account?.cancel_at_period_end ?? false,
    },
    has_customer: Boolean(account?.stripe_customer_id),
    balance,
    balance_usd: creditsToUsd(balance),
    ledger: ledger.map((r) => ({
      id: r.id,
      amount: r.amount,
      reason: r.reason,
      source: r.source,
      session_id: r.session_id,
      data: r.data,
      created_at: iso(r.created_at),
    })),
    plans: [
      {
        key: FREE_PLAN.key,
        kind: "free" as const,
        name: FREE_PLAN.name,
        description: FREE_PLAN.description,
        unit_amount: FREE_PLAN.unitAmount,
        interval: FREE_PLAN.interval,
        monthly_credits: FREE_PLAN.monthlyCredits,
        price: displayPrice(FREE_PLAN),
        checkout: false,
        current: currentKey === FREE_PLAN.key,
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
        current: currentKey === p.key,
      })),
    ],
    packs: PACKS.map((p) => ({
      key: p.key,
      kind: p.kind,
      name: p.name,
      description: p.description,
      unit_amount: p.unitAmount,
      credits: p.credits,
      price: displayPrice(p),
    })),
    credit: {
      usd: MICRO_USD_PER_CREDIT / 1_000_000,
      usage_markup: USAGE_MARKUP_BPS / 10_000,
      free_sample_credits: freeSampleCredits(env.BILLING_FREE_CREDITS),
    },
  };
}
