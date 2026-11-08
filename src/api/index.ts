// REST API under /api: every route requires auth (Clerk session JWT, an API key, or the MCP_TOKEN owner bypass),
// and every request acts on exactly one workspace (src/api/auth.ts). Two exceptions come before all of that: the invite
// link, because whoever follows it may not have a workspace yet, and /config, which the signed-out pricing page reads.
import { Hono } from "hono";
import { paymentsLive } from "../billing/accounts.ts";
import type { AppEnv } from "../lib/context.ts";
import { ipLimit } from "../lib/rate-limit.ts";
import { admin } from "./admin.ts";
import { approvals } from "./approvals.ts";
import { autopilot } from "./autopilot.ts";
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
import { inviteLinks, team, workspaces } from "./team.ts";
import { workflowDefs } from "./workflow-defs.ts";
import { workflows } from "./workflows.ts";

export const api = new Hono<AppEnv>();

// What a signed-out visitor may know about this instance. Reads no database.
api.get("/config", (c) => {
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ payments_live: paymentsLive(c.env) });
});

// Must stay above requireAuth: a route registered before a middleware answers without running it. Each link is a database
// lookup anyone can ask for, so they are limited per IP.
api.use("/invites/*", ipLimit<AppEnv>("RL_ANON", "invite"));
api.route("/invites", inviteLinks);
api.use("*", requireAuth);
// Decisions an agent holding an API key must not make through REST either (src/api/guards.ts).
guardHumanRoutes(api);
// What spends money, per IP on top of the workspace's limits (src/services/limits.ts). The owner's own token is exempt.
api.on(
  "POST",
  ["/leads/find", "/workflows/research", "/onboarding/propose", "/onboarding/read-website", "/workflow-definitions/:id/run", "/tasks/:id/regenerate"],
  ipLimit<AppEnv>("RL_PAID", "paid", (c) => c.get("principal").kind === "owner_token"),
);
api.route("/leads", leads);
// Notes on a lead and excluding it: /leads/:id/notes, /leads/:id/exclude.
api.route("/leads", notes);
api.route("/approvals", approvals);
// The workspace's autopilot switch, what its agents are doing, and the tally.
api.route("/autopilot", autopilot);
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
// The workspaces a person belongs to, and the current workspace's members and invites.
api.route("/workspaces", workspaces);
api.route("/team", team);
api.route("/billing", billing);
// CRM sync: /integrations/crm (status), /integrations/sync, /integrations/hubspot/import.
api.route("/integrations", integrations);
// Platform admins (PLATFORM_ADMIN_USER_IDS, OWNER_CLERK_USER_ID): read-only, audited, cross-workspace runs and traces.
api.route("/admin", admin);
