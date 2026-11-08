// Shared request plumbing: Hono env type, the audit actor, database access, zod parsing.
import type { Context } from "hono";
import { z } from "zod";
import { getSql, type Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { ApiError, invalidRequest } from "./errors.ts";

/** Who made an /api/* call. TODO(workspaces): carry a workspace id once multi-tenancy is decided. */
export type Principal =
  | { kind: "owner_token" }
  | { kind: "clerk"; userId: string; sessionId: string | null };

export type AppEnv = { Bindings: Env; Variables: { principal: Principal } };

/** A short label for the audit trail: `owner_token` or `clerk:<user id>`. */
export function actorOf(principal: Principal | undefined): string {
  if (!principal) return "system";
  return principal.kind === "clerk" ? `clerk:${principal.userId}` : "owner_token";
}

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
