// Shared request plumbing: Hono env type, the audit actor, the request's workspace, database access, zod parsing.
import type { Context } from "hono";
import { z } from "zod";
import { getSql, type Sql } from "../db.ts";
import type { Env } from "../env.ts";
import type { Workspace, WorkspaceRole } from "../services/workspaces.ts";
import { ApiError, invalidRequest } from "./errors.ts";

/** Who made an /api/* call. Every principal acts on exactly one workspace (AppEnv Variables.workspace). */
export type Principal =
  | { kind: "owner_token" }
  | { kind: "api_key"; keyId: string; name: string; workspaceId: string; agent?: boolean }
  // email/name are set only when the session token carries them (custom session claims).
  | { kind: "clerk"; userId: string; sessionId: string | null; email?: string; name?: string };

/**
 * `role`: the caller's role in `workspace`. A signed-in person's comes from workspace_members on every request.
 * MCP_TOKEN counts as owner and an API key as admin, but what only a person may do is refused by src/api/guards.ts.
 */
export type AppEnv = { Bindings: Env; Variables: { principal: Principal; workspace: Workspace; role: WorkspaceRole } };

/** A short label for the audit trail: `owner_token`, `api_key:<key id>` or `clerk:<user id>`. */
export function actorOf(principal: Principal | undefined): string {
  if (!principal) return "system";
  if (principal.kind === "clerk") return `clerk:${principal.userId}`;
  return principal.kind === "api_key" ? `api_key:${principal.keyId}` : "owner_token";
}

/**
 * The Company summary author for a REST caller: `user:<clerk id>` for a signed-in person, `agent:api_key:<id>`
 * for an agent using a workspace key, `agent:mcp_token` for the owner token.
 */
export function authorOf(principal: Principal): string {
  if (principal.kind === "clerk") return `user:${principal.userId}`;
  return principal.kind === "api_key" ? `agent:api_key:${principal.keyId}` : "agent:mcp_token";
}

/** The workspace id of the request (set by the /api auth middleware). */
export const wsOf = (c: { get: (k: "workspace") => Workspace }) => c.get("workspace").id;

/** Throws ServiceError("config_missing") when DATABASE_URL is unset; the error handler answers 503. */
export function sqlFor(env: Env): Sql {
  return getSql(env.DATABASE_URL);
}

export async function parseJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    const text = await c.req.text();
    body = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw invalidRequest(parsed.error);
  return parsed.data;
}

export function parseQuery<T extends z.ZodType>(c: Context, schema: T): z.infer<T> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw invalidRequest(parsed.error);
  return parsed.data;
}
