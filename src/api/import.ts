// /api/import: CSV import with a mapping and a preview (src/services/import-preview.ts). preview writes nothing;
// commit creates and updates leads. The body's `source` is the cohort.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { actorOf, parseJson, sqlFor, wsOf, type AppEnv } from "../lib/context.ts";
import { ApiError, errorBody } from "../lib/errors.ts";
import { commitImport, importBodySchema, previewImport } from "../services/import-preview.ts";

export const importRoutes = new Hono<AppEnv>();

// The CSV travels inside JSON: 5 MB of CSV plus the envelope.
importRoutes.use(bodyLimit({ maxSize: 6 * 1024 * 1024, onError: (c) => c.json(errorBody("payload_too_large", "CSV is larger than 5 MB; split it"), 413) }));

importRoutes.post("/preview", async (c) => c.json(await previewImport(sqlFor(c.env), wsOf(c), await parseJson(c, importBodySchema))));

// Consent allows email, so only a person grants it (src/api/guards.ts): an API key may import contacts, but mapping a
// consent column is refused, and guessed consent columns are ignored.
importRoutes.post("/commit", async (c) => {
  const body = await parseJson(c, importBodySchema);
  const principal = c.get("principal");
  const agent = principal.kind === "api_key";
  if (agent && (body.mapping.consent || body.mapping.consent_at || body.mapping.consent_text)) {
    throw new ApiError(403, "human_required", "Importing consent needs a signed-in person (the Crusonia app), not an API key");
  }
  return c.json(await commitImport(sqlFor(c.env), wsOf(c), body, actorOf(principal), { allowConsent: !agent }));
});
