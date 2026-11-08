// Per-IP limits, for what is cheap to hammer and costly to answer. Workers' rate limiting binding (wrangler.jsonc
// `ratelimits`) needs no database, so a flood costs no Neon queries. Its counts are per Cloudflare location and approximate:
// this keeps a script from hammering a route, while the per-workspace limits and the instance cap hold the money.
//   RL_ANON    wrong tokens on /api and /mcp, and invite links: everything a stranger can reach
//   RL_PAID    paid starts and web reads (an agent behind one IP can't start more than the workspace limits allow anyway)
//   RL_SIGNUP  new workspaces: a free sample per verified email, and only so many from one network
// A missing binding (tests, plain bun) or a failing one lets the request through: the other limits still apply.
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../env.ts";
import { ApiError } from "./errors.ts";

export const tooManyRequests = () => new ApiError(429, "too_many_requests", "Too many requests from this network. Wait a minute and try again.");

type Limiter = "RL_ANON" | "RL_PAID" | "RL_SIGNUP";

/** Cloudflare sets this on every request; a client can't. Null only outside Cloudflare. */
export const clientIp = (c: Pick<Context, "req">) => c.req.header("cf-connecting-ip") ?? null;

/** True when this IP is within the limit (one call uses up one request). */
export async function withinLimit(env: Env, limiter: Limiter, scope: string, ip: string | null): Promise<boolean> {
  const binding = env[limiter];
  if (!binding || !ip) return true;
  try {
    return (await binding.limit({ key: `${scope}:${ip}` })).success;
  } catch (err) {
    console.error(`rate limit ${scope}:`, err instanceof Error ? err.message : err);
    return true;
  }
}

/** A middleware: 429 too_many_requests past the limit. `skip` exempts a caller (the owner's own token). */
export const ipLimit =
  <E extends { Bindings: Env }>(limiter: Limiter, scope: string, skip?: (c: Context<E>) => boolean): MiddlewareHandler<E> =>
  async (c, next) => {
    if (!skip?.(c) && !(await withinLimit(c.env, limiter, scope, clientIp(c)))) {
      c.header("Retry-After", "60");
      throw tooManyRequests();
    }
    await next();
  };

// A wrong token costs a database lookup, and a valid agent token must not be limited at all: many workspaces' agents can
// share one IP on /mcp. So only failures count, and once an IP is over the limit this isolate answers it without looking
// anything up for a minute. A global on purpose, like the price cache in src/billing/checkout.ts: the worst a lost entry costs is
// one more lookup.
const BAD_TOKEN_BLOCK_MS = 60_000;
const MAX_BLOCKED_IPS = 5_000;
const blockedIps = new Map<string, number>();

export function badTokenBlocked(ip: string | null, now = Date.now()): boolean {
  if (!ip) return false;
  const until = blockedIps.get(ip);
  if (until === undefined) return false;
  if (until > now) return true;
  blockedIps.delete(ip);
  return false;
}

/** Counts a wrong token. True when this IP is now over the limit. */
export async function noteBadToken(env: Env, ip: string | null, now = Date.now()): Promise<boolean> {
  if (await withinLimit(env, "RL_ANON", "bad_token", ip)) return false;
  if (blockedIps.size >= MAX_BLOCKED_IPS) blockedIps.clear();
  if (ip) blockedIps.set(ip, now + BAD_TOKEN_BLOCK_MS);
  return true;
}

export const resetBadTokenBlocks = () => blockedIps.clear();
