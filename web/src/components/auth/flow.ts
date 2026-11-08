// Helpers for the Clerk custom flows (sign in, sign up, SSO callback). No Clerk imports here, so the static
// variant can use them too.
import type { NavigateFunction } from "react-router";

/** Only same-origin paths ("/app/leads"), never "//evil.com" or "https://…". */
export function safeNext(v: string | null | undefined): string | null {
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) return null;
  return v;
}

const AFTER_AUTH = "crusonia.afterAuth";

/** OAuth leaves the page; remember where to land when /sso-callback finishes. */
export function rememberAfterAuth(path: string) {
  try {
    sessionStorage.setItem(AFTER_AUTH, path);
  } catch {
    // falls back to /app
  }
}

export function takeAfterAuth(): string | null {
  try {
    const v = sessionStorage.getItem(AFTER_AUTH);
    sessionStorage.removeItem(AFTER_AUTH);
    return safeNext(v);
  } catch {
    return null;
  }
}

/** `navigate` callback for Clerk's finalize(): decorateUrl may turn the path into an absolute URL (Safari ITP). */
export function goTo(navigate: NavigateFunction, path: string) {
  return ({ decorateUrl }: { decorateUrl: (url: string) => string }) => {
    const url = decorateUrl(path);
    if (/^https?:\/\//.test(url)) window.location.href = url;
    else navigate(url, { replace: true });
  };
}

type ErrorLike = { message?: string; longMessage?: string } | null | undefined;

/** Clerk's human message for an error (long form when there is one). */
export function clerkMessage(e: ErrorLike): string | null {
  if (!e) return null;
  return e.longMessage || e.message || null;
}

/**
 * Social providers this Clerk instance has turned on (`oauth_github`, `oauth_google`), read from Clerk's loaded
 * environment. Clerk exposes it only as an internal getter, so anything unexpected falls back to `all`.
 */
export function enabledProviders<P extends string>(clerk: unknown, all: P[]): P[] {
  const env = (clerk as { __internal_environment?: { userSettings?: { authenticatableSocialStrategies?: unknown } } | null } | null)
    ?.__internal_environment;
  const on = env?.userSettings?.authenticatableSocialStrategies;
  if (!Array.isArray(on)) return all;
  return all.filter((p) => on.includes(`oauth_${p}`));
}

/** Clerk rejects a strategy that is not turned on with "oauth_github does not match one of the allowed values". */
export function providerOffMessage(err: { message?: string; longMessage?: string } | null | undefined, provider: string): string | null {
  const text = `${err?.longMessage ?? ""} ${err?.message ?? ""}`;
  if (!/does not match one of the allowed values/i.test(text) || !/strategy/i.test(text)) return null;
  const name = provider === "github" ? "GitHub" : provider === "google" ? "Google" : provider;
  return `${name} sign-in is not turned on for this workspace yet. Use another option.`;
}

export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

// ---------- website from the landing page ----------
// The landing page sends visitors to /sign-up?website=<domain>. The domain is kept in sessionStorage through
// sign-up (OAuth leaves the page) so onboarding step 1 can prefill it and start reading the site.

const WEBSITE = "crusonia.signupWebsite";
const WEBSITE_TTL_MS = 60 * 60_000;

/** "acme.com/about" from "https://www.Acme.com/about/", or null when it is not a plausible public host. */
export function cleanWebsite(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
  if (!v || v.length > 253 || /\s/.test(v)) return null;
  try {
    const host = new URL(`https://${v}`).hostname;
    return /\.[a-z]{2,}$/i.test(host) ? v : null;
  } catch {
    return null;
  }
}

export function rememberWebsite(raw: string | null | undefined) {
  const v = cleanWebsite(raw);
  if (!v) return;
  try {
    sessionStorage.setItem(WEBSITE, JSON.stringify({ v, at: Date.now() }));
  } catch {
    // onboarding just starts empty
  }
}

/** The remembered website, if fresh. Does not clear it (safe in StrictMode initializers); see clearWebsite. */
export function peekWebsite(): string | null {
  try {
    const raw = sessionStorage.getItem(WEBSITE);
    if (!raw) return null;
    const { v, at } = JSON.parse(raw) as { v?: string; at?: number };
    return typeof at === "number" && Date.now() - at < WEBSITE_TTL_MS ? cleanWebsite(v) : null;
  } catch {
    return null;
  }
}

export function clearWebsite() {
  try {
    sessionStorage.removeItem(WEBSITE);
  } catch {
    // ignore
  }
}
