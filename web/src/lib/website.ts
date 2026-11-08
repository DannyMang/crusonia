// The one website parser for the landing form, sign-up hand-off and onboarding step 1. Reading a website
// starts a paid crawl, so anything that is not plainly a public domain is rejected with a reason the form
// can show, instead of being trimmed into something else ("dan@gmail.com" must never become gmail.com).
// Pure: no DOM or React, so `bun test` covers it (test/website.test.ts).

export type WebsiteProblem = "empty" | "email" | "spaces" | "invalid";

export type ParsedWebsite = { ok: true; domain: string } | { ok: false; problem: WebsiteProblem };

const MAX_HOST = 253;
// 1-63 letters, digits or hyphens, not starting or ending with a hyphen. (No lookbehind: older Safari lacks it.)
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Letters only (com, io, co.uk's "uk"), or an internationalized TLD in punycode (xn--p1ai).
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * "acme.com" from "https://www.Acme.com/about?x=1", or the reason it is not a website. Lowercases, drops the
 * scheme, a leading "www.", the path, query and fragment. Rejects emails (anything with "@"), spaces, ports,
 * IP addresses, single-label hosts ("localhost") and hosts without a real-looking TLD.
 */
export function parseWebsite(raw: string | null | undefined): ParsedWebsite {
  const input = (raw ?? "").trim();
  if (!input) return { ok: false, problem: "empty" };
  if (input.includes("@")) return { ok: false, problem: "email" };
  if (/\s/.test(input)) return { ok: false, problem: "spaces" };

  const rest = input.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const hostPart = rest.split(/[/?#]/, 1)[0] ?? "";
  // Only plain host names: no "javascript:", ports or other punctuation before the path.
  if (!hostPart || /[^\p{L}\p{N}.-]/u.test(hostPart)) return { ok: false, problem: "invalid" };

  let host: string;
  try {
    // Lowercases and turns an internationalized name (bücher.de) into its ASCII form (xn--bcher-kva.de).
    host = new URL(`https://${hostPart}`).hostname;
  } catch {
    return { ok: false, problem: "invalid" };
  }
  host = host.replace(/\.$/, "").replace(/^www\./, "");

  const labels = host.split(".");
  if (host.length > MAX_HOST || labels.length < 2) return { ok: false, problem: "invalid" };
  if (!labels.every((l) => LABEL.test(l)) || !TLD.test(labels[labels.length - 1]!)) return { ok: false, problem: "invalid" };
  return { ok: true, domain: host };
}

/** The domain, or null when the value is not a website (see parseWebsite for the reason). */
export function cleanWebsite(raw: string | null | undefined): string | null {
  const parsed = parseWebsite(raw);
  return parsed.ok ? parsed.domain : null;
}

/** What a form says under the field for each problem. */
export function websiteProblemMessage(problem: WebsiteProblem): string {
  switch (problem) {
    case "email":
      return "That's an email address. Enter your company's website, like acme.com";
    case "empty":
      return "Enter your website's address, like acme.com";
    default:
      return "That doesn't look like a website. Enter an address like acme.com";
  }
}

/** The landing form's target for what was typed, or the error to show. Empty means "no website yet": plain sign-up. */
export function signUpTarget(website: string): { href: string } | { error: string } {
  const parsed = parseWebsite(website);
  if (parsed.ok) return { href: `/sign-up?website=${encodeURIComponent(parsed.domain)}` };
  if (parsed.problem === "empty") return { href: "/sign-up" };
  return { error: websiteProblemMessage(parsed.problem) };
}
