// Billing constants shared by the Worker and scripts/setup.ts --stripe. No imports: safe for both runtimes.

/** Events the Stripe webhook endpoint subscribes to; src/billing/webhook.ts handles exactly these. */
export const STRIPE_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "invoice.paid",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
] as const;

export const STRIPE_WEBHOOK_PATH = "/webhooks/stripe";

/** The web app's billing page: Checkout success/cancel and the portal return URL live here. */
export const BILLING_APP_PATH = "/app/settings/billing";

/**
 * Metadata on every Stripe object we create (customers, Checkout Sessions, subscriptions, payment intents).
 * `crusonia_user_id` is the billing owner id. Keys are namespaced (app, crusonia_*) so they never collide with
 * another integration's keys, and the webhook acts only on objects with app=crusonia.
 */
export function crusoniaMetadata(ownerId: string, extra: Record<string, string> = {}): Record<string, string> {
  return { app: "crusonia", crusonia_user_id: ownerId, ...extra };
}
