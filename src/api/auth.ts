// Auth for /api/*: `Authorization: Bearer <token>` where the token is either
//   - MCP_TOKEN (owner/dev bypass, compared in constant time), or
//   - a per-user API key (`crs_live_...`, created with POST /api/keys; same access as MCP_TOKEN), or
//   - a Clerk session JWT. With CLERK_JWT_KEY (PEM public key) verification is networkless; otherwise
//     @clerk/backend fetches the JWKS with CLERK_SECRET_KEY (cached per isolate).
// Single workspace for now: a verified Clerk user must also be in CLERK_ALLOWED_USER_IDS, so signing up
// alone never grants access to the owner's data.
// TODO(workspaces): map Clerk users/orgs to workspaces and scope every query once multi-tenancy is decided.
import { verifyToken } from "@clerk/backend";
import type { MiddlewareHandler } from "hono";
import { resolveBearer } from "../auth.ts";
import type { Env } from "../env.ts";
import type { AppEnv, Principal } from "../lib/context.ts";
import { ApiError } from "../lib/errors.ts";
import { isApiKey, type ApiKeyLookup } from "../services/api-keys.ts";

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
  if (bearer) return bearer;
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
  if (!list(env.CLERK_ALLOWED_USER_IDS).includes(userId)) {
    throw new ApiError(403, "forbidden", "This Clerk user is not allowed (single-workspace mode: add the user id to CLERK_ALLOWED_USER_IDS)");
  }
  const principal: Principal = { kind: "clerk", userId, sessionId: typeof payload.sid === "string" ? payload.sid : null };
  // Present only if the Clerk session token is customized to carry them; GET /api/me fills the rest.
  const claims = payload as unknown as Record<string, unknown>;
  const email = claim(claims, "email") ?? claim(claims, "primary_email");
  const name = claim(claims, "name") ?? claim(claims, "full_name");
  if (email) principal.email = email;
  if (name) principal.name = name;
  return principal;
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("principal", await authenticate(c.env, c.req.header("authorization")));
  await next();
};
