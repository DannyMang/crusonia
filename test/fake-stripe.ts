// An in-memory Stripe for tests: just the endpoints Crusonia calls, form-decoded like the real API, with
// Idempotency-Key replay. Every request is recorded (method, path, decoded params, raw body) for assertions.
import type { FetchFn } from "../src/providers/http.ts";

type Obj = Record<string, any>;
export type Recorded = { method: string; path: string; params: Obj; raw: string; idempotencyKey: string | null; version: string | null };

/** Decodes `a[b][0][c]=v` form/query pairs into nested objects (numeric keys become arrays). */
export function decodeParams(text: string): Obj {
  const root: Obj = {};
  for (const [key, value] of new URLSearchParams(text)) {
    const parts = key.replace(/\]/g, "").split("[");
    let node: any = root;
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(parts[i + 1]!);
      if (last) node[part] = value;
      else node = node[part] ??= nextIsIndex ? [] : {};
    });
  }
  return root;
}

export function fakeStripe(opts: { invoicePayments?: Record<string, string> } = {}) {
  let n = 0;
  const id = (prefix: string) => `${prefix}_fake${++n}`;
  const products = new Map<string, Obj>();
  const prices = new Map<string, Obj>();
  const portals = new Map<string, Obj>();
  const endpoints = new Map<string, Obj>();
  const customers = new Map<string, Obj>();
  const sessions = new Map<string, Obj>();
  const replay = new Map<string, unknown>();
  const requests: Recorded[] = [];
  const secrets: string[] = [];

  const list = (items: Obj[], params: Obj) => {
    let data = items;
    if (params.starting_after) data = data.slice(data.findIndex((x) => x.id === params.starting_after) + 1);
    const limit = Number(params.limit ?? 10);
    return { object: "list", data: data.slice(0, limit), has_more: data.length > limit };
  };
  const bool = (v: unknown) => v === true || v === "true";
  const err = (status: number, message: string, code = "resource_missing") =>
    new Response(JSON.stringify({ error: { type: "invalid_request_error", code, message } }), { status });

  function route(method: string, path: string, p: Obj): unknown {
    let m: RegExpExecArray | null;
    if (method === "GET" && path === "/v1/prices") {
      const keys: string[] = p.lookup_keys ?? [];
      let items = [...prices.values()].filter((x) => !keys.length || keys.includes(x.lookup_key));
      if (p.active !== undefined) items = items.filter((x) => x.active === bool(p.active));
      const expand = (p.expand ?? []).includes("data.product");
      return list(expand ? items.map((x) => ({ ...x, product: products.get(x.product) })) : items, p);
    }
    if (method === "GET" && (m = /^\/v1\/prices\/([^/]+)$/.exec(path))) return prices.get(m[1]!) ?? err(404, `No such price: '${m[1]}'`);
    if (method === "POST" && path === "/v1/prices") {
      if (p.lookup_key) {
        const holder = [...prices.values()].find((x) => x.lookup_key === p.lookup_key);
        if (holder && !bool(p.transfer_lookup_key)) return err(400, "lookup_key already exists", "lookup_key_exists");
        if (holder) holder.lookup_key = null;
      }
      const price = {
        id: id("price"),
        object: "price",
        active: true,
        currency: p.currency,
        unit_amount: Number(p.unit_amount),
        type: p.recurring ? "recurring" : "one_time",
        recurring: p.recurring ? { interval: p.recurring.interval, interval_count: 1 } : null,
        lookup_key: p.lookup_key ?? null,
        nickname: p.nickname ?? null,
        metadata: p.metadata ?? {},
        product: p.product,
      };
      prices.set(price.id, price);
      return price;
    }
    if (method === "POST" && (m = /^\/v1\/prices\/([^/]+)$/.exec(path))) {
      const price = prices.get(m[1]!);
      if (!price) return err(404, "No such price");
      if (p.active !== undefined) price.active = bool(p.active);
      if (p.metadata) price.metadata = { ...price.metadata, ...p.metadata };
      if (p.nickname !== undefined) price.nickname = p.nickname;
      return price;
    }
    if (method === "GET" && path === "/v1/products") return list([...products.values()], p);
    if (method === "POST" && path === "/v1/products") {
      const product = { id: id("prod"), object: "product", active: true, name: p.name, description: p.description ?? null, metadata: p.metadata ?? {} };
      products.set(product.id, product);
      return product;
    }
    if (method === "POST" && (m = /^\/v1\/products\/([^/]+)$/.exec(path))) {
      const product = products.get(m[1]!);
      if (!product) return err(404, "No such product");
      Object.assign(product, { ...p, active: p.active === undefined ? product.active : bool(p.active), metadata: { ...product.metadata, ...(p.metadata ?? {}) } });
      return product;
    }
    if (method === "GET" && path === "/v1/billing_portal/configurations") {
      let items = [...portals.values()];
      if (p.active !== undefined) items = items.filter((x) => x.active === bool(p.active));
      return list(items, p);
    }
    if (method === "POST" && path === "/v1/billing_portal/configurations") {
      const config = { id: id("bpc"), object: "billing_portal.configuration", active: true, is_default: false, ...p, metadata: p.metadata ?? {} };
      portals.set(config.id, config);
      return config;
    }
    if (method === "POST" && (m = /^\/v1\/billing_portal\/configurations\/([^/]+)$/.exec(path))) {
      const config = portals.get(m[1]!);
      if (!config) return err(404, "No such configuration");
      Object.assign(config, p);
      return config;
    }
    if (method === "POST" && path === "/v1/billing_portal/sessions") {
      if (!customers.has(p.customer)) return err(404, "No such customer");
      return { id: id("bps"), object: "billing_portal.session", url: `https://billing.stripe.com/p/session/${id("test")}`, ...p };
    }
    if (method === "GET" && path === "/v1/webhook_endpoints") return list([...endpoints.values()], p);
    if (method === "POST" && path === "/v1/webhook_endpoints") {
      const secret = `whsec_fake${crypto.randomUUID().replace(/-/g, "")}`;
      secrets.push(secret);
      const endpoint = { id: id("we"), object: "webhook_endpoint", status: "enabled", url: p.url, enabled_events: p.enabled_events, api_version: p.api_version ?? null, metadata: p.metadata ?? {}, description: p.description };
      endpoints.set(endpoint.id, endpoint);
      return { ...endpoint, secret };
    }
    if (method === "POST" && (m = /^\/v1\/webhook_endpoints\/([^/]+)$/.exec(path))) {
      const endpoint = endpoints.get(m[1]!);
      if (!endpoint) return err(404, "No such webhook endpoint");
      Object.assign(endpoint, p);
      return endpoint;
    }
    if (method === "DELETE" && (m = /^\/v1\/webhook_endpoints\/([^/]+)$/.exec(path))) {
      endpoints.delete(m[1]!);
      return { id: m[1], deleted: true };
    }
    if (method === "POST" && path === "/v1/customers") {
      const customer = { id: id("cus"), object: "customer", ...p, metadata: p.metadata ?? {} };
      customers.set(customer.id, customer);
      return customer;
    }
    if (method === "POST" && path === "/v1/checkout/sessions") {
      if (p.customer && !customers.has(p.customer)) return err(404, "No such customer");
      const price = prices.get(p.line_items?.[0]?.price);
      if (!price) return err(400, "No such price");
      const session = { id: id("cs_test"), object: "checkout.session", status: "open", url: `https://checkout.stripe.com/c/pay/${id("cs_test")}`, ...p };
      sessions.set(session.id, session);
      return session;
    }
    if (method === "POST" && (m = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(path))) {
      const session = sessions.get(m[1]!);
      if (!session) return err(404, "No such session");
      session.status = "expired";
      return session;
    }
    if (method === "GET" && path === "/v1/invoice_payments") {
      const pi = p.payment?.payment_intent;
      const invoice = opts.invoicePayments?.[pi];
      return { object: "list", data: invoice ? [{ id: id("inpay"), invoice, payment: { type: "payment_intent", payment_intent: pi } }] : [], has_more: false };
    }
    return err(404, `fake stripe: unmocked ${method} ${path}`, "unmocked");
  }

  const fetch: FetchFn = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const raw = typeof init.body === "string" ? init.body : "";
    const params = decodeParams(method === "POST" ? raw : url.search.slice(1));
    const headers = (init.headers ?? {}) as Record<string, string>;
    const idempotencyKey = headers["Idempotency-Key"] ?? null;
    requests.push({ method, path: url.pathname, params, raw, idempotencyKey, version: headers["Stripe-Version"] ?? null });
    if (idempotencyKey && replay.has(idempotencyKey)) return new Response(JSON.stringify(replay.get(idempotencyKey)), { status: 200 });
    const out = route(method, url.pathname, params);
    if (out instanceof Response) return out;
    if (idempotencyKey) replay.set(idempotencyKey, out);
    return new Response(JSON.stringify(out), { status: 200 });
  };

  return { fetch, requests, products, prices, portals, endpoints, customers, sessions, secrets };
}
export type FakeStripe = ReturnType<typeof fakeStripe>;
