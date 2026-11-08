// REST API under /api: every route requires auth (Clerk session JWT, an API key, or the MCP_TOKEN owner bypass).
import { Hono } from "hono";
import type { AppEnv } from "../lib/context.ts";
import { approvals } from "./approvals.ts";
import { requireAuth } from "./auth.ts";
import { billing } from "./billing.ts";
import { dashboard } from "./dashboard.ts";
import { experiments } from "./experiments.ts";
import { integrations } from "./integrations.ts";
import { keys } from "./keys.ts";
import { leads } from "./leads.ts";
import { onboarding, profile } from "./onboarding.ts";
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
api.route("/profile", profile);
api.route("/onboarding", onboarding);
api.route("/experiments", experiments);
api.route("/keys", keys);
api.route("/billing", billing);
// CRM sync: /integrations/crm (status), /integrations/sync, /integrations/hubspot/import.
api.route("/integrations", integrations);
