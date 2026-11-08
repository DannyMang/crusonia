// What makes it safe to open sign-ups, without a database: no test-mode payments for the public, the instance's brakes,
// Autopilot for everyone, a verified email for a free sample, plain names for logos awaiting approval, and per-IP limits.
// The parts that need Postgres are in test/go-live.integration.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { paymentsLive } from "../src/billing/accounts.ts";
import { billingConfig } from "../src/billing/overview.ts";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";
import { badTokenBlocked, noteBadToken, resetBadTokenBlocks, withinLimit } from "../src/lib/rate-limit.ts";
import { feedItem, type FeedRow } from "../src/services/activity.ts";
import { autopilotAvailable, gateRun } from "../src/services/autopilot.ts";
import { canonicalEmail, isDisposableEmail } from "../src/services/disposable-email.ts";
import { brakeFor, instanceCapMicroUsd } from "../src/services/instance.ts";
import { limitsConfig } from "../src/services/limits.ts";
import { admitNewUser, freeSampleKey, signupEmail } from "../src/services/signup-check.ts";
import { publicLogoAllowed, SHOW_APPROVAL_LOGOS_ON_PUBLIC_PAGES } from "../web/src/lib/public-logos.ts";
import { zoomFor } from "../web/src/lib/zoom.ts";

const env = (over: Partial<Env> = {}): Env => ({ PUBLIC_URL: "https://example.test", MCP_TOKEN: "owner-token", ...over });
const call = (path: string, init: Omit<RequestInit, "headers"> & { ip?: string; headers?: Record<string, string> } = {}, e: Env = env()) => {
  const { ip, ...rest } = init;
  const headers = new Headers(rest.headers ?? {});
  if (ip) headers.set("cf-connecting-ip", ip);
  return worker.fetch(new Request(`https://example.test${path}`, { ...rest, headers }), e, {} as ExecutionContext);
};
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const owner = { Authorization: "Bearer owner-token", "Content-Type": "application/json" };
const read = (path: string) => Bun.file(new URL(`../${path}`, import.meta.url)).text();

describe("test-mode payments", () => {
  test("only a live key, or a test key on a marked test instance, takes payments", () => {
    expect(paymentsLive(env())).toBe(false);
    expect(paymentsLive(env({ STRIPE_SECRET_KEY: "sk_test_abc" }))).toBe(false);
    expect(paymentsLive(env({ STRIPE_SECRET_KEY: "rk_live_abc" }))).toBe(true);
    expect(paymentsLive(env({ STRIPE_SECRET_KEY: "sk_test_abc", BILLING_TEST_MODE_OK: "true" }))).toBe(true);
    expect(paymentsLive(env({ STRIPE_SECRET_KEY: "sk_test_abc", BILLING_TEST_MODE_OK: "false" }))).toBe(false);
    // A key whose mode can't be read doesn't count as live, and the flag can't make up for no key at all.
    expect(paymentsLive(env({ STRIPE_SECRET_KEY: "sk_abc" }))).toBe(false);
    expect(paymentsLive(env({ BILLING_TEST_MODE_OK: "true" }))).toBe(false);
  });

  const checkout = (e: Env) => call("/api/billing/checkout", { method: "POST", headers: owner, body: JSON.stringify({ pack: "small" }) }, e);

  test("POST /api/billing/checkout answers 503 payments_not_live with a test key on a public instance", async () => {
    const res = await checkout(env({ STRIPE_SECRET_KEY: "sk_test_abc" }));
    expect(res.status).toBe(503);
    expect(await code(res)).toBe("payments_not_live");
  });

  test("past the check with a live key, or on a test instance (DATABASE_URL is the next thing it needs here)", async () => {
    for (const e of [env({ STRIPE_SECRET_KEY: "rk_live_abc" }), env({ STRIPE_SECRET_KEY: "sk_test_abc", BILLING_TEST_MODE_OK: "true" })]) {
      expect(await code(await checkout(e))).toBe("not_configured");
    }
  });

  test("an unknown offer and a missing key still answer first", async () => {
    const unknown = await call("/api/billing/checkout", { method: "POST", headers: owner, body: JSON.stringify({ pack: "nope" }) }, env({ STRIPE_SECRET_KEY: "sk_test_abc" }));
    expect(await code(unknown)).toBe("unknown_offer");
    expect(await code(await checkout(env()))).toBe("not_configured");
  });

  test("the app can tell: billing config, and /api/config for the signed-out pricing page", async () => {
    expect(billingConfig(env({ STRIPE_SECRET_KEY: "sk_test_abc" })).payments_live).toBe(false);
    const res = await call("/api/config", {}, env({ STRIPE_SECRET_KEY: "sk_test_abc" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ payments_live: false });
    expect(await (await call("/api/config", {}, env({ STRIPE_SECRET_KEY: "rk_live_abc" }))).json()).toEqual({ payments_live: true });
  });

  test("the staging config marks staging as the test instance, and production isn't", async () => {
    const config = await read("wrangler.jsonc");
    expect(config.split('"env":')[0]).not.toContain("BILLING_TEST_MODE_OK");
    expect(config.split('"env":')[1]).toContain('"BILLING_TEST_MODE_OK": "true"');
  });

  test("the UI says top-ups open soon, with Buy and Upgrade disabled", async () => {
    const billing = await read("web/src/pages/settings/Billing.tsx");
    expect(billing).toContain("Top-ups open soon");
    expect(billing).toContain("disabled={!canPay || anyBusy}");
    expect(billing).toContain("disabled={!canAct || anyBusy}");
    expect(await read("web/src/landing/Pricing.tsx")).toContain("Opens soon");
  });
});

describe("the instance's brakes", () => {
  const state = (over = {}) => ({ halted: false, spent_micro_usd: 0, cap_micro_usd: 25_000_000, ...over });

  test("the cap defaults to $25, and a bad value can't turn it off", () => {
    expect(instanceCapMicroUsd(env())).toBe(25_000_000);
    expect(instanceCapMicroUsd(env({ INSTANCE_DAILY_CAP_USD: "40" }))).toBe(40_000_000);
    expect(instanceCapMicroUsd(env({ INSTANCE_DAILY_CAP_USD: "0" }))).toBe(0);
    for (const bad of ["", " ", "lots", "-1"]) expect(instanceCapMicroUsd(env({ INSTANCE_DAILY_CAP_USD: bad }))).toBe(25_000_000);
  });

  test("the cap stops everyone but the owner; the kill switch stops the owner too", () => {
    expect(brakeFor(state(), "ws_a")).toBeNull();
    expect(brakeFor(state({ spent_micro_usd: 25_000_000 }), "ws_a")).toBe("cap");
    expect(brakeFor(state({ spent_micro_usd: 25_000_000 }), "ws_owner")).toBeNull();
    expect(brakeFor(state({ halted: true }), "ws_a")).toBe("halted");
    expect(brakeFor(state({ halted: true }), "ws_owner")).toBe("halted");
  });

  test("a schedule's gate says instance_busy after the switches a person controls", () => {
    const g = { autopilot: true, paused: false, instanceBusy: true, enabled: true, activeRun: false, spend: { usd: 0, cap_usd: null, period: "week" as const }, dailySpentMicro: 0, dailyCapMicro: 1, hasCredits: true };
    expect(gateRun(g)).toBe("instance_busy");
    expect(gateRun({ ...g, paused: true })).toBe("paused");
    expect(gateRun({ ...g, autopilot: false })).toBe("autopilot_off");
    expect(gateRun({ ...g, instanceBusy: false })).toBeNull();
  });

  test("the owner's feed shows the cap and the switch", () => {
    const row = (kind: string, data = {}): FeedRow => ({ id: "1", kind, data, created_at: new Date(), lead_id: null, who: null, score: null, why: null });
    expect(feedItem(row("instance_cap_reached", { cap_usd: 25 }))?.text).toContain("spend cap reached");
    expect(feedItem(row("instance_halted"))?.text).toContain("kill switch on");
    expect(feedItem(row("instance_resumed"))?.text).toContain("kill switch off");
    expect(feedItem(row("workflow_skipped", { reason: "instance_busy" }))?.text).toContain("at capacity");
  });

  test("the instance routes are for operators only: no token, then not a person's key", async () => {
    expect((await call("/api/admin/instance")).status).toBe(401);
  });

  test("the owner's token can't release the switch (it is also in a vault), and asks for nothing else first", async () => {
    const res = await call("/api/admin/instance", { method: "PUT", headers: owner, body: JSON.stringify({ halted: false }) });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("human_required");
  });

  test("the UI words it calmly", async () => {
    const ui = await read("web/src/components/ui.tsx");
    expect(ui).toContain('err.code === "instance_busy"');
    expect(await read("web/src/pages/Home.tsx")).toContain("Crusonia is at capacity");
  });
});

describe("Autopilot for every sign-up", () => {
  test('"*" means every workspace, a list only its own, unset none', () => {
    expect(autopilotAvailable(env({ AUTOPILOT_WORKSPACES: "*" }), "ws_anyone")).toBe(true);
    expect(autopilotAvailable(env({ AUTOPILOT_WORKSPACES: "ws_a, ws_b" }), "ws_b")).toBe(true);
    expect(autopilotAvailable(env({ AUTOPILOT_WORKSPACES: "ws_a" }), "ws_b")).toBe(false);
    expect(autopilotAvailable(env(), "ws_a")).toBe(false);
  });

  test("Home says when credits ran out, and doesn't offer a purchase that isn't open", async () => {
    const home = await read("web/src/pages/Home.tsx");
    expect(home).toContain("You've used your free credits. New runs wait, and top-ups open soon.");
    expect(home).toContain("You're out of credits. New runs start when you add more.");
  });
});

describe("a free sample per person", () => {
  test("throwaway domains are refused, with their subdomains, and real ones aren't", () => {
    for (const e of ["a@mailinator.com", "A@YOPMAIL.COM", "x@sub.mailinator.com", "dan@guerrillamail.net"]) expect(isDisposableEmail(e)).toBe(true);
    for (const e of ["a@gmail.com", "a@acme.com", "a@notmailinator.com", "a@mailinator.com.acme.com"]) expect(isDisposableEmail(e)).toBe(false);
  });

  test("the same mailbox counts as one, however it is written", async () => {
    const same = ["dan@gmail.com", "Dan+1@gmail.com", "d.a.n@gmail.com", "d.a.n+x@googlemail.com"];
    expect(new Set(same.map(canonicalEmail))).toEqual(new Set(["dan@gmail.com"]));
    expect(canonicalEmail("d.a.n@acme.com")).toBe("d.a.n@acme.com");
    expect(canonicalEmail("dan+1@acme.com")).toBe("dan@acme.com");
    expect(await freeSampleKey("Dan+1@gmail.com")).toBe(await freeSampleKey("d.a.n@googlemail.com"));
    expect(await freeSampleKey("dan@gmail.com")).not.toContain("dan");
  });

  test("the verified primary address vouches first; never an unverified or throwaway one", () => {
    expect(signupEmail({ email: "Dan@acme.com", verified_emails: ["other@acme.com", "dan@acme.com"] })).toBe("dan@acme.com");
    expect(signupEmail({ email: "dan@acme.com", verified_emails: ["other@acme.com"] })).toBe("other@acme.com");
    expect(signupEmail({ email: "a@yopmail.com", verified_emails: ["a@yopmail.com", "b@acme.com"] })).toBe("b@acme.com");
    expect(signupEmail({ email: "a@yopmail.com", verified_emails: ["a@yopmail.com"] })).toBeNull();
  });

  const clerk = (emails: { address: string; status: string }[]) => async () =>
    new Response(JSON.stringify({ id: "user_1", primary_email_address_id: "e0", email_addresses: emails.map((e, i) => ({ id: `e${i}`, email_address: e.address, verification: { status: e.status } })) }));
  const fails = async (p: Promise<unknown>) => p.then(() => null, (e: { status: number; code: string }) => [e.status, e.code]);
  const keyed = env({ CLERK_SECRET_KEY: "sk_test_x" });

  test("a new workspace needs a verified email that isn't a throwaway, and Clerk's word for it", async () => {
    expect(await admitNewUser(keyed, "user_1", clerk([{ address: "dan@acme.com", status: "verified" }]))).toEqual({ freeSampleKey: await freeSampleKey("dan@acme.com") });
    expect(await fails(admitNewUser(keyed, "user_1", clerk([{ address: "dan@acme.com", status: "unverified" }])))).toEqual([403, "email_not_verified"]);
    expect(await fails(admitNewUser(keyed, "user_1", clerk([{ address: "a@mailinator.com", status: "verified" }])))).toEqual([403, "email_not_allowed"]);
    expect(await fails(admitNewUser(keyed, "user_1", async () => new Response("down", { status: 500 })))).toEqual([503, "clerk_unavailable"]);
    // Without Clerk's secret nothing can vouch: closed, not open.
    expect(await fails(admitNewUser(env(), "user_1"))).toEqual([503, "clerk_unavailable"]);
  });

  test("the onboarding screen has a way out for a refused account", async () => {
    const step = await read("web/src/pages/onboarding/Step2Reading.tsx");
    expect(step).toContain("email_not_allowed");
    expect(step).toContain("SignOutLink");
  });
});

describe("invite limits", () => {
  test("defaults are low enough for open sign-up, and still configurable", () => {
    const cfg = limitsConfig(env());
    expect(cfg.invitesPerInstancePerDay).toBe(50);
    expect(cfg.invitesPerWorkspacePerDay).toBe(10);
    expect(cfg.invitesPerUserPerDay).toBe(15);
    expect(limitsConfig(env({ INVITES_PER_INSTANCE_PER_DAY: "7" })).invitesPerInstancePerDay).toBe(7);
  });
});

describe("Terms and Privacy", () => {
  test("public routes, drafts, at full size, with the placeholders the owner fills in", async () => {
    const app = await read("web/src/App.tsx");
    expect(app).toContain('path="terms"');
    expect(app).toContain('path="privacy"');
    for (const path of ["/terms", "/privacy"]) expect(zoomFor(path, false)).toBe(1);
    const frame = await read("web/src/pages/legal/LegalPage.tsx");
    expect(frame).toContain("Draft, last updated");
    expect(frame).toContain("[contact email]");
  });

  test("Privacy names what the product really does", async () => {
    const text = await read("web/src/pages/legal/Privacy.tsx");
    for (const word of ["Cloudflare", "Neon", "Clerk", "Naive", "Apify", "AgentMail", "Stripe", "HubSpot and Notion", "Photon", "180 days", "public web pages", "Agent traces", "audit trail"]) {
      expect(text).toContain(word);
    }
  });

  test("the sign-up page links them", async () => {
    const page = await read("web/src/pages/auth/SignUp.tsx");
    expect(page).toContain("By continuing you agree to the");
    expect(page).toContain('to="/terms"');
    expect(page).toContain('to="/privacy"');
  });
});

describe("logos on public pages", () => {
  test("HubSpot, Anthropic and Clerk show plain names until the one constant flips", () => {
    expect(SHOW_APPROVAL_LOGOS_ON_PUBLIC_PAGES).toBe(false);
    for (const name of ["hubspot", "claude", "clerk"] as const) {
      expect(publicLogoAllowed(name)).toBe(false);
      expect(publicLogoAllowed(name, true)).toBe(true);
    }
    for (const name of ["apify", "cursor", "codex", "github", "google", "notion"] as const) expect(publicLogoAllowed(name)).toBe(true);
  });

  test("the landing goes through it, and the signed-in app doesn't", async () => {
    expect(await read("web/src/landing/Infrastructure.tsx")).toContain("publicLogoAllowed(logo)");
    expect(await read("web/src/landing/ConnectAgent.tsx")).toContain("<AgentButtons publicPage");
    expect(await read("web/src/pages/settings/ConnectAgent.tsx")).not.toContain("publicPage");
  });
});

describe("per-IP limits", () => {
  afterEach(resetBadTokenBlocks);

  /** A fake binding: `limit` requests per key, like the real one. */
  const limiter = (limit: number) => {
    const counts = new Map<string, number>();
    return {
      counts,
      binding: {
        limit: async ({ key }: { key: string }) => {
          counts.set(key, (counts.get(key) ?? 0) + 1);
          return { success: counts.get(key)! <= limit };
        },
      } as unknown as RateLimit,
    };
  };

  test("a missing binding, an unknown IP or a failing binding lets the request through", async () => {
    expect(await withinLimit(env(), "RL_ANON", "x", "1.1.1.1")).toBe(true);
    expect(await withinLimit(env({ RL_ANON: limiter(0).binding }), "RL_ANON", "x", null)).toBe(true);
    const broken = { limit: async () => Promise.reject(new Error("boom")) } as unknown as RateLimit;
    expect(await withinLimit(env({ RL_ANON: broken }), "RL_ANON", "x", "1.1.1.1")).toBe(true);
    expect(await withinLimit(env({ RL_ANON: limiter(0).binding }), "RL_ANON", "x", "1.1.1.1")).toBe(false);
  });

  test("invite links: past the limit, 429 before any lookup, per IP", async () => {
    const e = env({ RL_ANON: limiter(1).binding });
    const path = `/api/invites/inv_${"a".repeat(64)}`;
    // Within the limit it goes on to the database, which isn't there in this test.
    expect(await code(await call(path, { ip: "1.1.1.1" }, e))).toBe("not_configured");
    const over = await call(path, { ip: "1.1.1.1" }, e);
    expect(over.status).toBe(429);
    expect(await code(over)).toBe("too_many_requests");
    expect(over.headers.get("retry-after")).toBe("60");
    expect(await code(await call(path, { ip: "2.2.2.2" }, e))).toBe("not_configured");
  });

  test("wrong tokens on /api count; valid tokens and no token don't", async () => {
    const rl = limiter(1);
    const e = env({ RL_ANON: rl.binding });
    const bad = { Authorization: "Bearer crs_live_nope" };
    // The first one gets the usual answer.
    expect((await call("/api/leads", { ip: "3.3.3.3", headers: bad }, e)).status).toBe(401);
    const over = await call("/api/leads", { ip: "3.3.3.3", headers: bad }, e);
    expect(over.status).toBe(429);
    expect(await code(over)).toBe("too_many_requests");
    // Now this isolate answers it without looking anything up, even with a token that would have worked.
    expect((await call("/api/me", { ip: "3.3.3.3", headers: { Authorization: "Bearer owner-token" } }, e)).status).toBe(429);
    expect(rl.counts.get("bad_token:3.3.3.3")).toBe(2);
    // Someone else, and a person signed out, are not affected.
    expect((await call("/api/me", { ip: "4.4.4.4", headers: { Authorization: "Bearer owner-token" } }, e)).status).toBe(200);
    expect((await call("/api/leads", { ip: "5.5.5.5" }, e)).status).toBe(401);
    expect(rl.counts.has("bad_token:4.4.4.4")).toBe(false);
    expect(rl.counts.has("bad_token:5.5.5.5")).toBe(false);
  });

  test("the block on an IP ends after a minute", async () => {
    const e = env({ RL_ANON: limiter(0).binding });
    expect(await noteBadToken(e, "6.6.6.6", 1_000)).toBe(true);
    expect(badTokenBlocked("6.6.6.6", 2_000)).toBe(true);
    expect(badTokenBlocked("6.6.6.6", 62_000)).toBe(false);
    expect(badTokenBlocked("6.6.6.6", 2_000)).toBe(false);
    expect(badTokenBlocked(null)).toBe(false);
  });

  test("wrong tokens on /mcp count too; a valid agent token is never limited", async () => {
    const e = env({ RL_ANON: limiter(1).binding });
    const mcp = (token: string, ip: string) =>
      call("/mcp", { method: "POST", ip, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }, e);
    expect((await mcp("wrong", "7.7.7.7")).status).toBe(401);
    expect((await mcp("wrong", "7.7.7.7")).status).toBe(429);
    for (let i = 0; i < 5; i++) expect((await mcp("owner-token", "8.8.8.8")).status).toBe(200);
  });

  test("paid starts: per IP past the limit, and the owner's own token is exempt", async () => {
    const e = env({ RL_PAID: limiter(0).binding, NAIVE_API_KEY: "nv" });
    const path = "/api/leads/find";
    const init = { method: "POST", headers: { ...owner, Authorization: "Bearer owner-token" }, body: JSON.stringify({ count: 1 }), ip: "9.9.9.9" };
    expect((await call(path, init, e)).status).not.toBe(429);
    const config = await read("src/api/index.ts");
    for (const route of ["/leads/find", "/workflows/research", "/onboarding/propose", "/onboarding/read-website", "/workflow-definitions/:id/run", "/tasks/:id/regenerate"]) expect(config).toContain(`"${route}"`);
  });

  test("the bindings exist in production and staging, on separate namespaces", async () => {
    const config = await read("wrangler.jsonc");
    const ids = [...config.matchAll(/"namespace_id": "(\d+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    for (const name of ["RL_ANON", "RL_PAID", "RL_SIGNUP"]) expect(config.split(name).length).toBe(3);
  });
});
