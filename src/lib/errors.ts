// One error shape for every JSON error the Worker returns: { error: { code, message, details? } }.
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { describeError, ServiceError, type ServiceErrorCode } from "../services/errors.ts";

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorBody(code: string, message: string, details?: unknown) {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);

/** A required secret or setting is missing: 503 so callers can tell "not set up yet" from a bug. */
export const notConfigured = (key: string) => new ApiError(503, "not_configured", `${key} is not set`);

export function invalidRequest(error: z.ZodError) {
  return new ApiError(
    400,
    "invalid_request",
    error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
    error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  );
}

const SERVICE_STATUS: Record<ServiceErrorCode, [ContentfulStatusCode, string]> = {
  config_missing: [503, "not_configured"],
  not_found: [404, "not_found"],
  invalid: [422, "invalid"],
  conflict: [409, "conflict"],
  upstream: [502, "upstream_error"],
};

/**
 * Maps anything thrown by a REST handler to an ApiError: our own ApiErrors, the shared ServiceErrors
 * (src/services/errors.ts), and Postgres errors worth explaining. Undefined means "unexpected" (500).
 */
export function toApiError(err: unknown): ApiError | undefined {
  if (err instanceof ApiError) return err;
  if (err instanceof ServiceError) {
    const [status, code] = SERVICE_STATUS[err.code];
    return new ApiError(status, code, err.message);
  }
  const pg = err as { name?: string; code?: string } | null;
  if (pg?.name === "NeonDbError" && (pg.code === "42P01" || pg.code === "42703")) {
    return new ApiError(503, "schema_out_of_date", describeError(err));
  }
  if (isUniqueViolation(err)) return new ApiError(409, "conflict", "A concurrent change conflicted with this request; retry");
  return undefined;
}

/** Postgres unique violation (SQLSTATE 23505), optionally on a specific constraint. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return Boolean(e && e.code === "23505" && (!constraint || e.constraint === constraint));
}
