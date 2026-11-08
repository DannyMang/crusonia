# Stripe integration: what's left

Crusonia already creates Stripe-hosted Checkout Sessions in [src/billing/checkout.ts](src/billing/checkout.ts). This records the Checkout Studio settings on that call and the steps left to take live payments.

## Values to replace

None. `mode`, `success_url`, `cancel_url` and `line_items` already use real values.

**Files containing these values:**
- [src/billing/checkout.ts](src/billing/checkout.ts)

| Field | Current value |
|-------|---------------|
| mode | `subscription` for plans, `payment` for credit packs |
| success_url | `<PUBLIC_URL>/app/settings/billing?checkout=success` |
| cancel_url | `<PUBLIC_URL>/app/settings/billing?checkout=cancelled` |
| line_items[].price | Looked up from the offer's Stripe Price |

## Configured parameters

**Files containing these parameters:**
- [src/billing/checkout.ts](src/billing/checkout.ts)

| Parameter | Value |
|-----------|-------|
| ui_mode | `hosted_page` |
| billing_address_collection | `auto` |
| phone_number_collection | `{ enabled: false }` |
| automatic_tax | `{ enabled: false }` |
| allow_promotion_codes | `false` |
| payment_method_collection | `always` (subscriptions only; Stripe refuses it without a recurring price) |
| submit_type | `auto` |
| integration_identifier | `hosted_web_0001` |
| origin_context | `web` |

**Kept on purpose:** `customer`, `metadata`, `subscription_data` and `payment_intent_data` aren't Checkout Studio settings, but the webhook needs them to credit the right workspace, so removing them would break fulfillment.

The Stripe API version stays pinned in [src/providers/stripe.ts](src/providers/stripe.ts). Crusonia calls the REST API directly, with no Stripe SDK.

## Setup and next steps

1. Activate the Stripe account (business and bank details).
2. Create a live restricted key (`rk_live_`). The [README](README.md) lists the permissions under "Going live".
3. Run `bun run setup --stripe --live`, upload `.dev.vars.stripe.live` and the key as Worker secrets, and deploy.
4. Make one real small purchase and check that the credits arrive.

**How it works:** Billing calls `POST /api/billing/checkout`, the Worker creates the session, the customer pays on Stripe's page, and the signed webhook credits the workspace.

**Testing:** in test mode, use card `4242 4242 4242 4242` with any future expiry and any CVC.

**Tax:** `automatic_tax` is off, so Stripe doesn't calculate or collect tax on these sessions.

## Resources

- https://support.stripe.com
- https://docs.stripe.com/mcp
