// GET /api/billing: the caller's plan, subscription status, balance, recent ledger rows, and what they can buy.
// Display prices come from plans.ts via catalog.ts (setup keeps Stripe in step with it), so this works without a
// Stripe key.
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { stripeKeyMode } from "../providers/stripe.ts";
import { billingEnforced, ensureAccount, getAccount, getBalance, recentLedger } from "./accounts.ts";
import { loadLedger, replayLedger } from "./expiry.ts";
import { creditFacts, packCatalog, planCatalog } from "./catalog.ts";
import { FREE_PLAN, creditsToUsd, freeSampleCredits, planByKey } from "./plans.ts";

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
  const [account, balance, ledger, entries] = await Promise.all([
    getAccount(sql, ownerId),
    getBalance(sql, ownerId),
    recentLedger(sql, ownerId, 20),
    loadLedger(sql, ownerId),
  ]);
  const { upcoming } = replayLedger(entries);
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
    // Included plan credits still unspent, soonest expiry first (packs and the free sample never expire).
    expiring: upcoming.map((e) => ({ credits: e.credits, expires_at: e.expiresAt.toISOString() })),
    ledger: ledger.map((r) => ({
      id: r.id,
      amount: r.amount,
      reason: r.reason,
      source: r.source,
      session_id: r.session_id,
      data: r.data,
      created_at: iso(r.created_at),
    })),
    // The public price list (catalog.ts, also rendered by the signed-out /pricing page) plus the caller's plan.
    plans: planCatalog().map((p) => ({ ...p, current: currentKey === p.key })),
    packs: packCatalog(),
    credit: creditFacts(freeSampleCredits(env.BILLING_FREE_CREDITS)),
  };
}
