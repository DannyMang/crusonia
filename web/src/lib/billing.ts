// Billing display helpers shared by the billing page, the sidebar credits pill and /pricing.
// The price list itself comes from the Worker's src/billing/catalog.ts (via /api/billing, or imported directly by
// the signed-out /pricing page), never from numbers typed here.
import type { Billing, LedgerEntry } from "../api.ts";
import { num, plural } from "./format.ts";

export { creditFacts, leadsFor, packCatalog, planCatalog, TYPICAL_LEAD_CREDITS } from "../../../src/billing/catalog.ts";

/** "Crusonia Pro" -> "Pro" (Stripe product names carry the brand; the app does not need it twice). */
export const planLabel = (name: string) => name.replace(/^Crusonia\s+/i, "");

/** Small marketing tags from the pricing design, by plan key. Labels only: prices and credits come from the catalog. */
export const PLAN_TAGS: Record<string, string> = { free: "pay as you go", pro: "recommended", scale: "for teams" };

/** "$20/mo" -> "$20"; "$10" stays. */
export const priceAmount = (price: string) => price.replace(/\/mo$/, "");

/** "$10" from cents. */
export const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** Subscription states that still count as subscribed: Checkout refuses a second plan (409), the portal changes it. */
const LIVE = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);
export const hasLiveSubscription = (b: Pick<Billing, "plan">) => b.plan.key !== "free" && LIVE.has(b.plan.status ?? "");

export type StatusChip = { label: string; tone: "lime" | "amber" | "gray" | "red" };

export function planStatus(b: Pick<Billing, "plan">): StatusChip | null {
  const { key, status, cancel_at_period_end } = b.plan;
  if (key === "free" || !status) return null;
  if (cancel_at_period_end && LIVE.has(status)) return { label: "Cancels at period end", tone: "amber" };
  switch (status) {
    case "active":
      return { label: "Active", tone: "lime" };
    case "trialing":
      return { label: "Trial", tone: "lime" };
    case "past_due":
    case "unpaid":
      return { label: "Payment due", tone: "amber" };
    case "incomplete":
      return { label: "Payment pending", tone: "amber" };
    case "paused":
      return { label: "Paused", tone: "gray" };
    case "canceled":
    case "incomplete_expired":
      return { label: "Ended", tone: "gray" };
    default:
      return { label: status.replace(/_/g, " "), tone: "gray" };
  }
}

/** "+5,000" / "−62" (a real minus sign, so the column lines up with tabular figures). */
export const signedCredits = (n: number) => (n > 0 ? `+${num(n)}` : n < 0 ? `−${num(-n)}` : "0");

const PURPOSE: Record<string, string> = {
  research: "Researched a lead",
  find_leads: "Found leads for your profile",
  onboarding: "Read your website and drafted a profile",
};

/** One ledger row as "what happened" + a detail line. `data` is ours (written by the Worker), shown as text only. */
export function ledgerLine(e: LedgerEntry, b?: Pick<Billing, "plans" | "packs">): { title: string; detail: string } {
  const d = e.data ?? {};
  const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : undefined);
  switch (e.reason) {
    case "grant":
      return str("kind") === "free_sample"
        ? { title: "Free sample", detail: `${plural(e.amount, "free credit")} to try Crusonia` }
        : { title: "Credit grant", detail: "Added by Crusonia" };
    case "pack": {
      const pack = b?.packs.find((p) => p.key === str("pack"));
      return { title: "Credit pack", detail: `${num(pack?.credits ?? e.amount)} credits, paid with Stripe` };
    }
    case "plan": {
      const plan = b?.plans.find((p) => p.key === str("plan"));
      const renewal = str("billing_reason") === "subscription_cycle";
      return { title: `${plan ? planLabel(plan.name) : "Monthly"} plan`, detail: renewal ? "Monthly included credit (renewal)" : "Monthly included credit" };
    }
    case "usage":
      return { title: "Agent time", detail: PURPOSE[str("purpose") ?? ""] ?? "Hosted agent session" };
    case "refund":
      return { title: "Refund", detail: "Credits removed for a refunded payment" };
    case "expire":
      return { title: "Expired credit", detail: "Unused included credit past its rollover month" };
    case "adjustment":
      return { title: "Adjustment", detail: "Balance correction" };
    default:
      return { title: e.reason, detail: "" };
  }
}
