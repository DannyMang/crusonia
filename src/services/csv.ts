// CSV import: parsing, header mapping and the dedupe plan. Pure (no database), so it is unit tested;
// src/services/crm.ts applies the plan. Dedupe follows the same keys as the MCP add_leads tool: email when
// there is one, otherwise company domain + lowercased name (an empty name is the company itself).
import { domainFromEmail, normalizeEmail } from "./addresses.ts";
import { normalizeDomain } from "./leads.ts";

export class CsvError extends Error {}

/** RFC 4180 parser: quoted fields, "" escapes, newlines inside quotes, CRLF/LF, BOM. Auto-detects , ; or tab. */
export function parseCsv(text: string): string[][] {
  const input = text.replace(/^﻿/, "");
  const delimiter = detectDelimiter(input);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let quoteStartLine = 1;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      quoteStartLine = line;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      line++;
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new CsvError(`Unterminated quoted field starting on line ${quoteStartLine}`);
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function detectDelimiter(text: string): string {
  const newline = text.search(/\r?\n/);
  const firstLine = newline < 0 ? text : text.slice(0, newline);
  const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ",";
}

// ---------- header mapping ----------

export const IMPORT_FIELDS = [
  "email", "name", "first_name", "last_name", "title", "company", "domain", "website", "linkedin_url",
  "sells", "best_customers", "consent", "consent_text", "consent_at",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

const ALIASES: Record<ImportField, string[]> = {
  email: ["email", "emailaddress", "workemail", "businessemail", "contactemail", "mail", "primaryemail"],
  name: ["name", "fullname", "contactname", "contact", "personname"],
  first_name: ["firstname", "first", "givenname"],
  last_name: ["lastname", "last", "surname", "familyname"],
  title: ["title", "jobtitle", "position", "role"],
  company: ["company", "companyname", "organization", "organisation", "account", "accountname", "org"],
  domain: ["domain", "companydomain", "emaildomain"],
  website: ["website", "companywebsite", "url", "websiteurl", "site", "web", "homepage"],
  linkedin_url: ["linkedin", "linkedinurl", "linkedinprofile", "linkedinprofileurl"],
  sells: ["sells", "product", "whattheysell", "offering"],
  best_customers: ["bestcustomers", "idealcustomers", "customers"],
  consent: ["consent", "optin", "optedin", "emailconsent", "marketingconsent", "subscribed", "emailoptin"],
  consent_text: ["consenttext", "consentsource", "consentnote", "consentdetails", "optinsource"],
  consent_at: ["consentat", "consentdate", "optindate", "optedinat", "consenttimestamp", "subscribedat"],
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export type HeaderMap = Partial<Record<ImportField, number>>;

/**
 * Maps import fields to column indexes. `explicit` ({ field: "Header name" }) wins over the built-in
 * aliases; an explicit header that is not in the file is an error rather than a silent skip.
 */
export function mapHeaders(headers: string[], explicit: Partial<Record<ImportField, string>> = {}): HeaderMap {
  const map: HeaderMap = {};
  const used = new Set<number>();
  for (const [field, header] of Object.entries(explicit) as [ImportField, string][]) {
    const idx = headers.findIndex((h) => h.trim().toLowerCase() === header.trim().toLowerCase());
    if (idx < 0) throw new CsvError(`Mapping for "${field}" names column "${header}", which is not in the header row`);
    map[field] = idx;
    used.add(idx);
  }
  for (const field of IMPORT_FIELDS) {
    if (map[field] !== undefined) continue;
    const idx = headers.findIndex((h, i) => !used.has(i) && ALIASES[field].includes(squash(h)));
    if (idx >= 0) {
      map[field] = idx;
      used.add(idx);
    }
  }
  return map;
}

// ---------- rows ----------

export type ImportCandidate = {
  /** 1-based row number counting the header as row 1, as a spreadsheet shows it. */
  row: number;
  email?: string;
  rawEmail?: string;
  name?: string;
  title?: string;
  company?: string;
  domain?: string;
  website?: string;
  linkedin_url?: string;
  sells?: string;
  best_customers?: string;
  /** Present only when the row grants consent (and has an email). Import never revokes consent. */
  consent?: { text: string; at: string };
};

const TRUTHY = new Set(["yes", "y", "true", "t", "1", "x", "optedin", "optin", "subscribed", "granted", "confirmed"]);

function parseConsentAt(raw: string | undefined, fallback: string): string {
  if (!raw?.trim()) return fallback;
  const t = Date.parse(raw.trim());
  return Number.isNaN(t) ? fallback : new Date(t).toISOString();
}

export function toCandidates(rows: string[][], map: HeaderMap, importedAt: string): ImportCandidate[] {
  const [header, ...data] = rows;
  if (!header) return [];
  const consentHeader = map.consent !== undefined ? header[map.consent] : undefined;
  return data.map((cells, i) => {
    const get = (f: ImportField) => {
      const idx = map[f];
      const v = idx === undefined ? undefined : cells[idx]?.trim();
      return v ? v : undefined;
    };
    const rawEmail = get("email");
    const email = normalizeEmail(rawEmail);
    const website = get("website");
    const candidate: ImportCandidate = {
      row: i + 2,
      email,
      rawEmail,
      name: get("name") ?? ([get("first_name"), get("last_name")].filter(Boolean).join(" ") || undefined),
      title: get("title"),
      company: get("company"),
      domain: normalizeDomain(get("domain")) ?? normalizeDomain(website) ?? domainFromEmail(email),
      website,
      linkedin_url: get("linkedin_url"),
      sells: get("sells"),
      best_customers: get("best_customers"),
    };

    const consentRaw = get("consent");
    const consentText = get("consent_text");
    const consentAt = get("consent_at");
    const granted =
      map.consent !== undefined
        ? consentRaw !== undefined && TRUTHY.has(squash(consentRaw))
        : Boolean(consentText || consentAt);
    // Consent belongs to an address: without an email there is nothing it could apply to.
    if (granted && email) {
      candidate.consent = {
        text: consentText ?? `CSV import: ${consentHeader ?? "consent"}=${consentRaw ?? "yes"}`,
        at: parseConsentAt(consentAt, importedAt),
      };
    }
    return candidate;
  });
}

// ---------- dedupe plan ----------

export type ExistingLead = {
  id: string;
  email: string | null;
  name: string | null;
  title: string | null;
  company: string | null;
  domain: string | null;
  website: string | null;
  linkedin_url: string | null;
  sells: string | null;
  best_customers: string | null;
  consent_at: Date | string | null;
};

export type LeadChanges = Partial<{
  email: string;
  name: string;
  title: string;
  company: string;
  domain: string;
  website: string;
  linkedin_url: string;
  sells: string;
  best_customers: string;
  consent_text: string;
  consent_at: string;
}>;

export type RowResult =
  | { row: number; status: "created"; key: string }
  | { row: number; status: "updated"; lead_id: string; matched_by: "email" | "domain"; fields: string[] }
  | { row: number; status: "skipped"; reason: string; lead_id?: string };

export type ImportPlan = {
  creates: (ImportCandidate & { key: string })[];
  updates: Map<string, LeadChanges>;
  rows: RowResult[];
};

const FILLABLE = ["name", "title", "company", "domain", "website", "linkedin_url", "sells", "best_customers"] as const;

export const emailKey = (email: string) => `e:${email}`;
export const domainKey = (domain: string, name: string | null | undefined) => `d:${domain}|${(name ?? "").toLowerCase()}`;

/**
 * - A row with an email matches the lead with that email. Failing that, a lead stored without an email
 *   at the same domain with the same name gets the email attached (the MCP tools do the same). Otherwise
 *   the row creates a lead, unless the address is suppressed.
 * - A row without an email needs a domain (domain, website, or work-email column): it matches the
 *   email-less lead with the same domain + name, or creates one. Such leads can be researched, never emailed.
 * - Updates only fill blank fields and grant consent; they never overwrite researched or edited values.
 */
export function planImport(candidates: ImportCandidate[], existing: ExistingLead[], suppressed: ReadonlySet<string> = new Set()): ImportPlan {
  const byEmail = new Map<string, ExistingLead>();
  const byDomainName = new Map<string, ExistingLead>();
  for (const l of existing) {
    if (l.email) byEmail.set(l.email.toLowerCase(), l);
    else if (l.domain) byDomainName.set(domainKey(l.domain, l.name), l);
  }
  const plan: ImportPlan = { creates: [], updates: new Map(), rows: [] };
  const seen = new Set<string>();

  const fill = (lead: ExistingLead, c: ImportCandidate, extra: LeadChanges = {}): string[] => {
    const changes: LeadChanges = { ...(plan.updates.get(lead.id) ?? {}), ...extra };
    const changed: string[] = Object.keys(extra);
    for (const key of FILLABLE) {
      const value = c[key];
      if (value && !lead[key] && !changes[key]) {
        changes[key] = value;
        changed.push(key);
      }
    }
    if (c.consent && !lead.consent_at && !changes.consent_at) {
      changes.consent_text = c.consent.text;
      changes.consent_at = c.consent.at;
      changed.push("consent");
    }
    if (changed.length) plan.updates.set(lead.id, changes);
    return changed;
  };
  const updated = (row: number, lead: ExistingLead, matched_by: "email" | "domain", fields: string[]): RowResult =>
    fields.length
      ? { row, status: "updated", lead_id: lead.id, matched_by, fields }
      : { row, status: "skipped", reason: "unchanged", lead_id: lead.id };

  for (const c of candidates) {
    if (c.rawEmail && !c.email) {
      plan.rows.push({ row: c.row, status: "skipped", reason: "invalid_email" });
      continue;
    }
    if (!c.email && !c.domain) {
      plan.rows.push({ row: c.row, status: "skipped", reason: "missing_email_and_domain" });
      continue;
    }
    const key = c.email ? emailKey(c.email) : domainKey(c.domain!, c.name);
    if (seen.has(key)) {
      plan.rows.push({ row: c.row, status: "skipped", reason: "duplicate_in_file" });
      continue;
    }
    seen.add(key);

    if (c.email) {
      const match = byEmail.get(c.email);
      if (match) {
        plan.rows.push(updated(c.row, match, "email", fill(match, c)));
        continue;
      }
      if (suppressed.has(c.email)) {
        plan.rows.push({ row: c.row, status: "skipped", reason: "suppressed" });
        continue;
      }
      const emailless = c.domain && c.name ? byDomainName.get(domainKey(c.domain, c.name)) : undefined;
      if (emailless) {
        byDomainName.delete(domainKey(c.domain!, c.name));
        byEmail.set(c.email, { ...emailless, email: c.email });
        plan.rows.push(updated(c.row, emailless, "domain", fill(emailless, c, { email: c.email })));
        continue;
      }
    } else {
      const match = byDomainName.get(key);
      if (match) {
        plan.rows.push(updated(c.row, match, "domain", fill(match, c)));
        continue;
      }
    }
    plan.creates.push({ ...c, key });
    plan.rows.push({ row: c.row, status: "created", key });
  }
  return plan;
}
