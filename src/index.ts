import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "./env.ts";
import { mcp } from "./mcp/route.ts";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.json({ name: "crusonia", ok: true, health: "/health", mcp: "/mcp" }));

app.get("/health", (c) =>
  c.json({
    name: "crusonia",
    ok: true,
    database_url_set: Boolean(c.env.DATABASE_URL),
  }),
);

// MCP endpoint for agents (Claude Code, Cursor, Codex, Naive). Bearer auth: MCP_TOKEN.
app.route("/mcp", mcp);

app.notFound((c) => c.json({ ok: false, error: "not_found" }, 404));

app.onError((err, c) => {
  // Protocol errors from the MCP transport (bad Accept/Content-Type, malformed JSON-RPC) carry their own response.
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.json({ ok: false, error: "internal_error" }, 500);
});

export default {
  fetch: app.fetch,
  // Cron "* * * * *" (wrangler.jsonc). No-op until the workflow engine exists.
  async scheduled(_controller, _env, _ctx) {},
} satisfies ExportedHandler<Env>;
