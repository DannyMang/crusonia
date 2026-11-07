import { Hono } from "hono";
import type { Env } from "./env.ts";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.json({ name: "crusonia", ok: true, health: "/health" }));

app.get("/health", (c) =>
  c.json({
    name: "crusonia",
    ok: true,
    database_url_set: Boolean(c.env.DATABASE_URL),
  }),
);

app.notFound((c) => c.json({ ok: false, error: "not_found" }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ ok: false, error: "internal_error" }, 500);
});

export default {
  fetch: app.fetch,
  // Cron "* * * * *" (wrangler.jsonc). No-op until the workflow engine exists.
  async scheduled(_controller, _env, _ctx) {},
} satisfies ExportedHandler<Env>;
