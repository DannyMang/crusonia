// Production's domain: the Wrangler config that attaches it without touching staging, the redirects to the one public
// hostname, and no production URL left in the code.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../src/env.ts";
import { canonicalRedirect } from "../src/lib/canonical-host.ts";
import worker from "../src/index.ts";
import { isOwnHost } from "../src/services/web.ts";

const ROOT = join(import.meta.dir, "..");
const PUBLIC_URL = "https://crusonia.dev";
const OLD_HOST = "crusonia.veri-web.workers.dev";
const prod = { PUBLIC_URL, LEGACY_HOSTS: OLD_HOST };

type Config = {
  routes?: { pattern: string; custom_domain?: boolean }[];
  workers_dev?: boolean;
  vars: Record<string, string>;
  assets: { run_worker_first: string[] };
  env: { staging: { name: string; routes?: unknown[]; vars: Record<string, string> } };
};
const config = Bun.JSONC.parse(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8")) as Config;

describe("wrangler.jsonc", () => {
  test("production has the apex and www as custom domains and keeps workers.dev", () => {
    expect(config.routes).toEqual([
      { pattern: "crusonia.dev", custom_domain: true },
      { pattern: "www.crusonia.dev", custom_domain: true },
    ]);
    // Wrangler turns workers.dev off when routes are set unless this is explicit, and LEGACY_HOSTS would stop answering.
    expect(config.workers_dev).toBe(true);
    expect(config.vars.PUBLIC_URL).toBe(PUBLIC_URL);
    expect(config.vars.LEGACY_HOSTS).toBe(OLD_HOST);
  });

  test("staging can't take the domain, and doesn't redirect", () => {
    const { staging } = config.env;
    expect(staging.name).toBe("crusonia-staging");
    // routes are inherited unless overridden: a staging deploy would move crusonia.dev to crusonia-staging.
    expect(staging.routes).toEqual([]);
    expect(staging.vars.PUBLIC_URL).toBe("https://crusonia-staging.veri-web.workers.dev");
    expect(staging.vars.LEGACY_HOSTS).toBe("");
  });

  test('"/" runs the Worker, or a www or old-hostname visitor would get the app instead of the redirect', () => {
    expect(config.assets.run_worker_first).toContain("/");
  });
});

describe("canonicalRedirect", () => {
  const to = (url: string, method = "GET", env: Parameters<typeof canonicalRedirect>[2] = prod) => canonicalRedirect(url, method, env);

  test("www redirects everything to the apex, with path and query", () => {
    expect(to("https://www.crusonia.dev/")).toEqual({ location: "https://crusonia.dev/", status: 301 });
    expect(to("https://www.crusonia.dev/pricing?x=1")).toEqual({ location: "https://crusonia.dev/pricing?x=1", status: 301 });
    expect(to("https://www.crusonia.dev/mcp", "GET")).toEqual({ location: "https://crusonia.dev/mcp", status: 301 });
  });

  test("a POST to www keeps its method", () => {
    expect(to("https://www.crusonia.dev/webhooks/naive", "POST")).toEqual({ location: "https://crusonia.dev/webhooks/naive", status: 308 });
  });

  test("the old hostname redirects pages with their path", () => {
    expect(to(`https://${OLD_HOST}/`)).toEqual({ location: "https://crusonia.dev/", status: 301 });
    expect(to(`https://${OLD_HOST}/app/leads?stage=new`)).toEqual({ location: "https://crusonia.dev/app/leads?stage=new", status: 301 });
    expect(to(`https://${OLD_HOST}/invite/abc`)?.location).toBe("https://crusonia.dev/invite/abc");
    expect(to(`https://${OLD_HOST}/`, "HEAD")?.status).toBe(301);
  });

  test("the old hostname keeps serving machines", () => {
    for (const path of ["/health", "/mcp", "/mcp?role=operator", "/webhooks/naive", "/webhooks/photon/poll", "/api/me"]) {
      expect(to(`https://${OLD_HOST}${path}`, "POST")).toBeNull();
      expect(to(`https://${OLD_HOST}${path}`)).toBeNull();
    }
    // Only whole segments: this is a page.
    expect(to(`https://${OLD_HOST}/apiary`)?.status).toBe(301);
  });

  test("production itself, staging, local dev and previews are served where they are", () => {
    expect(to("https://crusonia.dev/")).toBeNull();
    expect(to("https://crusonia.dev/app")).toBeNull();
    expect(to("http://localhost:8787/")).toBeNull();
    expect(to(`https://app-${OLD_HOST}/`)).toBeNull();
    const staging = { PUBLIC_URL: "https://crusonia-staging.veri-web.workers.dev" };
    expect(to("https://crusonia-staging.veri-web.workers.dev/", "GET", staging)).toBeNull();
    expect(to("https://crusonia-staging.veri-web.workers.dev/app/leads", "GET", staging)).toBeNull();
  });

  test("a PUBLIC_URL that doesn't parse never redirects", () => {
    expect(to("https://www.crusonia.dev/", "GET", { PUBLIC_URL: "" })).toBeNull();
  });
});

describe("the Worker", () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const assets = { fetch: async () => new Response("<!doctype html><title>Crusonia</title>", { headers: { "Content-Type": "text/html" } }) };
  const call = (url: string, env: Partial<Env>, init?: RequestInit) => worker.fetch(new Request(url, init) as never, { ...env, ASSETS: assets } as unknown as Env, ctx);

  test("www and the old hostname answer pages with a 301 before serving anything", async () => {
    for (const [url, location] of [
      ["https://www.crusonia.dev/", "https://crusonia.dev/"],
      [`https://${OLD_HOST}/`, "https://crusonia.dev/"],
      [`https://${OLD_HOST}/sign-in`, "https://crusonia.dev/sign-in"],
    ] as const) {
      const res = await call(url, prod);
      expect(res.status).toBe(301);
      expect(res.headers.get("Location")).toBe(location);
    }
  });

  test("/health answers on the old hostname, and on www it redirects", async () => {
    const old = await call(`https://${OLD_HOST}/health`, prod);
    expect(old.status).toBe(200);
    expect(((await old.json()) as { ok: boolean }).ok).toBe(true);
    expect((await call("https://www.crusonia.dev/health", prod)).status).toBe(301);
  });

  test("an unsigned webhook on the old hostname reaches the handler instead of redirecting", async () => {
    const res = await call(`https://${OLD_HOST}/webhooks/naive`, { ...prod, NAIVE_WEBHOOK_SECRET: "whsec_test" }, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  test("crusonia.dev is the indexed host; previews and local dev are not, on the landing page too", async () => {
    for (const path of ["/", "/app/leads"]) {
      const live = await call(`https://crusonia.dev${path}`, prod);
      expect(live.status).toBe(200);
      expect(live.headers.get("X-Robots-Tag")).toBeNull();
      for (const host of [`https://app-${OLD_HOST}`, "http://localhost:8787"]) {
        const other = await call(`${host}${path}`, prod);
        expect(other.status).toBe(200);
        expect(other.headers.get("X-Robots-Tag")).toBe("noindex");
      }
    }
  });

  test("staging serves its pages as before, with no redirect", async () => {
    const res = await call("https://crusonia-staging.veri-web.workers.dev/", { PUBLIC_URL: "https://crusonia-staging.veri-web.workers.dev" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toBeNull();
  });
});

describe("isOwnHost", () => {
  const own = (url: string) => isOwnHost(prod, new URL(url));

  test("the domain, www, the old hostname and its previews are Crusonia's own", () => {
    for (const url of ["https://crusonia.dev", "https://www.crusonia.dev/pricing", `https://${OLD_HOST}/`, `https://app-${OLD_HOST}/`]) expect(own(url)).toBe(true);
  });

  test("a lookalike of the custom domain is somebody else's site", () => {
    for (const url of ["https://evil-crusonia.dev", "https://crusonia.dev.example.com", "https://other.veri-web.workers.dev"]) expect(own(url)).toBe(false);
  });
});

describe("no production URL in the code", () => {
  const files = (dir: string): string[] =>
    readdirSync(join(ROOT, dir)).flatMap((name) => {
      if (name === "node_modules" || name === "dist") return [];
      const path = join(dir, name);
      return statSync(join(ROOT, path)).isDirectory() ? files(path) : [path];
    });

  test("the old hostname appears only in wrangler.jsonc", () => {
    const found = ["src", "web/src", "bridge", "scripts", "playbooks"]
      .flatMap(files)
      .filter((file) => !/\.(lockb|png|jpg|webp|mp4|webm|woff2?)$/.test(file) && readFileSync(join(ROOT, file), "utf8").includes(OLD_HOST));
    expect(found).toEqual([]);
  });
});
