// Errors that are safe to show to the caller (an agent over MCP, or an API client).
// Services throw these for expected failures; transports map `code` to their own format
// (MCP: an `isError` tool result, REST: an HTTP status).
export type ServiceErrorCode =
  | "config_missing" // a secret/provider key is not set
  | "not_found"
  | "invalid" // input is well-formed but not allowed (e.g. drafting for a lead without consent)
  | "conflict"
  | "upstream"; // a provider (Neon, Apify, a website) failed

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

export function missingKey(key: string, what: string): ServiceError {
  return new ServiceError(
    "config_missing",
    `${key} is not set, so ${what} is unavailable. Add it to .dev.vars (local) or upload it with \`bun run secrets\` (Worker).`,
  );
}

/** Turns any thrown value into a message that is safe and useful for the caller. */
export function describeError(err: unknown): string {
  if (err instanceof ServiceError) return err.message;
  if (err instanceof Error && err.name === "NeonDbError") {
    const code = (err as Error & { code?: string }).code;
    if (code === "42P01" || code === "42703") {
      return `The database schema is missing or out of date (${err.message}). Run \`bun run migrate\`.`;
    }
    return `Database error: ${err.message}`;
  }
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return `Timed out: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
