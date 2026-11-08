// Routes a person must call themselves. API keys (`crs_live_...`) are handed to agents (Claude Code, Cursor, Codex,
// Naive), and an agent with a shell can call /api directly, not only the MCP tools. So "no MCP tool sends or decides
// an approval" holds only if the REST routes that do those things refuse API keys too. These routes accept a Clerk
// session (the web app) or MCP_TOKEN (the owner's own token; local dev without Clerk), and answer 403 to an API key:
//   - deciding approvals: approve (sends email), reject, edit, answer (allows tools, answers agent questions)
//   - minting and revoking API keys (an agent must not create a key that outlives its own)
//   - granting or changing consent on a lead (consent is what allows email at all)
//   - removing an address from the do-not-contact list
//   - Stripe Checkout and the Customer Portal (a portal link manages billing without signing in)
//   - turning autopilot on or off (it decides whether agents spend on their own)
//   - the team and its invites, and creating or renaming a workspace (an agent must not add people or send email)
// On top of that, members can't manage what belongs to the workspace as a whole: billing, API keys and integrations are
// for owners and admins (and the team, in src/api/team.ts), as is turning autopilot on or off. Reading stays open: the credits pill and the names of the
// keys behind notes are on every member's screen.
import type { Hono, MiddlewareHandler } from "hono";
import type { AppEnv } from "../lib/context.ts";
import { ApiError } from "../lib/errors.ts";
import { requireRole } from "./team.ts";

function refuse(what: string): never {
  throw new ApiError(403, "human_required", `${what} needs a signed-in person (the Crusonia app), not an API key`);
}

/** 403 human_required for API-key callers. */
export const humanOnly =
  (what: string): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (c.get("principal")?.kind === "api_key") refuse(what);
    await next();
  };

/** Only the consent field is refused for API keys: an agent may still create and edit leads. */
export const consentHumanOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("principal")?.kind === "api_key") {
    let body: unknown;
    try {
      // HonoRequest caches the text, so the route's parseJson reads the same body afterwards.
      body = JSON.parse((await c.req.text()) || "{}");
    } catch {
      body = null; // the route answers 400 invalid_json
    }
    if (body && typeof body === "object" && "consent" in body) refuse("Granting or changing consent");
  }
  await next();
};

const WRITE = ["POST", "PUT", "PATCH", "DELETE"];

/** Registers the guards above on the /api router. Call it after auth and before the routes. */
export function guardHumanRoutes(api: Hono<AppEnv>): void {
  api.on(WRITE, "/approvals/*", humanOnly("Deciding an approval"));
  api.on(WRITE, ["/keys", "/keys/*"], humanOnly("Creating or revoking API keys"));
  api.on("POST", "/leads", consentHumanOnly);
  api.on("PATCH", "/leads/:id", consentHumanOnly);
  api.on("DELETE", "/suppressions/*", humanOnly("Removing a suppression"));
  api.on(WRITE, "/billing/*", humanOnly("Billing"));
  api.on(WRITE, "/autopilot", humanOnly("Turning autopilot on or off"));
  api.on(WRITE, "/autopilot", requireRole("admin"));
  api.on(["GET", ...WRITE], ["/team", "/team/*"], humanOnly("The team"));
  api.on(WRITE, ["/workspaces", "/workspaces/*"], humanOnly("Creating or renaming a workspace"));
  api.on(WRITE, ["/keys", "/keys/*"], requireRole("admin"));
  api.on(WRITE, "/billing/*", requireRole("admin"));
  api.on(WRITE, "/integrations/*", requireRole("admin"));
}
