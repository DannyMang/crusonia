import type { MiddlewareHandler } from "hono";
import { getSql } from "./db.ts";
import type { Env } from "./env.ts";
import { secretEquals } from "./lib/crypto.ts";
import { isApiKey, verifyApiKey, type ApiKeyLookup } from "./services/api-keys.ts";
import { OWNER_WORKSPACE_ID, workspaceRef, type Workspace } from "./services/workspaces.ts";

// Bearer tokens accepted by /mcp and /api: the shared MCP_TOKEN (the owner workspace) or a workspace API key
// (`crs_live_...`, see src/services/api-keys.ts), looked up by its SHA-256 hash. Each resolves to one workspace.

export type BearerIdentity =
  | { kind: "owner_token"; workspaceId: string }
  | { kind: "api_key"; keyId: string; name: string; workspaceId: string; agent: boolean };

/** True when the server can check API keys (they live in the database). */
export const apiKeysAvailable = (env: Env, lookup?: ApiKeyLookup) => Boolean(lookup || env.DATABASE_URL);

/**
 * MCP_TOKEN (constant-time compare) or an active API key. Null when the token is neither. `lookup` replaces
 * the database lookup (tests).
 */
export async function resolveBearer(env: Env, token: string, lookup?: ApiKeyLookup): Promise<BearerIdentity | null> {
  if (env.MCP_TOKEN && (await secretEquals(token, env.MCP_TOKEN))) return { kind: "owner_token", workspaceId: OWNER_WORKSPACE_ID };
  if (!isApiKey(token) || !apiKeysAvailable(env, lookup)) return null;
  const find = lookup ?? ((t: string) => verifyApiKey(getSql(env.DATABASE_URL), t));
  const key = await find(token);
  return key ? { kind: "api_key", keyId: key.id, name: key.name, workspaceId: key.workspace_id, agent: key.kind === "agent" } : null;
}

export type McpEnv = { Bindings: Env; Variables: { bearer: BearerIdentity; workspace: Workspace } };

/**
 * Requires `Authorization: Bearer <MCP_TOKEN or API key>`. Answers 401 with `WWW-Authenticate: Bearer`
 * otherwise, and 503 if the server can check neither (no MCP_TOKEN and no database): fails closed.
 * A `?ws=` query parameter (the per-workspace URL of a Naive agent) must name the token's own workspace.
 */
export function bearerAuth(lookup?: ApiKeyLookup): MiddlewareHandler<McpEnv> {
  return async (c, next) => {
    if (!c.env.MCP_TOKEN && !apiKeysAvailable(c.env, lookup)) {
      return c.json(
        {
          ok: false,
          error: "not_configured",
          message: "Neither MCP_TOKEN nor DATABASE_URL (API keys) is set on the server, so the MCP endpoint is disabled.",
        },
        503,
      );
    }
    const header = c.req.header("Authorization") ?? "";
    const match = /^Bearer[ ]+(\S+)\s*$/i.exec(header);
    if (!match) {
      c.header("WWW-Authenticate", 'Bearer realm="crusonia"');
      return c.json({ ok: false, error: "unauthorized", message: "Send Authorization: Bearer <Crusonia API key or MCP_TOKEN>." }, 401);
    }
    const identity = await resolveBearer(c.env, match[1]!, lookup);
    if (!identity) {
      c.header("WWW-Authenticate", 'Bearer realm="crusonia", error="invalid_token"');
      return c.json({ ok: false, error: "unauthorized", message: "Invalid or revoked token." }, 401);
    }
    const ws = c.req.query("ws");
    if (ws !== undefined && ws !== identity.workspaceId) {
      return c.json({ ok: false, error: "forbidden", message: "This token belongs to another workspace than the one in the URL." }, 403);
    }
    c.set("bearer", identity);
    c.set("workspace", workspaceRef(identity.workspaceId));
    await next();
  };
}

export const requireBearer = bearerAuth();
