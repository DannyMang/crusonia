// Email address helpers. Pure. Domains use normalizeDomain from ./leads.ts (shared with the MCP tools).
import { normalizeDomain } from "./leads.ts";

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

// Personal mailbox providers: their domain says nothing about the company, so it is never used as one.
const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de",
  "mail.com", "yandex.com", "yandex.ru", "zoho.com", "fastmail.com", "hey.com", "qq.com", "163.com", "web.de",
]);

export function normalizeEmail(raw: string | null | undefined): string | undefined {
  const email = raw?.trim().toLowerCase();
  return email && EMAIL_RE.test(email) ? email : undefined;
}

/** `"Ada <ada@x.com>"` or `ada@x.com` -> `ada@x.com` (lowercased); undefined if there is no address. */
export function extractEmail(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const angle = /<([^<>]+)>\s*$/.exec(raw.trim());
  return normalizeEmail(angle ? angle[1] : raw);
}

export function domainFromEmail(email: string | null | undefined): string | undefined {
  const domain = email?.split("@")[1]?.toLowerCase();
  return domain && !FREEMAIL.has(domain) ? domain : undefined;
}

/** The company domain for a lead: website first, then a non-freemail email domain. */
export function companyDomain(lead: { website?: string | null; email?: string | null }): string | undefined {
  return normalizeDomain(lead.website) ?? domainFromEmail(normalizeEmail(lead.email));
}
