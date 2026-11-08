// REST API under /api: every route requires auth (Clerk session JWT, an API key, or the MCP_TOKEN owner bypass),
// and every request acts on exactly one workspace (src/api/auth.ts).
import { Hono } from "hono";
import type { AppEnv } from "../lib/context.ts";
import { admin } from "./admin.ts";
import { approvals } from "./approvals.ts";
import { requireAuth } from "./auth.ts";
import { billing } from "./billing.ts";
import { dashboard } from "./dashboard.ts";
import { guardHumanRoutes } from "./guards.ts";
import { importRoutes } from "./import.ts";
import { integrations } from "./integrations.ts";
import { keys } from "./keys.ts";
import { leads } from "./leads.ts";
import { notes } from "./notes.ts";
import { companySummary, onboarding, profile } from "./onboarding.ts";
import { settings, suppressions } from "./settings.ts";
import { tasks } from "./tasks.ts";
import { workflowDefs } from "./workflow-defs.ts";
import { workflows } from "./workflows.ts";

export const api = new Hono<AppEnv>();

api.use("*", requireAuth);
// Decisions an agent holding an API key must not make through REST either (src/api/guards.ts).
guardHumanRoutes(api);
api.route("/leads", leads);
// Notes on a lead and excluding it: /leads/:id/notes, /leads/:id/exclude.
api.route("/leads", notes);
api.route("/approvals", approvals);
// Manual outreach queue: LinkedIn, X, intro and own-mailbox drafts the owner sends personally.
api.route("/tasks", tasks);
api.route("/workflows", workflows);
// Versioned qualification workflows, their runs and run history (separate from /workflows, which Home reads).
api.route("/workflow-definitions", workflowDefs);
// CSV import with a mapping and a duplicate preview.
api.route("/import", importRoutes);
api.route("/settings", settings);
api.route("/suppressions", suppressions);
// Web app: /me, /summary, /status, /replies.
api.route("/", dashboard);
api.route("/company-summary", companySummary);
api.route("/profile", profile);
api.route("/onboarding", onboarding);
api.route("/keys", keys);
api.route("/billing", billing);
// CRM sync: /integrations/crm (status), /integrations/sync, /integrations/hubspot/import.
api.route("/integrations", integrations);
// Platform admins (PLATFORM_ADMIN_USER_IDS, OWNER_CLERK_USER_ID): read-only, audited, cross-workspace runs and traces.
api.route("/admin", admin);
