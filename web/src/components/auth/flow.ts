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

export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
