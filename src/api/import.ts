// /api/import: CSV import with a mapping and a preview (src/services/import-preview.ts). preview writes nothing;
// commit creates and updates leads. The body's `source` is the cohort.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { actorOf, parseJson, sqlFor, wsOf, type AppEnv } from "../lib/context.ts";
import { errorBody } from "../lib/errors.ts";
import { commitImport, importBodySchema, previewImport } from "../services/import-preview.ts";

export const importRoutes = new Hono<AppEnv>();

// The CSV travels inside JSON: 5 MB of CSV plus the envelope.
importRoutes.use(bodyLimit({ maxSize: 6 * 1024 * 1024, onError: (c) => c.json(errorBody("payload_too_large", "CSV is larger than 5 MB; split it"), 413) }));

importRoutes.post("/preview", async (c) => c.json(await previewImport(sqlFor(c.env), wsOf(c), await parseJson(c, importBodySchema))));

importRoutes.post("/commit", async (c) => {
  const body = await parseJson(c, importBodySchema);
  return c.json(await commitImport(sqlFor(c.env), wsOf(c), body, actorOf(c.get("principal"))));
});
