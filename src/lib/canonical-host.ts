// One public hostname: PUBLIC_URL's. www.<that host> redirects everything to it. An old hostname (LEGACY_HOSTS) keeps
// serving machines, because providers, agents and the iMessage bridge move to a new URL one at a time, and redirects
// browser pages with their path, so old invite links and bookmarks still land in the right place. Every other host
// (staging, local dev) is left alone.
import type { Env } from "../env.ts";

/** Paths machines call. Everything else on an old hostname is a browser page. */
export const API_PATH = /^\/(api|mcp|webhooks|health)(\/|$)/;

export const legacyHosts = (env: Pick<Env, "LEGACY_HOSTS">) =>
  (env.LEGACY_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

/** Where this request belongs instead, or null to serve it here. A 301 turns a POST into a GET, so other methods get a 308. */
export function canonicalRedirect(
  requestUrl: string,
  method: string,
  env: Pick<Env, "PUBLIC_URL" | "LEGACY_HOSTS">,
): { location: string; status: 301 | 308 } | null {
  let canonical: URL;
  try {
    canonical = new URL(env.PUBLIC_URL);
  } catch {
    return null;
  }
  const url = new URL(requestUrl);
  if (url.host === canonical.host) return null;
  const www = url.host === `www.${canonical.host}`;
  const oldPage = legacyHosts(env).includes(url.host) && !API_PATH.test(url.pathname);
  if (!www && !oldPage) return null;
  return { location: `${canonical.origin}${url.pathname}${url.search}`, status: method === "GET" || method === "HEAD" ? 301 : 308 };
}
