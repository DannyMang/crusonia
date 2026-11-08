// Stripe webhook events -> billing state. The route (src/api/webhooks.ts) verifies the signature and dedupes the
// event id first. Here `interpretStripeEvent` (pure) decides what an event means, and `handleStripeEvent` applies
// it: ledger rows are idempotent on their source (checkout:<session>, invoice:<id>, refund:<charge>:<amount>),
// so a redelivered event or two events about the same payment never credit twice.
//
// Every object maps to one workspace: the account linked to the Stripe customer, else the metadata
// (crusonia_workspace_id, or the legacy crusonia_user_id from before workspaces). Events that map to no workspace
// are audited in the owner workspace.
//
// Rules: only objects carrying metadata app=crusonia are acted on (refunds: the charge's metadata, or a customer we
// created); credits come from src/billing/plans.ts, never from the amount paid; a Checkout payment is credited
// only once payment_status is "paid"; every event is written to the events audit table.
import { z } from "zod";
import { logEvent, type Sql } from "../db.ts";
import type { Env } from "../env.ts";
import type { FetchFn } from "../providers/http.ts";
import type { StripeList } from "../providers/stripe.ts";
import { OWNER_WORKSPACE_ID } from "../services/workspaces.ts";
import { addLedgerRow } from "./accounts.ts";
import { offerForPriceId, stripeFor } from "./checkout.ts";
import { INCLUDED_CREDIT_ROLLOVER_MONTHS, offerForPrice, packByKey, type CreditPack } from "./plans.ts";

export const StripeEventSchema = z.looseObject({
  id: z.string().min(1).max(255),
  type: z.string().min(1).max(255),
  created: z.number(),
  livemode: z.boolean().optional(),
  data: z.looseObject({ object: z.record(z.string(), z.unknown()) }),
});
export type StripeEvent = z.infer<typeof StripeEventSchema>;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** An expandable field: the id string, or the expanded object's id. */
const idOf = (v: unknown): string | null => str(v) ?? str(obj(v).id);
const metadataOf = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj(v))) if (typeof val === "string") out[k] = val;
  return out;
};
const ours = (meta: Record<string, string>) => meta.app === "crusonia";
/** The paying workspace from our metadata (or the legacy billing owner id on objects from before workspaces). */
const metadataOwner = (meta: Record<string, string>): string | null => meta.crusonia_workspace_id || meta.crusonia_user_id || null;

export type BillingAction =
  | { kind: "ignore"; reason: string }
  | { kind: "checkout_pending"; owner: string; session: string; payment_status: string | null }
  | {
      kind: "credit_pack";
      owner: string;
      customer: string | null;
      session: string;
      pack: CreditPack;
      paymentIntent: string | null;
      amountTotal: number | null;
      currency: string | null;
    }
  | { kind: "link_subscription"; owner: string; customer: string | null; session: string; subscription: string }
  | {
      kind: "subscription";
      owner: string | null;
      customer: string | null;
      subscription: string;
      status: string | null;
      plan: string | null;
      currentPeriodEnd: number | null;
      cancelAtPeriodEnd: boolean;
      deleted: boolean;
    }
  | {
      kind: "invoice_paid";
      owner: string | null;
      customer: string | null;
      invoice: string;
      subscription: string | null;
      billingReason: string;
      priceId: string | null;
      /** End of the billing period the line covers (unix seconds): included credits roll over from here. */
      periodEnd: number | null;
    }
  | {
      kind: "refund";
      charge: string;
      customer: string | null;
      paymentIntent: string | null;
      amount: number;
      amountRefunded: number;
      oursByMetadata: boolean;
    };

/** Invoices that grant a plan's monthly credits: the first payment and each renewal. */
const GRANTING_REASONS = new Set(["subscription_create", "subscription_cycle"]);

/** What a Stripe event means for billing. Pure: no database, no network. */
export function interpretStripeEvent(event: StripeEvent): BillingAction {
  const o = event.data.object;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const meta = metadataOf(o.metadata);
      if (!ours(meta)) return { kind: "ignore", reason: "metadata.app is not crusonia" };
      const owner = metadataOwner(meta);
      if (!owner) return { kind: "ignore", reason: "metadata has no crusonia_workspace_id" };
      const session = str(o.id) ?? "";
      if (o.mode === "subscription") {
        const subscription = idOf(o.subscription);
        if (!subscription) return { kind: "ignore", reason: "subscription checkout without a subscription" };
        // Credits for subscriptions come from invoice.paid; this only links the subscription.
        return { kind: "link_subscription", owner, customer: idOf(o.customer), session, subscription };
      }
      if (o.mode !== "payment") return { kind: "ignore", reason: `checkout mode ${String(o.mode)} is not handled` };
      const pack = meta.crusonia_kind === "pack" ? packByKey(meta.crusonia_key) : undefined;
      if (!pack) return { kind: "ignore", reason: `unknown credit pack ${JSON.stringify(meta.crusonia_key ?? null)} (not in plans.ts)` };
      if (o.payment_status !== "paid") return { kind: "checkout_pending", owner, session, payment_status: str(o.payment_status) };
      return {
        kind: "credit_pack",
        owner,
        customer: idOf(o.customer),
        session,
        pack,
        paymentIntent: idOf(o.payment_intent),
        amountTotal: num(o.amount_total),
        currency: str(o.currency),
      };
    }

    case "invoice.paid": {
      const parent = obj(o.parent);
      if (parent.type !== "subscription_details") return { kind: "ignore", reason: "not a subscription invoice" };
      const details = obj(parent.subscription_details);
      const meta = metadataOf(details.metadata);
      if (!ours(meta)) return { kind: "ignore", reason: "subscription metadata.app is not crusonia" };
      const billingReason = str(o.billing_reason) ?? "unknown";
      if (!GRANTING_REASONS.has(billingReason)) return { kind: "ignore", reason: `billing_reason ${billingReason} does not grant credits` };
      const lines = (obj(o.lines).data as unknown[] | undefined) ?? [];
      const line = lines.map(obj).find((l) => {
        const p = obj(l.parent);
        return p.type === "subscription_item_details" && obj(p.subscription_item_details).proration !== true;
      });
      return {
        kind: "invoice_paid",
        owner: metadataOwner(meta),
        customer: idOf(o.customer),
        invoice: str(o.id) ?? "",
        subscription: idOf(details.subscription),
        billingReason,
        priceId: line ? idOf(obj(obj(line.pricing).price_details).price) : null,
        periodEnd: line ? num(obj(line.period).end) : null,
      };
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const meta = metadataOf(o.metadata);
      if (!ours(meta)) return { kind: "ignore", reason: "metadata.app is not crusonia" };
      const item = obj(((obj(o.items).data as unknown[] | undefined) ?? [])[0]);
      const offer = offerForPrice(obj(item.price) as { lookup_key?: string | null; metadata?: Record<string, string> });
      return {
        kind: "subscription",
        owner: metadataOwner(meta),
        customer: idOf(o.customer),
        subscription: str(o.id) ?? "",
        status: str(o.status),
        plan: offer?.kind === "subscription" ? offer.key : null,
        // Item-level since 2025-03-31.basil; the subscription-level field is the fallback for older payloads.
        currentPeriodEnd: num(item.current_period_end) ?? num(o.current_period_end),
        cancelAtPeriodEnd: o.cancel_at_period_end === true || num(o.cancel_at) !== null,
        deleted: event.type === "customer.subscription.deleted",
      };
    }

    case "charge.refunded":
      return {
        kind: "refund",
        charge: str(o.id) ?? "",
        customer: idOf(o.customer),
        paymentIntent: idOf(o.payment_intent),
        amount: num(o.amount) ?? 0,
        amountRefunded: num(o.amount_refunded) ?? 0,
        oursByMetadata: ours(metadataOf(o.metadata)),
      };

    default:
      return { kind: "ignore", reason: `event type ${event.type} is not handled` };
  }
}

/** Credits to claw back for a purchase after `amountRefunded` of a charge of `amount` was refunded (cumulative). */
export function clawbackTarget(granted: number, amount: number, amountRefunded: number): number {
  if (granted <= 0 || amountRefunded <= 0) return 0;
  if (amount <= 0 || amountRefunded >= amount) return granted;
  return Math.min(granted, Math.round((granted * amountRefunded) / amount));
}

type Owner = { workspace: string } | { error: string };

/**
 * The workspace a metadata owner id names: a workspace id, or a legacy billing owner id from before workspaces
 * ('owner', or a Clerk user id) mapped through the merged billing account or the user's membership.
 */
async function workspaceForOwnerId(sql: Sql, ownerId: string): Promise<string | null> {
  if (ownerId === "owner") return OWNER_WORKSPACE_ID;
  const [row] = await sql`
    select coalesce(
      (select id from workspaces where id = ${ownerId}),
      (select workspace_id from billing_accounts where owner_id = ${ownerId}),
      (select workspace_id from workspace_members where clerk_user_id = ${ownerId})
    ) as workspace_id`;
  return (row?.workspace_id as string | null) ?? null;
}

/**
 * The workspace for a Stripe customer: the account linked to that customer (we created it), else the metadata
 * workspace, linked now if that workspace has no customer yet. A disagreement is refused, not guessed.
 */
async function resolveOwner(sql: Sql, customer: string | null, metadataOwner: string | null): Promise<Owner> {
  const named = metadataOwner ? await workspaceForOwnerId(sql, metadataOwner) : null;
  if (metadataOwner && !named) return { error: "metadata names no known workspace" };
  if (customer) {
    const linked = (await sql`select workspace_id from billing_accounts where stripe_customer_id = ${customer}`)[0]?.workspace_id as string | undefined;
    if (linked) return named && named !== linked ? { error: "customer belongs to another workspace" } : { workspace: linked };
  }
  if (!named) return { error: "unknown customer and no crusonia_workspace_id" };
  if (!customer) return { workspace: named };
  const [row] = await sql`
    insert into billing_accounts (owner_id, workspace_id, stripe_customer_id) values (${named}, ${named}, ${customer})
    on conflict (workspace_id) do update
      set stripe_customer_id = coalesce(billing_accounts.stripe_customer_id, excluded.stripe_customer_id), updated_at = now()
    returning stripe_customer_id`;
  return row?.stripe_customer_id === customer ? { workspace: named } : { error: "workspace already has a different customer" };
}

export type HandleResult = { action: BillingAction["kind"]; credits?: number; duplicate_source?: boolean; reason?: string };

/** Applies a verified, deduped Stripe event. Throws on transient failures so Stripe retries the delivery. */
export async function handleStripeEvent(sql: Sql, env: Env, event: StripeEvent, deps: { fetchFn?: FetchFn } = {}): Promise<HandleResult> {
  const action = interpretStripeEvent(event);
  // Audited in the event's workspace once known; events that map to none land in the owner workspace.
  const audit = (kind: string, data: Record<string, unknown>, ws: string = OWNER_WORKSPACE_ID) =>
    logEvent(sql, ws, null, kind, { event_id: event.id, type: event.type, ...data });

  switch (action.kind) {
    case "ignore":
      await audit("billing_event_ignored", { reason: action.reason });
      return { action: action.kind, reason: action.reason };

    case "checkout_pending":
      await audit("billing_checkout_pending", { metadata_owner: action.owner, checkout_session: action.session, payment_status: action.payment_status });
      return { action: action.kind };

    case "credit_pack": {
      const who = await resolveOwner(sql, action.customer, action.owner);
      if ("error" in who) {
        await audit("billing_needs_attention", { reason: who.error, checkout_session: action.session });
        return { action: "ignore", reason: who.error };
      }
      const source = `checkout:${action.session}`;
      const written = await addLedgerRow(sql, {
        workspaceId: who.workspace,
        amount: action.pack.credits,
        reason: "pack",
        source,
        paymentIntent: action.paymentIntent,
        data: { pack: action.pack.key, amount_total: action.amountTotal, currency: action.currency },
      });
      await audit(
        "billing_credited",
        { workspace_id: who.workspace, reason: "pack", pack: action.pack.key, credits: action.pack.credits, source, duplicate: !written },
        who.workspace,
      );
      return { action: action.kind, credits: written ? action.pack.credits : 0, duplicate_source: !written };
    }

    case "link_subscription": {
      const who = await resolveOwner(sql, action.customer, action.owner);
      if ("error" in who) {
        await audit("billing_needs_attention", { reason: who.error, checkout_session: action.session });
        return { action: "ignore", reason: who.error };
      }
      await sql`update billing_accounts set stripe_subscription_id = coalesce(stripe_subscription_id, ${action.subscription}), updated_at = now()
                where workspace_id = ${who.workspace}`;
      await audit("billing_subscription_linked", { workspace_id: who.workspace, subscription: action.subscription, checkout_session: action.session }, who.workspace);
      return { action: action.kind };
    }

    case "subscription": {
      const who = await resolveOwner(sql, action.customer, action.owner);
      if ("error" in who) {
        await audit("billing_needs_attention", { reason: who.error, subscription: action.subscription });
        return { action: "ignore", reason: who.error };
      }
      const ended = action.deleted || action.status === "canceled" || action.status === "incomplete_expired";
      const periodEnd = action.currentPeriodEnd ? new Date(action.currentPeriodEnd * 1000).toISOString() : null;
      const eventAt = new Date(event.created * 1000).toISOString();
      // Older events never overwrite newer state, and a deleted old subscription never clears a newer one.
      const updated = ended
        ? await sql`
            update billing_accounts set plan = null, subscription_status = ${action.status ?? "canceled"}, current_period_end = ${periodEnd}::timestamptz,
                   cancel_at_period_end = false, subscription_event_at = ${eventAt}::timestamptz, updated_at = now()
            where workspace_id = ${who.workspace}
              and (stripe_subscription_id is null or stripe_subscription_id = ${action.subscription})
              and (subscription_event_at is null or subscription_event_at <= ${eventAt}::timestamptz)
            returning workspace_id`
        : await sql`
            update billing_accounts set stripe_subscription_id = ${action.subscription}, plan = ${action.plan}, subscription_status = ${action.status},
                   current_period_end = ${periodEnd}::timestamptz, cancel_at_period_end = ${action.cancelAtPeriodEnd},
                   subscription_event_at = ${eventAt}::timestamptz, updated_at = now()
            where workspace_id = ${who.workspace}
              and (subscription_event_at is null or subscription_event_at <= ${eventAt}::timestamptz)
            returning workspace_id`;
      await audit(
        "billing_subscription_updated",
        { workspace_id: who.workspace, subscription: action.subscription, status: action.status, plan: action.plan, applied: updated.length > 0 },
        who.workspace,
      );
      return { action: action.kind };
    }

    case "invoice_paid": {
      const who = await resolveOwner(sql, action.customer, action.owner);
      if ("error" in who) {
        await audit("billing_needs_attention", { reason: who.error, invoice: action.invoice });
        return { action: "ignore", reason: who.error };
      }
      const offer = action.priceId ? await offerForPriceId(stripeFor(env, deps.fetchFn), action.priceId) : undefined;
      if (offer?.kind !== "subscription") {
        const reason = action.priceId ? "invoice price is not a plan in plans.ts" : "invoice has no subscription line";
        await audit("billing_needs_attention", { reason, workspace_id: who.workspace, invoice: action.invoice }, who.workspace);
        return { action: "ignore", reason };
      }
      const source = `invoice:${action.invoice}`;
      const written = await addLedgerRow(sql, {
        workspaceId: who.workspace,
        amount: offer.monthlyCredits,
        reason: "plan",
        source,
        data: { plan: offer.key, billing_reason: action.billingReason, subscription: action.subscription },
        expiry: { periodEnd: action.periodEnd, rolloverMonths: INCLUDED_CREDIT_ROLLOVER_MONTHS },
      });
      await audit(
        "billing_credited",
        { workspace_id: who.workspace, reason: "plan", plan: offer.key, credits: offer.monthlyCredits, source, duplicate: !written },
        who.workspace,
      );
      return { action: action.kind, credits: written ? offer.monthlyCredits : 0, duplicate_source: !written };
    }

    case "refund":
      return applyRefund(sql, env, action, audit, deps.fetchFn);
  }
}

type Purchase = { workspace_id: string; source: string; amount: string };

async function applyRefund(
  sql: Sql,
  env: Env,
  action: Extract<BillingAction, { kind: "refund" }>,
  audit: (kind: string, data: Record<string, unknown>, ws?: string) => Promise<void>,
  fetchFn?: FetchFn,
): Promise<HandleResult> {
  const known = action.customer
    ? (await sql`select 1 from billing_accounts where stripe_customer_id = ${action.customer}`).length > 0
    : false;
  if (!action.oursByMetadata && !known) {
    const reason = "charge is not a Crusonia purchase (no app metadata, unknown customer)";
    await audit("billing_event_ignored", { reason });
    return { action: "ignore", reason };
  }
  if (!action.paymentIntent) {
    await audit("billing_needs_attention", { reason: "refunded charge has no payment intent", charge: action.charge });
    return { action: "ignore", reason: "no payment intent" };
  }
  // Credit packs remember their PaymentIntent; subscription invoices are found through the Invoice Payments API.
  let purchases = (await sql`
    select workspace_id, source, amount::text from credit_ledger
    where stripe_payment_intent = ${action.paymentIntent} and reason in ('pack', 'plan') and amount > 0`) as Purchase[];
  if (!purchases.length) {
    const payments = await stripeFor(env, fetchFn).get<StripeList<{ id: string; invoice: unknown }>>("/v1/invoice_payments", {
      payment: { type: "payment_intent", payment_intent: action.paymentIntent },
      limit: 10,
    });
    const sources = payments.data.map((p) => idOf(p.invoice)).filter((id): id is string => Boolean(id)).map((id) => `invoice:${id}`);
    if (sources.length) {
      purchases = (await sql`
        select workspace_id, source, amount::text from credit_ledger
        where source = any(${sources}::text[]) and reason = 'plan' and amount > 0`) as Purchase[];
    }
  }
  if (!purchases.length) {
    await audit("billing_needs_attention", { reason: "refund matches no credited purchase", charge: action.charge });
    return { action: "ignore", reason: "no credited purchase for this charge" };
  }

  let clawed = 0;
  for (const p of purchases) {
    const granted = Number(p.amount);
    const target = clawbackTarget(granted, action.amount, action.amountRefunded);
    const source = `refund:${action.charge}:${action.amountRefunded}${purchases.length > 1 ? `:${p.source}` : ""}`;
    const data = { charge: action.charge, amount: action.amount, amount_refunded: action.amountRefunded, granted, clawback_total: target };
    // Serialized per purchase: the row claws back only what earlier refunds of this purchase did not, and never
    // what already expired unused (that was written off by an `expire` row).
    const [, rows] = await sql.transaction([
      sql`select pg_advisory_xact_lock(hashtext(${`refund:${p.source}`}))::text as locked`,
      sql`
        insert into credit_ledger (workspace_id, owner_id, amount, reason, source, purchase_source, data)
        select ${p.workspace_id}, ${p.workspace_id}, -(greatest(${target}::bigint - x.expired, 0) - r.clawed), 'refund', ${source}, ${p.source}, ${JSON.stringify(data)}::jsonb
        from (select coalesce(-sum(amount), 0)::bigint as clawed from credit_ledger where purchase_source = ${p.source} and reason = 'refund') r,
             (select coalesce(-sum(amount), 0)::bigint as expired from credit_ledger where purchase_source = ${p.source} and reason = 'expire') x
        where greatest(${target}::bigint - x.expired, 0) > r.clawed
        on conflict (source) do nothing
        returning amount::text`,
    ]);
    const credits = rows?.[0] ? -Number(rows[0].amount) : 0;
    clawed += credits;
    await audit("billing_clawback", { workspace_id: p.workspace_id, purchase_source: p.source, credits, source, clawback_total: target }, p.workspace_id);
  }
  return { action: "refund", credits: clawed ? -clawed : 0 };
}
