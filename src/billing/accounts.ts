// Billing accounts and the credit ledger: who pays, the balance, grants, and the 402 gate for paid work.
// Ledger amounts are whole credits (src/billing/plans.ts). Every write is idempotent on credit_ledger.source.
import { logEvent, type Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { sqlFor, type Principal } from "../lib/context.ts";
import { ApiError } from "../lib/errors.ts";
import { BILLING_APP_PATH } from "./constants.ts";
import { creditsToUsd, freeSampleCredits } from "./plans.ts";

/** Billing owner for MCP_TOKEN and API-key callers (single workspace: they act as the owner). */
export const OWNER_ACCOUNT = "owner";

/** The billing owner of an /api caller: the Clerk user id, or `owner` for MCP_TOKEN and API keys. */
export function billingOwnerOf(principal: Principal): string {
  return principal.kind === "clerk" ? principal.userId : OWNER_ACCOUNT;
}

export const billingEnforced = (env: Env) => /^(1|true|yes|on)$/i.test(env.BILLING_ENFORCED?.trim() ?? "");

export type BillingAccount = {
  owner_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan: string | null;
  subscription_status: string | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  created_at: Date;
  updated_at: Date;
};

export type LedgerRow = {
  id: string;
  amount: number;
  reason: string;
  source: string;
  session_id: string | null;
  data: Record<string, unknown>;
  created_at: Date;
};

/**
 * Creates the account on first sight and grants the free sample once (source `signup:<owner>`). Safe to call on
 * every request: both statements are no-ops after the first time.
 */
export async function ensureAccount(sql: Sql, env: Env, ownerId: string): Promise<void> {
  const credits = freeSampleCredits(env.BILLING_FREE_CREDITS);
  const [, granted] = await sql.transaction([
    sql`insert into billing_accounts (owner_id) values (${ownerId}) on conflict (owner_id) do nothing`,
    sql`insert into credit_ledger (owner_id, amount, reason, source, data)
        select ${ownerId}, ${credits}::bigint, 'grant', ${`signup:${ownerId}`}, '{"kind":"free_sample"}'::jsonb
        where ${credits}::bigint > 0
        on conflict (source) do nothing
        returning id`,
  ]);
  if (granted?.length) await logEvent(sql, null, "billing_credited", { owner_id: ownerId, credits, reason: "grant", source: `signup:${ownerId}` });
}

export async function getAccount(sql: Sql, ownerId: string): Promise<BillingAccount | undefined> {
  return (await sql`select * from billing_accounts where owner_id = ${ownerId}`)[0] as BillingAccount | undefined;
}

export async function getBalance(sql: Sql, ownerId: string): Promise<number> {
  const [row] = await sql`select coalesce(sum(amount), 0)::text as balance from credit_ledger where owner_id = ${ownerId}`;
  return Number(row?.balance ?? 0);
}

export async function recentLedger(sql: Sql, ownerId: string, limit = 20): Promise<LedgerRow[]> {
  const rows = await sql`
    select id::text, amount::text, reason, source, session_id, data, created_at from credit_ledger
    where owner_id = ${ownerId} order by id desc limit ${limit}`;
  return rows.map((r) => ({ ...(r as LedgerRow), amount: Number(r.amount) }));
}

/** Inserts a ledger row unless its source exists. True if this call wrote it. */
export async function addLedgerRow(
  sql: Sql,
  row: {
    ownerId: string;
    amount: number;
    reason: "grant" | "pack" | "plan" | "usage" | "refund" | "adjustment";
    source: string;
    paymentIntent?: string | null;
    data?: Record<string, unknown>;
    /**
     * Included credits that roll over: they expire `rolloverMonths` after `periodEnd` (unix seconds; about a month
     * from now when unknown). Omitted, or rolloverMonths null: they never expire.
     */
    expiry?: { periodEnd: number | null; rolloverMonths: number | null };
  },
): Promise<boolean> {
  const months = row.expiry?.rolloverMonths ?? null;
  const periodEnd = row.expiry?.periodEnd ?? null;
  const inserted = await sql`
    insert into credit_ledger (owner_id, amount, reason, source, stripe_payment_intent, data, expires_at)
    values (${row.ownerId}, ${row.amount}::bigint, ${row.reason}, ${row.source}, ${row.paymentIntent ?? null},
            ${JSON.stringify(row.data ?? {})}::jsonb,
            case when ${months}::int is null then null
                 else coalesce(to_timestamp(${periodEnd}::double precision), now() + interval '1 month') + make_interval(months => ${months}::int)
            end)
    on conflict (source) do nothing
    returning id`;
  return inserted.length > 0;
}

/**
 * 402 insufficient_credits before paid work when BILLING_ENFORCED is on and the caller's balance is <= 0.
 * Off by default; MCP_TOKEN (the owner's own token) always bypasses it. `balance` replaces the database (tests).
 */
export async function requireCredits(env: Env, principal: Principal, deps: { balance?: (ownerId: string) => Promise<number> } = {}): Promise<void> {
  if (!billingEnforced(env) || principal.kind === "owner_token") return;
  const ownerId = billingOwnerOf(principal);
  const balance = deps.balance
    ? await deps.balance(ownerId)
    : await (async () => {
        const sql = sqlFor(env);
        await ensureAccount(sql, env, ownerId);
        return getBalance(sql, ownerId);
      })();
  if (balance <= 0) {
    throw new ApiError(
      402,
      "insufficient_credits",
      `Not enough credits to start paid work (balance ${balance}). Buy a credit pack or subscribe in Settings > Billing.`,
      { balance, balance_usd: creditsToUsd(balance), billing_url: `${env.PUBLIC_URL.replace(/\/+$/, "")}${BILLING_APP_PATH}` },
    );
  }
}
