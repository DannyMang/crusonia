// /api/billing mocks in the backend's shape (src/billing/overview.ts). The price list is the real one
// (src/billing/catalog.ts). Scenarios (?mock=):
//   sample        Pro, active, a few purchases and agent usage, credit expiring next month
//   empty         Free with only the signup sample, no Stripe customer yet
//   unconfigured  Stripe not set up: GET works, Checkout and the portal answer 503 not_configured
// Checkout "pays" instantly and returns to /app/settings/billing?checkout=success (a full page load, like Stripe);
// like the real webhook, the credits land a few seconds later so the page's polling can be seen. The mock account
// lives in sessionStorage so it survives that reload.
import { http } from "msw";
import type { Billing, CheckoutInput, LedgerEntry } from "../api.ts";
import { creditFacts, packCatalog, planCatalog } from "../lib/billing.ts";
import { ago, ahead, body, DAY, fail, HOUR, MIN, ok, scenario } from "./util.ts";

const WEBHOOK_LAG_MS = 4_000;

type Pending = { due: number; plan?: string; pack?: string };
type State = { scenario: string; plan: string; ledger: LedgerEntry[]; seq: number; pending: Pending[] };

const STORE = "crusonia.mockBilling";

function seed(): State {
  const s = scenario();
  const row = (id: number, amount: number, reason: string, source: string, data: Record<string, unknown>, at: string): LedgerEntry => ({
    id: String(id),
    amount,
    reason,
    source,
    session_id: reason === "usage" ? `ses_${id}` : null,
    data,
    created_at: at,
  });
  if (s !== "sample") return { scenario: s, plan: "free", seq: 2, pending: [], ledger: [row(1, 300, "grant", "signup:user", { kind: "free_sample" }, ago(2 * DAY))] };
  return {
    scenario: s,
    plan: "pro",
    seq: 8,
    pending: [],
    ledger: [
      row(7, -62, "usage", "usage:ses_7", { purpose: "research", consumed_micro_usd: 310_000 }, ago(3 * HOUR)),
      row(6, -98, "usage", "usage:ses_6", { purpose: "find_leads", consumed_micro_usd: 490_000 }, ago(5 * HOUR)),
      row(5, 5_000, "pack", "checkout:cs_test_5", { pack: "medium", amount_total: 5_000, currency: "usd" }, ago(26 * HOUR)),
      row(4, -60, "usage", "usage:ses_4", { purpose: "research", consumed_micro_usd: 300_000 }, ago(28 * HOUR)),
      row(3, 2_000, "plan", "invoice:in_test_3", { plan: "pro", billing_reason: "subscription_create" }, ago(2 * DAY)),
      row(2, -40, "usage", "usage:ses_2", { purpose: "onboarding", consumed_micro_usd: 200_000 }, ago(2 * DAY + 20 * MIN)),
      row(1, 300, "grant", "signup:user", { kind: "free_sample" }, ago(2 * DAY + HOUR)),
    ],
  };
}

function load(): State {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE) ?? "null") as State | null;
    if (saved && saved.scenario === scenario()) return saved;
  } catch {
    // fall through to a fresh account
  }
  return seed();
}

function save(s: State) {
  try {
    sessionStorage.setItem(STORE, JSON.stringify(s));
  } catch {
    // private mode: the mock account just resets
  }
}

/** The mock account, with any "webhook" deliveries that are due applied. */
function current(): State {
  const s = load();
  const now = Date.now();
  for (const p of s.pending.filter((x) => x.due <= now)) {
    const id = s.seq++;
    const at = new Date(p.due).toISOString();
    const plan = planCatalog().find((x) => x.key === p.plan);
    const pack = packCatalog().find((x) => x.key === p.pack);
    if (plan) {
      s.plan = plan.key;
      s.ledger.unshift({ id: String(id), amount: plan.monthly_credits, reason: "plan", source: `invoice:in_mock_${id}`, session_id: null, data: { plan: plan.key, billing_reason: "subscription_create" }, created_at: at });
    } else if (pack) {
      s.ledger.unshift({ id: String(id), amount: pack.credits, reason: "pack", source: `checkout:cs_mock_${id}`, session_id: null, data: { pack: pack.key }, created_at: at });
    }
  }
  s.pending = s.pending.filter((x) => x.due > now);
  save(s);
  return s;
}

function overview(): Billing {
  const s = current();
  const unconfigured = scenario() === "unconfigured";
  const balance = s.ledger.reduce((sum, r) => sum + r.amount, 0);
  const paid = s.plan !== "free";
  return {
    owner_id: "user_mock",
    billing: { configured: !unconfigured, webhook_configured: !unconfigured, mode: unconfigured ? null : "test", enforced: false },
    plan: {
      key: s.plan,
      name: planCatalog().find((p) => p.key === s.plan)?.name ?? "Free",
      status: paid ? "active" : null,
      current_period_end: paid ? ahead(28 * DAY) : null,
      cancel_at_period_end: false,
    },
    has_customer: s.ledger.some((r) => r.reason === "pack" || r.reason === "plan"),
    balance,
    balance_usd: balance / 100,
    expiring: paid ? [{ credits: 1_200, expires_at: ahead(53 * DAY) }] : [],
    ledger: s.ledger.slice(0, 20),
    plans: planCatalog().map((p) => ({ ...p, current: p.key === s.plan })),
    packs: packCatalog(),
    credit: creditFacts(),
  };
}

const RETURN_URL = "/app/settings/billing?checkout=success";

export const billingHandlers = [
  http.get("/api/billing", () => ok(overview())),

  http.post("/api/billing/checkout", async ({ request }) => {
    if (scenario() === "unconfigured") return fail(503, "not_configured", "STRIPE_SECRET_KEY is not set (needed for billing)");
    const input = await body<CheckoutInput>(request);
    const s = current();
    const plan = "plan" in input ? planCatalog().find((p) => p.key === input.plan && p.checkout) : undefined;
    const pack = "pack" in input ? packCatalog().find((p) => p.key === input.pack) : undefined;
    if (!plan && !pack) return fail(400, "unknown_offer", "Unknown plan or pack. GET /api/billing lists the plans and packs.");
    if (plan && s.plan !== "free") return fail(409, "already_subscribed", "This account already has a subscription. Change or cancel it in the billing portal.");
    // The "webhook": credits land a few seconds after the customer is back.
    s.pending.push({ due: Date.now() + WEBHOOK_LAG_MS, ...(plan ? { plan: plan.key } : { pack: pack!.key }) });
    save(s);
    return ok({ url: RETURN_URL });
  }),

  http.post("/api/billing/portal", () => {
    if (scenario() === "unconfigured") return fail(503, "not_configured", "STRIPE_SECRET_KEY is not set (needed for billing)");
    if (!overview().has_customer) return fail(409, "no_billing_account", "No Stripe customer yet: buy a credit pack or subscribe first.");
    // The real portal is Stripe-hosted; in mocks it just comes back to the billing page.
    return ok({ url: "/app/settings/billing" });
  }),
];
