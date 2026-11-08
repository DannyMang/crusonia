// /api/integrations: CRM sync status, manual sync and the HubSpot import (see "CRM sync" in README.md).
// Everything here only queues work; the minute cron does the HubSpot and Notion calls.
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, parseJson, sqlFor, type AppEnv } from "../lib/context.ts";
import { CRM_TARGETS } from "../services/crm-fields.ts";
import { enqueueManualSync, getCrmStatus, requireTarget, startHubSpotImport } from "../services/crm-sync.ts";

export const integrations = new Hono<AppEnv>();

// Without a database: configuration only (queue and last-sync fields are null).
integrations.get("/crm", async (c) => c.json(await getCrmStatus(c.env.DATABASE_URL ? sqlFor(c.env) : null, c.env)));

const SyncBody = z
  .object({
    target: z.enum(CRM_TARGETS),
    lead_ids: z.array(z.string().trim().min(1).max(64)).min(1).max(500).optional(),
  })
  .strict();

// {target, lead_ids?}: the listed leads (even outside the sync scope), or every lead in the scope.
integrations.post("/sync", async (c) => {
  const body = await parseJson(c, SyncBody);
  requireTarget(c.env, body.target, { needsSwitch: true }); // 503 / 409 before touching the database
  return c.json(await enqueueManualSync(sqlFor(c.env), c.env, body), 202);
});

// Queues the import job: contacts, then companies, 100 per cron run. Read-only on HubSpot.
integrations.post("/hubspot/import", async (c) => {
  await parseJson(c, z.object({}).strict());
  requireTarget(c.env, "hubspot", { needsSwitch: false });
  return c.json(await startHubSpotImport(sqlFor(c.env), c.env, actorOf(c.get("principal"))), 202);
});
