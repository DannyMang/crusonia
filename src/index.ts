import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { api } from "./api/index.ts";
import { webhooks } from "./api/webhooks.ts";
import type { Env } from "./env.ts";
import { errorBody, toApiError } from "./lib/errors.ts";
import { mcp } from "./mcp/route.ts";
import { runScheduled } from "./services/cron.ts";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.json({ name: "crusonia", ok: true, health: "/health", mcp: "/mcp", api: "/api" }));

app.get("/health", (c) =>
  c.json({
    name: "crusonia",
    ok: true,
    database_url_set: Boolean(c.env.DATABASE_URL),
  }),
);

// MCP endpoint for agents (Claude Code, Cursor, Codex, Naive). Bearer auth: MCP_TOKEN.
app.route("/mcp", mcp);

// REST API for the owner (Clerk session or MCP_TOKEN) and signed provider webhooks.
app.route("/api", api);
app.route("/webhooks", webhooks);

app.notFound((c) => c.json(errorBody("not_found", `No route for ${c.req.method} ${new URL(c.req.url).pathname}`), 404));

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
