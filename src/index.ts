import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { api } from "./api/index.ts";
import { webhooks } from "./api/webhooks.ts";
import type { Env } from "./env.ts";
import { errorBody, toApiError } from "./lib/errors.ts";
import { mcp } from "./mcp/route.ts";
import { runScheduled } from "./services/cron.ts";

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------------------------------------
// Web app (static assets) and this Worker share one origin, so there is no CORS. wrangler.jsonc:
//
//   "assets": {
//     "directory": "./web/dist",
//     "binding": "ASSETS",
//     "not_found_handling": "none",
//     "run_worker_first": ["/api/*", "/mcp", "/mcp/*", "/webhooks/*", "/health"]
//   }
//
// Files that exist (index.html at "/", hashed /assets/*, /media/*) are served by Cloudflare without running
// this Worker. Every other path reaches the Worker: API paths are routed below; a missing file under /assets/
// or /media/ is a real 404 (not the app's HTML with a 200, which breaks caches and hides broken links); any
// other path is a client-side route (/app/*, /onboarding/*, /sign-in), so it gets the SPA shell (index.html).
// run_worker_first keeps the API paths on the Worker even where a static file could match, and opts out of
// Cloudflare's Sec-Fetch-Mode navigation heuristic. Do not ship asset files under api/, mcp/, webhooks/ or health.
// Caching for the files themselves is in web/public/_headers.
// ---------------------------------------------------------------------------------------------------------
const API_PATH = /^\/(api|mcp|webhooks|health)(\/|$)/;
// Build output and media: a miss here is a missing file, never an app route.
const STATIC_PATH = /^\/(assets|media)\//;

/** Production is the host in PUBLIC_URL; previews (version and alias URLs) and local dev are everything else. */
function isProductionHost(requestUrl: string, publicUrl: string | undefined) {
  try {
    return new URL(requestUrl).host === new URL(publicUrl ?? "").host;
  } catch {
    return false;
  }
}

/** index.html for a client-side route. Only production is indexed by search engines. */
async function spaShell(c: Context<{ Bindings: Env }>, assets: Fetcher) {
  const res = await assets.fetch(new Request(new URL("/", c.req.url).href, { method: c.req.method === "HEAD" ? "HEAD" : "GET", headers: c.req.raw.headers }));
  if (isProductionHost(c.req.url, c.env.PUBLIC_URL)) return res;
  const out = new Response(res.body, res);
  out.headers.set("X-Robots-Tag", "noindex");
  return out;
}

app.get("/", async (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.json({ name: "crusonia", ok: true, health: "/health", mcp: "/mcp", api: "/api" });
});

app.get("/health", (c) =>
  c.json({
    name: "crusonia",
    ok: true,
    database_url_set: Boolean(c.env.DATABASE_URL),
  }),
);

// MCP endpoint for agents (Claude Code, Cursor, Codex, Naive). Bearer auth: an API key (POST /api/keys) or MCP_TOKEN.
app.route("/mcp", mcp);

// REST API for the owner (Clerk session, API key or MCP_TOKEN) and signed provider webhooks.
app.route("/api", api);
app.route("/webhooks", webhooks);

app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  const assets = c.env.ASSETS;
  // Unknown API paths are JSON 404s. Without the web app deployed, so is everything else.
  if (!assets || API_PATH.test(path)) return c.json(errorBody("not_found", `No route for ${c.req.method} ${path}`), 404);
  if (STATIC_PATH.test(path)) return c.text("Not found", 404, { "Cache-Control": "no-store" });
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.json(errorBody("not_found", `No route for ${c.req.method} ${path}`), 404);
  return spaShell(c, assets);
});

// Every error is JSON: { error: { code, message, details? } }.
app.onError((err, c) => {
  // Protocol errors from the MCP transport (bad Accept/Content-Type, malformed JSON-RPC) carry their own response.
  if (err instanceof HTTPException) return err.getResponse();
  const api = toApiError(err);
  if (api) return c.json(errorBody(api.code, api.message, api.details), api.status);
  console.error(err);
  return c.json(errorBody("internal_error", "Internal error"), 500);
});

export default {
  fetch: app.fetch,
  // Cron "* * * * *" (wrangler.jsonc): expire approvals, reconcile Naive sessions and unconfirmed sends.
  async scheduled(_controller, env, ctx) {
    const quiet = (v: unknown): boolean =>
      v === 0 || typeof v === "string" || (typeof v === "object" && v !== null && !("error" in v) && Object.values(v).every(quiet));
    ctx.waitUntil(
      runScheduled(env).then((report) => {
        if (!quiet(report)) console.log("cron", JSON.stringify(report));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
