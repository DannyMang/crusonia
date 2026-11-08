// Billing accounts and the credit ledger: who pays (the workspace), the balance, grants, and the 402 gate for paid
// work. Ledger amounts are whole credits (src/billing/plans.ts). Every write is idempotent on credit_ledger.source.
// `owner_id` is the legacy key from before workspaces ('owner' or a Clerk user id); new rows carry the workspace id.
import { logEvent, type Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { sqlFor, type Principal } from "../lib/context.ts";
import { ApiError } from "../lib/errors.ts";
import { isOwnerWorkspace } from "../services/workspaces.ts";
import { BILLING_APP_PATH } from "./constants.ts";
import { creditsToUsd, freeSampleCredits } from "./plans.ts";

/** The BILLING_ENFORCED switch. It governs the owner workspace; every other workspace is always enforced. */
export const billingEnforced = (env: Env) => /^(1|true|yes|on)$/i.test(env.BILLING_ENFORCED?.trim() ?? "");

/** Whether paid work in this workspace needs credits: always, except the owner workspace while BILLING_ENFORCED is off. */
export const creditsEnforcedFor = (env: Env, ws: string) => !isOwnerWorkspace(ws) || billingEnforced(env);

export type BillingAccount = {
  workspace_id: string;
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
 * Creates the workspace's billing account on first sight and grants the free sample once per workspace (source
 * `signup:<workspace>`; a workspace that already has a signup grant, like the owner's legacy `signup:owner`, gets
 * none). Safe to call on every request: both statements are no-ops after the first time.
 */
export async function ensureAccount(sql: Sql, env: Env, ws: string): Promise<void> {
  const credits = freeSampleCredits(env.BILLING_FREE_CREDITS);
  const source = `signup:${ws}`;
  const [, granted] = await sql.transaction([
    sql`insert into billing_accounts (owner_id, workspace_id) values (${ws}, ${ws}) on conflict do nothing`,
    sql`insert into credit_ledger (workspace_id, owner_id, amount, reason, source, data)
        select ${ws}, ${ws}, ${credits}::bigint, 'grant', ${source}, '{"kind":"free_sample"}'::jsonb
        where ${credits}::bigint > 0
          and not exists (select 1 from credit_ledger where workspace_id = ${ws} and reason = 'grant' and source like 'signup:%')
        on conflict (source) do nothing
        returning id`,
  ]);
  if (granted?.length) await logEvent(sql, ws, null, "billing_credited", { workspace_id: ws, credits, reason: "grant", source });
}

export async function getAccount(sql: Sql, ws: string): Promise<BillingAccount | undefined> {
  return (await sql`select * from billing_accounts where workspace_id = ${ws}`)[0] as BillingAccount | undefined;
}

export async function getBalance(sql: Sql, ws: string): Promise<number> {
  const [row] = await sql`select coalesce(sum(amount), 0)::text as balance from credit_ledger where workspace_id = ${ws}`;
  return Number(row?.balance ?? 0);
}

export async function recentLedger(sql: Sql, ws: string, limit = 20): Promise<LedgerRow[]> {
  const rows = await sql`
    select id::text, amount::text, reason, source, session_id, data, created_at from credit_ledger
    where workspace_id = ${ws} order by id desc limit ${limit}`;
  return rows.map((r) => ({ ...(r as LedgerRow), amount: Number(r.amount) }));
}

/** Inserts a ledger row for a workspace unless its source exists. True if this call wrote it. */
export async function addLedgerRow(
  sql: Sql,
  row: {
    workspaceId: string;
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
    insert into credit_ledger (workspace_id, owner_id, amount, reason, source, stripe_payment_intent, data, expires_at)
    values (${row.workspaceId}, ${row.workspaceId}, ${row.amount}::bigint, ${row.reason}, ${row.source}, ${row.paymentIntent ?? null},
            ${JSON.stringify(row.data ?? {})}::jsonb,
            case when ${months}::int is null then null
                 else coalesce(to_timestamp(${periodEnd}::double precision), now() + interval '1 month') + make_interval(months => ${months}::int)
            end)
    on conflict (source) do nothing
    returning id`;
  return inserted.length > 0;
}

/**
 * 402 insufficient_credits before paid work when the workspace's balance is <= 0. Enforced for every workspace
 * except the owner's, which only BILLING_ENFORCED turns on; MCP_TOKEN (the owner's own token) always bypasses it.
 * `balance` replaces the database (tests).
 */
export async function requireCredits(
  env: Env,
  principal: Principal,
  ws: string,
  deps: { balance?: (ws: string) => Promise<number> } = {},
): Promise<void> {
  if (principal.kind === "owner_token" || !creditsEnforcedFor(env, ws)) return;
  const balance = deps.balance
    ? await deps.balance(ws)
    : await (async () => {
        const sql = sqlFor(env);
        await ensureAccount(sql, env, ws);
        return getBalance(sql, ws);
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
