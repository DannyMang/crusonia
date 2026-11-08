// REST API under /api: every route requires auth (Clerk session JWT or the MCP_TOKEN owner bypass).
import { Hono } from "hono";
import type { AppEnv } from "../lib/context.ts";
import { approvals } from "./approvals.ts";
import { requireAuth } from "./auth.ts";
import { leads } from "./leads.ts";
import { settings, suppressions } from "./settings.ts";
import { workflows } from "./workflows.ts";

export const api = new Hono<AppEnv>();

api.use("*", requireAuth);
api.route("/leads", leads);
api.route("/approvals", approvals);
api.route("/workflows", workflows);
api.route("/settings", settings);
api.route("/suppressions", suppressions);

// TODO(experiments): /api/experiments (hypothesis, segment, variants) and per-variant stats.
// TODO(crm-sync): HubSpot and Notion sync endpoints.
