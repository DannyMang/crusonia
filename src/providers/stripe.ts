// Thin Stripe REST client (no SDK: keeps the Worker bundle small). Form-encoded requests, a pinned API version,
// and errors that never include the key. Used by the Worker (Checkout, Customer Portal, price lookups) and by
// scripts/setup.ts --stripe (products, prices, portal configuration, webhook endpoint).
import { defaultFetch, type FetchFn } from "./http.ts";

/**
 * Every request and the webhook endpoint (setup passes it as `api_version`) use this version, so request and
 * event payload shapes do not depend on the account's default. Since 2025-03-31.basil: subscription periods are
 * on subscription items, invoices point to their subscription through `parent.subscription_details`, invoice
 * lines carry `pricing.price_details.price` (an id), and charges no longer name their invoice.
 */
export const STRIPE_API_VERSION = "2026-10-28.endive";
export const STRIPE_API_BASE = "https://api.stripe.com";

export type StripeMode = "test" | "live";

/**
 * test / live from a secret (sk_) or restricted (rk_) key: the first `test` or `live` segment, which may follow
 * other segments (sk_live_..., sk_<scope>_live_...). Undefined if it is not such a key or names no mode.
 */
export function stripeKeyMode(key: string | undefined): StripeMode | undefined {
  const m = /^(?:sk|rk)_(?:[A-Za-z0-9]+_)*?(test|live)_\S+$/.exec(key ?? "");
  return m ? (m[1] as StripeMode) : undefined;
}

export class StripeError extends Error {
  constructor(
    message: string,
    /** HTTP status, or undefined when no response arrived. */
    readonly status: number | undefined,
    readonly type?: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

export type StripeParams = Record<string, unknown>;

/**
 * Stripe's form encoding: nested objects as `a[b][c]=v`, arrays as `a[0]=v` (accepted for scalars and objects),
 * booleans as true/false, null as an empty value (Stripe's "unset"), undefined skipped.
 */
export function encodeParams(params: StripeParams): string {
  const out: string[] = [];
  const add = (key: string, value: unknown) => {
    if (value === undefined) return;
    if (value === null) {
      out.push(`${encodeURIComponent(key)}=`);
    } else if (Array.isArray(value)) {
      if (!value.length) out.push(`${encodeURIComponent(key)}=`);
      value.forEach((v, i) => add(`${key}[${i}]`, v));
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) add(`${key}[${k}]`, v);
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return out.join("&");
}

export type StripeList<T> = { object: "list"; data: T[]; has_more: boolean };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class StripeClient {
  constructor(
    private readonly key: string,
    private readonly fetchFn: FetchFn = defaultFetch,
    private readonly baseUrl = STRIPE_API_BASE,
  ) {}

  get mode(): StripeMode | undefined {
    return stripeKeyMode(this.key);
  }

  /**
   * One request. GET, DELETE and POSTs with an Idempotency-Key are retried once when the outcome is unknown
   * (no response, 409 lock, 429, 5xx); Stripe replays a keyed POST instead of acting twice.
   */
  async request<T>(method: "GET" | "POST" | "DELETE", path: string, params: StripeParams = {}, opts: { idempotencyKey?: string } = {}): Promise<T> {
    const query = method === "POST" ? "" : encodeParams(params);
    const url = `${this.baseUrl}${path}${query ? `?${query}` : ""}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.key}`, "Stripe-Version": STRIPE_API_VERSION };
    if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    const init: RequestInit = { method, headers, body: method === "POST" ? encodeParams(params) : undefined };
    const retryable = method !== "POST" || Boolean(opts.idempotencyKey);
    const label = `${method} ${path}`;

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(20_000) });
      } catch (err) {
        if (retryable && attempt === 0) {
          await sleep(500);
          continue;
        }
        throw new StripeError(`stripe ${label}: no response (${err instanceof Error ? err.message : String(err)})`, undefined);
      }
      const text = await res.text();
      if (res.ok) {
        try {
          return (text ? JSON.parse(text) : {}) as T;
        } catch {
          throw new StripeError(`stripe ${label}: response was not JSON`, res.status);
        }
      }
      const shouldRetry = res.headers.get("stripe-should-retry");
      const transient = shouldRetry === "true" || (shouldRetry !== "false" && (res.status === 409 || res.status === 429 || res.status >= 500));
      if (retryable && transient && attempt === 0) {
        await sleep(500);
        continue;
      }
      let error: { message?: string; type?: string; code?: string } = {};
      try {
        error = (JSON.parse(text) as { error?: typeof error }).error ?? {};
      } catch {
        // not JSON: keep the status only
      }
      const kind = [error.type, error.code].filter(Boolean).join("/");
      throw new StripeError(
        `stripe ${label} failed (${res.status}${kind ? ` ${kind}` : ""}): ${(error.message ?? text).slice(0, 300)}`,
        res.status,
        error.type,
        error.code,
      );
    }
  }

  get<T>(path: string, params?: StripeParams) {
    return this.request<T>("GET", path, params);
  }

  post<T>(path: string, params?: StripeParams, idempotencyKey?: string) {
    return this.request<T>("POST", path, params, idempotencyKey ? { idempotencyKey } : {});
  }

  del<T>(path: string) {
    return this.request<T>("DELETE", path);
  }

  /** Every item of a list endpoint (cursor pagination), up to `max`. */
  async list<T extends { id: string }>(path: string, params: StripeParams = {}, max = 1000): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    while (out.length < max) {
      const page = await this.get<StripeList<T>>(path, { ...params, limit: 100, ...(after ? { starting_after: after } : {}) });
      out.push(...page.data);
      if (!page.has_more || !page.data.length) break;
      after = page.data.at(-1)!.id;
    }
    return out;
  }
}

// ---------- the object shapes we read (only the fields we use) ----------

export type StripeMetadata = Record<string, string>;

export type StripePrice = {
  id: string;
  object: "price";
  active: boolean;
  currency: string;
  unit_amount: number | null;
  type: "one_time" | "recurring";
  recurring: { interval: string; interval_count: number } | null;
  lookup_key: string | null;
  metadata: StripeMetadata;
  product: string | StripeProduct;
};

export type StripeProduct = {
  id: string;
  object: "product";
  active: boolean;
  name: string;
  description: string | null;
  metadata: StripeMetadata;
};
