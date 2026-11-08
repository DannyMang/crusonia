import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { api } from "./api/index.ts";
import { webhooks } from "./api/webhooks.ts";
import type { Env } from "./env.ts";
import { errorBody, toApiError } from "./lib/errors.ts";
import { mcp } from "./mcp/route.ts";
import { runScheduled } from "./services/cron.ts";

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------------------------------------
// Web app (static assets) and this Worker share one origin, so there is no CORS. The frontend PR adds the
// `assets` block to wrangler.jsonc. It must keep these paths on the Worker, e.g.:
//
//   "assets": {
//     "directory": "./web/dist",            // wherever the SPA build lands
//     "binding": "ASSETS",
//     "not_found_handling": "single-page-application",
//     "run_worker_first": ["/api/*", "/mcp", "/mcp/*", "/webhooks/*", "/health"]
//   }
//
// Why run_worker_first: in SPA mode a browser navigation (Sec-Fetch-Mode: navigate) that matches no file is
// answered with index.html before the Worker runs, so opening /health or /api/me in a tab would show the app.
// Listing the paths also opts out of that header heuristic. fetch() calls, MCP clients and provider webhooks
// are not navigations, but they stay correct either way. Do not ship asset files under api/, mcp/,
// webhooks/ or health: assets that match a path win over the Worker unless the path is listed above.
// If the Worker does get a non-API request (run_worker_first: true, or a path not listed), "/" and the
// not-found handler below hand it to ASSETS when the binding exists.
// ---------------------------------------------------------------------------------------------------------
const API_PATH = /^\/(api|mcp|webhooks|health)(\/|$)/;

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
  // Unknown API paths are JSON 404s; anything else belongs to the web app when it is deployed (SPA routes).
  if (c.env.ASSETS && !API_PATH.test(path)) return c.env.ASSETS.fetch(c.req.raw);
  return c.json(errorBody("not_found", `No route for ${c.req.method} ${path}`), 404);
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
