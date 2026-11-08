// Email address helpers. Pure. Company domains come from ./domains.ts (registrable, never a job board, social
// network or personal mailbox), shared with the MCP tools, CSV import and the HubSpot import.
import { normalizeDomain } from "./domains.ts";

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

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

/** The company domain of a work address: registrable (ada@mail.acme.co.uk -> acme.co.uk), never a personal mailbox. */
export function domainFromEmail(email: string | null | undefined): string | undefined {
  return normalizeDomain(email?.split("@")[1]) ?? undefined;
}

/** The company domain for a lead: website first, then a non-freemail email domain. */
export function companyDomain(lead: { website?: string | null; email?: string | null }): string | undefined {
  return normalizeDomain(lead.website) ?? domainFromEmail(normalizeEmail(lead.email));
}
