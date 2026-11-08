// REST API under /api: every route requires auth (Clerk session JWT, an API key, or the MCP_TOKEN owner bypass),
// and every request acts on exactly one workspace (src/api/auth.ts).
import { Hono } from "hono";
import type { AppEnv } from "../lib/context.ts";
import { admin } from "./admin.ts";
import { approvals } from "./approvals.ts";
import { requireAuth } from "./auth.ts";
import { billing } from "./billing.ts";
import { dashboard } from "./dashboard.ts";
import { integrations } from "./integrations.ts";
import { keys } from "./keys.ts";
import { leads } from "./leads.ts";
import { companySummary, onboarding, profile } from "./onboarding.ts";
import { settings, suppressions } from "./settings.ts";
import { workflows } from "./workflows.ts";

export const api = new Hono<AppEnv>();

api.use("*", requireAuth);
api.route("/leads", leads);
api.route("/approvals", approvals);
api.route("/workflows", workflows);
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
