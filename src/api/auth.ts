// Auth for /api/*: `Authorization: Bearer <token>` where the token is either
//   - MCP_TOKEN (owner/dev bypass, compared in constant time), or
//   - a Clerk session JWT. With CLERK_JWT_KEY (PEM public key) verification is networkless; otherwise
//     @clerk/backend fetches the JWKS with CLERK_SECRET_KEY (cached per isolate).
// Single workspace for now: a verified Clerk user must also be in CLERK_ALLOWED_USER_IDS, so signing up
// alone never grants access to the owner's data.
// TODO(workspaces): map Clerk users/orgs to workspaces and scope every query once multi-tenancy is decided.
import { verifyToken } from "@clerk/backend";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env.ts";
import { secretEquals } from "../lib/crypto.ts";
import type { AppEnv, Principal } from "../lib/context.ts";
import { ApiError } from "../lib/errors.ts";

const list = (raw: string | undefined) =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const looksLikeJwt = (token: string) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);

export async function authenticate(env: Env, authorization: string | undefined): Promise<Principal> {
  if (!authorization) {
    throw new ApiError(401, "unauthorized", "Missing Authorization header: send `Authorization: Bearer <Clerk session token or MCP_TOKEN>`");
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  if (!match) throw new ApiError(401, "unauthorized", "Authorization header must be `Bearer <token>`");
  const token = match[1]!;

  if (env.MCP_TOKEN && (await secretEquals(token, env.MCP_TOKEN))) return { kind: "owner_token" };

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
  return { kind: "clerk", userId, sessionId: typeof payload.sid === "string" ? payload.sid : null };
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("principal", await authenticate(c.env, c.req.header("authorization")));
  await next();
};
