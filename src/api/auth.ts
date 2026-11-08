// Auth for /api/*: `Authorization: Bearer <token>` where the token is either
//   - MCP_TOKEN (the owner workspace, compared in constant time), or
//   - a workspace API key (`crs_live_...`, created with POST /api/keys; acts on the key's workspace), or
//   - a Clerk session JWT. With CLERK_JWT_KEY (PEM public key) verification is networkless; otherwise
//     @clerk/backend fetches the JWKS with CLERK_SECRET_KEY (cached per isolate).
// Sign-up is open: a verified Clerk user gets their own private workspace on first sign-in (SIGNUPS_OPEN=false
// lets only existing members in; BLOCKED_USER_IDS are refused). A user can belong to several workspaces and names one
// with X-Crusonia-Workspace, which is checked against membership on every request; a key or MCP_TOKEN is bound to its
// own and refuses any other. Every request then acts on exactly one workspace (c.get("workspace")), and every service
// query is filtered by it.
import { verifyToken } from "@clerk/backend";
import type { MiddlewareHandler } from "hono";
import { resolveBearer } from "../auth.ts";
import { ensureAccount } from "../billing/accounts.ts";
import type { Env } from "../env.ts";
import { sqlFor, type AppEnv, type Principal } from "../lib/context.ts";
import { ApiError } from "../lib/errors.ts";
import { isApiKey, type ApiKeyLookup } from "../services/api-keys.ts";
import { OWNER_WORKSPACE, WORKSPACE_HEADER, workspaceForClerkUser, workspaceRef, type Workspace, type WorkspaceRole } from "../services/workspaces.ts";

const list = (raw: string | undefined) =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const looksLikeJwt = (token: string) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);

const claim = (payload: Record<string, unknown>, key: string) =>
  typeof payload[key] === "string" && payload[key] ? (payload[key] as string) : undefined;

/** `lookupApiKey` replaces the database lookup of API keys (tests). */
export async function authenticate(
  env: Env,
  authorization: string | undefined,
  deps: { lookupApiKey?: ApiKeyLookup } = {},
): Promise<Principal> {
  if (!authorization) {
    throw new ApiError(401, "unauthorized", "Missing Authorization header: send `Authorization: Bearer <Clerk session token, API key or MCP_TOKEN>`");
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  if (!match) throw new ApiError(401, "unauthorized", "Authorization header must be `Bearer <token>`");
  const token = match[1]!;

  const bearer = await resolveBearer(env, token, deps.lookupApiKey);
  if (bearer?.kind === "owner_token") return { kind: "owner_token" };
  if (bearer) return { kind: "api_key", keyId: bearer.keyId, name: bearer.name, workspaceId: bearer.workspaceId, agent: bearer.agent };
  if (isApiKey(token)) throw new ApiError(401, "invalid_token", "API key is not valid or was revoked");

  const clerkConfigured = Boolean(env.CLERK_JWT_KEY || env.CLERK_SECRET_KEY);
  if (!looksLikeJwt(token) || !clerkConfigured) {
    throw new ApiError(
      401,
      "invalid_token",
      clerkConfigured || env.MCP_TOKEN ? "Token is not valid" : "No auth is configured: set MCP_TOKEN or CLERK_JWT_KEY / CLERK_SECRET_KEY",
    );
  }

  let payload: Awaited<ReturnType<typeof verifyToken>>;
  try {
    const parties = list(env.CLERK_AUTHORIZED_PARTIES);
    payload = await verifyToken(token, {
      ...(env.CLERK_JWT_KEY ? { jwtKey: env.CLERK_JWT_KEY } : { secretKey: env.CLERK_SECRET_KEY }),
      ...(parties.length ? { authorizedParties: parties } : {}),
    });
  } catch (err) {
    const reason = (err as { reason?: string }).reason;
    throw new ApiError(401, "invalid_token", `Clerk session token is not valid${reason ? ` (${reason})` : ""}`);
  }
  const userId = typeof payload.sub === "string" ? payload.sub : "";
  if (!userId) throw new ApiError(401, "invalid_token", "Clerk session token has no subject");
  const principal: Principal = { kind: "clerk", userId, sessionId: typeof payload.sid === "string" ? payload.sid : null };
  // Present only if the Clerk session token is customized to carry them; GET /api/me fills the rest.
  const claims = payload as unknown as Record<string, unknown>;
  const email = claim(claims, "email") ?? claim(claims, "primary_email");
  const name = claim(claims, "name") ?? claim(claims, "full_name");
  if (email) principal.email = email;
  if (name) principal.name = name;
  return principal;
}

/**
 * The workspace a principal acts on and their role in it. `requested` is the X-Crusonia-Workspace header: never trusted.
 * Clerk users must be members of it (and get a workspace with the free credits on their first sign-in); keys carry
 * theirs and MCP_TOKEN is the owner workspace, so a header naming another is refused. Only Clerk needs the database here.
 */
export async function resolveWorkspace(env: Env, principal: Principal, requested?: string): Promise<{ workspace: Workspace; role: WorkspaceRole }> {
  if (principal.kind === "clerk") {
    const sql = sqlFor(env);
    const ws = await workspaceForClerkUser(sql, env, principal, { ...(requested === undefined ? {} : { requested }), onCreated: (id) => ensureAccount(sql, env, id) });
    return { workspace: workspaceRef(ws.id), role: ws.role };
  }
  const workspace = principal.kind === "owner_token" ? OWNER_WORKSPACE : workspaceRef(principal.workspaceId);
  if (requested !== undefined && requested !== workspace.id) {
    throw new ApiError(403, "workspace_mismatch", "This token belongs to another workspace than the one in X-Crusonia-Workspace");
  }
  return { workspace, role: principal.kind === "owner_token" ? "owner" : "admin" };
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const principal = await authenticate(c.env, c.req.header("authorization"));
  const { workspace, role } = await resolveWorkspace(c.env, principal, c.req.header(WORKSPACE_HEADER));
  c.set("principal", principal);
  c.set("workspace", workspace);
  c.set("role", role);
  await next();
};
