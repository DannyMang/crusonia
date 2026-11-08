import type { MiddlewareHandler } from "hono";
import type { Env } from "./env.ts";

// TODO(workspaces): replace the single shared MCP_TOKEN with per-user API keys issued from Clerk
// workspaces (look the key up, resolve its workspace, and scope every query to it).

const encoder = new TextEncoder();

/** Constant-time string comparison: hash both sides to equal-length digests, then timingSafeEqual. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

/**
 * Requires `Authorization: Bearer <MCP_TOKEN>`. Answers 401 with `WWW-Authenticate: Bearer` otherwise,
 * and 503 if the server has no MCP_TOKEN configured (fails closed).
 */
export const requireBearer: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const expected = c.env.MCP_TOKEN;
  if (!expected) {
    return c.json(
      { ok: false, error: "not_configured", message: "MCP_TOKEN is not set on the server, so the MCP endpoint is disabled." },
      503,
    );
  }
  const header = c.req.header("Authorization") ?? "";
  const match = /^Bearer[ ]+(\S+)\s*$/i.exec(header);
  if (!match) {
    c.header("WWW-Authenticate", 'Bearer realm="crusonia"');
    return c.json({ ok: false, error: "unauthorized", message: "Send Authorization: Bearer <MCP_TOKEN>." }, 401);
  }
  if (!(await safeEqual(match[1]!, expected))) {
    c.header("WWW-Authenticate", 'Bearer realm="crusonia", error="invalid_token"');
    return c.json({ ok: false, error: "unauthorized", message: "Invalid token." }, 401);
  }
  await next();
};
