// /api/billing: plan, balance and ledger; Stripe Checkout for plans and credit packs; the Customer Portal.
// Uses the /api auth: the workspace pays (the caller's workspace, whichever way they signed in).
import { Hono } from "hono";
import { z } from "zod";
import { requirePaymentsLive } from "../billing/accounts.ts";
import { createCheckout, createPortal, resolveOffer, stripeFor } from "../billing/checkout.ts";
import { getBillingOverview } from "../billing/overview.ts";
import { parseJson, sqlFor, wsOf, type AppEnv } from "../lib/context.ts";

export const billing = new Hono<AppEnv>();

billing.get("/", async (c) => c.json(await getBillingOverview(sqlFor(c.env), c.env, wsOf(c))));

const CheckoutBody = z
  .object({
    plan: z.string().trim().min(1).max(64).optional(),
    pack: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .refine((b) => Boolean(b.plan) !== Boolean(b.pack), { message: "Pass exactly one of plan or pack" });

// -> {url}: redirect the browser there. Credits arrive through the Stripe webhook once the payment is paid.
billing.post("/checkout", async (c) => {
  const body = await parseJson(c, CheckoutBody);
  resolveOffer(body); // 400 unknown_offer before needing Stripe or the database
  stripeFor(c.env); // 503 not_configured before touching the database
  requirePaymentsLive(c.env); // 503 payments_not_live: a Stripe test key on an instance that isn't a test instance
  return c.json(await createCheckout(sqlFor(c.env), c.env, c.get("principal"), wsOf(c), body));
});

// -> {url}: the Stripe Customer Portal (change or cancel the plan, invoices, payment methods).
billing.post("/portal", async (c) => {
  stripeFor(c.env);
  return c.json(await createPortal(sqlFor(c.env), c.env, wsOf(c)));
});
