// CRM sync field mapping and ownership. Pure (no database, no network), so it is unit tested; the sync in
// ./crm-sync.ts applies it.
//
// Field ownership (see "CRM sync" in README.md):
//   - HubSpot owns relationship data. Identity fields (name, job title, company, website) are written when we
//     create a record and afterwards only filled in where HubSpot has nothing; we never overwrite them.
//   - Crusonia owns its research and pipeline state: the crusonia_* properties (fit score, rationale summary,
//     stage, last outreach, source, lead id) are overwritten whenever they differ.
//   - hs_lead_status is shared: we write our stage's status only while HubSpot holds nothing or the value we
//     wrote last time. Once someone changes it in HubSpot, we leave it alone.
//   - Evidence, sent emails and replies become HubSpot notes, one per item, each carrying a [crusonia:<ref>]
//     marker so a retry finds the note it already created instead of adding a second one.
//   - Imports from HubSpot only fill blank fields on our leads; evidence, scores, stages, variants and
//     experiments are never touched, and consent is granted only through an explicitly mapped opt-in property.
import type { Lead } from "../db.ts";
import { domainFromEmail, normalizeEmail } from "./addresses.ts";
import type { ImportCandidate } from "./csv.ts";
import { LEAD_STAGES, normalizeDomain, type LeadStage } from "./leads.ts";

export const CRM_TARGETS = ["hubspot", "notion"] as const;
export type CrmTarget = (typeof CRM_TARGETS)[number];
export type SyncScope = "qualified" | "all";

/** Stages where a conversation is under way (or was ended by the lead): always worth mirroring. */
export const ENGAGED_STAGES = ["awaiting_approval", "sent", "replied", "interested", "not_interested", "meeting_booked", "unsubscribed"] as const;

export const syncScope = (raw: string | undefined): SyncScope => (raw?.trim().toLowerCase() === "all" ? "all" : "qualified");
export const flagOn = (raw: string | undefined) => /^(1|true|yes|on)$/i.test(raw?.trim() ?? "");

/** What we last wrote to fields shared with HubSpot users, stored in leads.hubspot_state. */
export type HubSpotState = { lead_status?: string; assoc?: string };

/** A lead as the sync reads it (see loadSyncLead in ./crm-sync.ts). */
export type SyncLead = Pick<
  Lead,
  "id" | "email" | "name" | "title" | "company" | "domain" | "website" | "source" | "stage" | "score" | "qualified" | "rationale" | "hubspot_id"
> & {
  consent_at: Date | string | null;
  hubspot_company_id: string | null;
  hubspot_state: HubSpotState | null;
  notion_page_id: string | null;
  notion_hash: string | null;
  last_outreach_at: Date | string | null;
  last_activity_at: Date | string | null;
  evidence_count: number;
  /** The first evidence claim: usually the buying signal that surfaced the lead. */
  signal: string | null;
};

/**
 * Which leads a target receives. "qualified" (the default): opted-in contacts, leads scored as qualified,
 * leads in the send flow, and (HubSpot only) records that came from HubSpot once Crusonia has scored them.
 * Agent-found leads that were never qualified stay out of the CRM. "all": every lead.
 * Keep in sync with scopeSql in ./crm-queue.ts.
 */
export function inScope(
  lead: Pick<SyncLead, "email" | "domain" | "consent_at" | "qualified" | "stage" | "hubspot_id" | "hubspot_company_id" | "score">,
  target: CrmTarget,
  scope: SyncScope,
): boolean {
  if (!lead.email && !lead.domain) return false;
  if (scope === "all") return true;
  if (lead.consent_at || lead.qualified === true || (ENGAGED_STAGES as readonly string[]).includes(lead.stage)) return true;
  return target === "hubspot" && Boolean(lead.hubspot_id || lead.hubspot_company_id) && lead.score !== null;
}

// ---------- HubSpot: lead status ----------

/**
 * Our stage -> HubSpot's standard hs_lead_status (NEW, OPEN, IN_PROGRESS, OPEN_DEAL, UNQUALIFIED,
 * ATTEMPTED_TO_CONTACT, CONNECTED, BAD_TIMING). null = we have nothing to say: leads without consent are only
 * researched, so their relationship status in HubSpot is not ours to set.
 */
export const LEAD_STATUS_FOR_STAGE: Record<LeadStage, string | null> = {
  new: "NEW",
  no_consent: null,
  researching: "OPEN",
  qualified: "OPEN",
  needs_review: "OPEN",
  awaiting_approval: "IN_PROGRESS",
  disqualified: "UNQUALIFIED",
  sent: "ATTEMPTED_TO_CONTACT",
  replied: "CONNECTED",
  interested: "CONNECTED",
  meeting_booked: "OPEN_DEAL",
  not_interested: "UNQUALIFIED",
  unsubscribed: "UNQUALIFIED",
};

export const leadStatusFor = (stage: string): string | null => LEAD_STATUS_FOR_STAGE[stage as LeadStage] ?? null;

// ---------- HubSpot: custom properties (created by `bun run setup --crm`) ----------

export type PropertySpec = {
  name: string;
  label: string;
  type: "string" | "number" | "enumeration" | "datetime";
  fieldType: "text" | "textarea" | "number" | "select" | "date";
  description: string;
  options?: { label: string; value: string; displayOrder: number }[];
};

export const HUBSPOT_GROUP = { name: "crusonia", label: "Crusonia", displayOrder: -1 };
export const HUBSPOT_OBJECTS = ["contacts", "companies"] as const;

const stageLabel = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

export const HUBSPOT_PROPERTIES: PropertySpec[] = [
  { name: "crusonia_fit_score", label: "Crusonia fit score", type: "number", fieldType: "number", description: "ICP fit from Crusonia research, 0 (none) to 100." },
  {
    name: "crusonia_fit_rationale",
    label: "Crusonia fit rationale",
    type: "string",
    fieldType: "textarea",
    description: "Summary of why the lead fits (or does not), from Crusonia research. Evidence is in the notes.",
  },
  {
    name: "crusonia_stage",
    label: "Crusonia stage",
    type: "enumeration",
    fieldType: "select",
    description: "Where the lead is in Crusonia's pipeline.",
    options: LEAD_STAGES.map((s, i) => ({ label: stageLabel(s), value: s, displayOrder: i })),
  },
  { name: "crusonia_last_outreach_at", label: "Crusonia last outreach", type: "datetime", fieldType: "date", description: "When Crusonia last emailed this lead." },
  { name: "crusonia_source", label: "Crusonia source", type: "string", fieldType: "text", description: "Where Crusonia found the lead (e.g. google_search, csv_import)." },
  { name: "crusonia_lead_id", label: "Crusonia lead id", type: "string", fieldType: "text", description: "The lead's id in Crusonia." },
];
const SPEC = new Map(HUBSPOT_PROPERTIES.map((p) => [p.name, p]));
export const HUBSPOT_PROPERTY_NAMES = HUBSPOT_PROPERTIES.map((p) => p.name);

// ---------- HubSpot: values ----------

const iso = (v: Date | string) => new Date(v).toISOString();

export function splitName(name: string | null | undefined): { firstname?: string; lastname?: string } {
  const parts = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (!parts.length) return {};
  if (parts.length === 1) return { firstname: parts[0] };
  return { firstname: parts[0], lastname: parts.slice(1).join(" ") };
}

/** Whitespace collapsed, at most `max` characters, cut at a sentence end when one is near, else at a word. */
export function summarize(text: string, max = 500): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (sentence >= max * 0.5) return cut.slice(0, sentence + 1);
  const space = cut.lastIndexOf(" ", max - 1);
  return `${cut.slice(0, space > 0 ? space : max - 1).trimEnd()}…`;
}

const compact = (o: Record<string, string | null | undefined>) =>
  Object.fromEntries(Object.entries(o).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== ""));

/** HubSpot-owned contact fields: set on create, later only where HubSpot is blank. */
export function contactIdentity(lead: Pick<SyncLead, "email" | "name" | "title" | "company" | "website">): Record<string, string> {
  return compact({ email: lead.email, ...splitName(lead.name), jobtitle: lead.title, company: lead.company, website: lead.website });
}

export function companyIdentity(lead: Pick<SyncLead, "company" | "domain">): Record<string, string> {
  return compact({ name: lead.company ?? lead.domain, domain: lead.domain });
}

/** Crusonia-owned properties, limited to the ones that exist in the portal. "" clears a value in HubSpot. */
export function ownedProperties(lead: SyncLead, available: ReadonlySet<string>): Record<string, string> {
  const values: Record<string, string> = {
    crusonia_lead_id: lead.id,
    crusonia_stage: lead.stage,
    crusonia_source: lead.source,
    crusonia_fit_score: lead.score === null || lead.score === undefined ? "" : String(lead.score),
    crusonia_fit_rationale: lead.rationale ? summarize(lead.rationale) : "",
    crusonia_last_outreach_at: lead.last_outreach_at ? iso(lead.last_outreach_at) : "",
  };
  return Object.fromEntries(Object.entries(values).filter(([k]) => available.has(k)));
}

/** Compares property values the way HubSpot returns them (numbers and datetimes come back as strings). */
export function normalizeValue(name: string, value: string | null | undefined): string {
  const s = (value ?? "").replace(/\r\n/g, "\n").trim();
  if (!s) return "";
  const type = SPEC.get(name)?.type;
  if (type === "number") {
    const n = Number(s);
    return Number.isFinite(n) ? String(n) : s;
  }
  if (type === "datetime") {
    const t = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
    return Number.isNaN(t) ? s : String(t);
  }
  return s;
}

export type DesiredProperties = { identity: Record<string, string>; owned: Record<string, string>; leadStatus: string | null };

/** Properties for a record we create: everything we know (blank owned values are left out). */
export function planCreate(desired: DesiredProperties): Record<string, string> {
  return {
    ...desired.identity,
    ...compact(desired.owned),
    ...(desired.leadStatus ? { hs_lead_status: desired.leadStatus } : {}),
  };
}

export type PlannedUpdate = {
  /** The PATCH body; empty means nothing to write. */
  properties: Record<string, string>;
  /** hs_lead_status value we now consider ours (store it in hubspot_state.lead_status). */
  leadStatus: string | undefined;
  /** Shared fields left alone because someone changed them in HubSpot. */
  skipped: string[];
};

/** What to PATCH on an existing record, applying the ownership rules at the top of this file. */
export function planUpdate(current: Record<string, string | null | undefined>, desired: DesiredProperties, state: HubSpotState | null): PlannedUpdate {
  const properties: Record<string, string> = {};
  const skipped: string[] = [];
  for (const [k, v] of Object.entries(desired.identity)) {
    if (v && !normalizeValue(k, current[k])) properties[k] = v;
  }
  for (const [k, v] of Object.entries(desired.owned)) {
    if (normalizeValue(k, current[k]) !== normalizeValue(k, v)) properties[k] = v;
  }
  let leadStatus = state?.lead_status;
  const want = desired.leadStatus;
  if (want) {
    const cur = (current.hs_lead_status ?? "").trim();
    if (cur === want) leadStatus = want;
    else if (!cur || cur === state?.lead_status) {
      properties.hs_lead_status = want;
      leadStatus = want;
    } else {
      skipped.push(`hs_lead_status is ${cur} in HubSpot (changed there since our last write), so ${want} was not written`);
    }
  }
  return { properties, leadStatus, skipped };
}

// ---------- HubSpot: notes ----------

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Same claim + same URL = same ref, so evidence saved twice becomes one note. */
export async function evidenceRef(claim: string, sourceUrl: string): Promise<string> {
  const key = `${sourceUrl.trim().toLowerCase()}\n${claim.replace(/\s+/g, " ").trim().toLowerCase()}`;
  return `ev${(await sha256Hex(key)).slice(0, 16)}`;
}
export const messageRef = (id: string | number) => `msg${id}`;
export const refMarker = (ref: string) => `[crusonia:${ref}]`;

/** Refs found in a note body (ours carry exactly one). */
export function parseNoteRefs(body: string): string[] {
  return [...body.matchAll(/\[crusonia:((?:ev|msg)[A-Za-z0-9]+)\]/g)].map((m) => m[1]!);
}

const httpUrl = (u: string) => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
};

export function evidenceNoteBody(e: { claim: string; source_url: string }, ref: string): string {
  const url = httpUrl(e.source_url);
  const source = url ? `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>` : escapeHtml(e.source_url);
  return `<p><strong>Crusonia evidence</strong></p><p>${escapeHtml(e.claim)}</p><p>Source: ${source}</p><p>${refMarker(ref)}</p>`;
}

/** Inbound bodies are untrusted: tags are stripped and everything is escaped; only an excerpt is kept. */
export function messageNoteBody(
  m: { direction: string; subject: string | null; body: string | null; label?: string | null },
  ref: string,
  maxChars = 1500,
): string {
  const heading = m.direction === "out" ? "Email sent by Crusonia" : `Reply received${m.label ? ` (${m.label.replace(/_/g, " ")})` : ""}`;
  const plain = (m.body ?? "").replace(/<[^>]*>/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const excerpt = plain.length > maxChars ? `${plain.slice(0, maxChars).trimEnd()}…` : plain;
  return (
    `<p><strong>${heading}</strong>${m.subject ? `: ${escapeHtml(m.subject)}` : ""}</p>` +
    (excerpt ? `<p>${escapeHtml(excerpt).replace(/\n/g, "<br>")}</p>` : "") +
    `<p>${refMarker(ref)}</p>`
  );
}

export type EvidenceRow = { id: string; claim: string; source_url: string; created_at: Date | string; hubspot_note_id: string | null };
export type MessageRow = {
  id: string;
  direction: string;
  subject: string | null;
  body: string | null;
  label: string | null;
  created_at: Date | string;
  hubspot_note_id: string | null;
};
export type NoteToCreate = { ref: string; body: string; timestamp: string; evidenceIds: string[]; messageId?: string };

/**
 * Notes still to create for a lead, oldest first. Evidence rows with the same claim + URL share one note;
 * a row identical to one already synced just reuses that note (`reuse`).
 */
export async function planNotes(evidence: EvidenceRow[], messages: MessageRow[]) {
  const refs = new Map<string, string>();
  const known = new Map<string, string>();
  for (const e of evidence) {
    const ref = await evidenceRef(e.claim, e.source_url);
    refs.set(e.id, ref);
    if (e.hubspot_note_id && !known.has(ref)) known.set(ref, e.hubspot_note_id);
  }
  const groups = new Map<string, NoteToCreate>();
  const reuse = new Map<string, string[]>();
  for (const e of evidence) {
    if (e.hubspot_note_id) continue;
    const ref = refs.get(e.id)!;
    if (known.has(ref)) {
      reuse.set(ref, [...(reuse.get(ref) ?? []), e.id]);
      continue;
    }
    const group = groups.get(ref);
    if (group) group.evidenceIds.push(e.id);
    else groups.set(ref, { ref, body: evidenceNoteBody(e, ref), timestamp: iso(e.created_at), evidenceIds: [e.id] });
  }
  const create = [...groups.values()];
  for (const m of messages) {
    if (m.hubspot_note_id) continue;
    const ref = messageRef(m.id);
    create.push({ ref, body: messageNoteBody(m, ref), timestamp: iso(m.created_at), evidenceIds: [], messageId: m.id });
  }
  create.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { create, reuse: [...reuse].map(([ref, ids]) => ({ ids, noteId: known.get(ref)! })) };
}

// ---------- Notion ----------

export const NOTION_DATABASE_TITLE = "Crusonia leads";
export const NOTION_KEY_PROPERTY = "Lead ID";

const STAGE_COLORS: Record<LeadStage, string> = {
  new: "blue",
  no_consent: "gray",
  researching: "yellow",
  qualified: "green",
  disqualified: "red",
  needs_review: "orange",
  awaiting_approval: "purple",
  sent: "blue",
  replied: "pink",
  interested: "green",
  not_interested: "brown",
  meeting_booked: "green",
  unsubscribed: "red",
};

/** Columns of the "Crusonia leads" database. Crusonia owns these; add your own columns freely. */
export function notionSchema(): Record<string, unknown> {
  return {
    Company: { type: "title", title: {} },
    Contact: { type: "rich_text", rich_text: {} },
    Email: { type: "email", email: {} },
    Stage: { type: "select", select: { options: LEAD_STAGES.map((s) => ({ name: s, color: STAGE_COLORS[s] })) } },
    Fit: { type: "number", number: { format: "number" } },
    Signal: { type: "rich_text", rich_text: {} },
    "Evidence count": { type: "number", number: { format: "number" } },
    "Last activity": { type: "date", date: {} },
    Source: { type: "rich_text", rich_text: {} },
    "Crusonia link": { type: "url", url: {} },
    [NOTION_KEY_PROPERTY]: { type: "rich_text", rich_text: {} },
  };
}

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const richText = (s: string | null | undefined, max = 2000) => (s ? [{ type: "text", text: { content: truncate(s, max) } }] : []);

/** The lead's page in the web app. */
export const leadUrl = (publicUrl: string, id: string) => `${publicUrl.replace(/\/+$/, "")}/leads/${encodeURIComponent(id)}`;

export function notionProperties(lead: SyncLead, publicUrl: string): Record<string, unknown> {
  const contact = [lead.name, lead.title].filter(Boolean).join(" · ");
  return {
    Company: { title: richText(lead.company ?? lead.domain ?? lead.email ?? lead.id, 200) },
    Contact: { rich_text: richText(contact || null, 300) },
    Email: { email: lead.email ?? null },
    Stage: { select: { name: lead.stage } },
    Fit: { number: lead.score ?? null },
    Signal: { rich_text: richText(lead.signal, 300) },
    "Evidence count": { number: lead.evidence_count },
    "Last activity": { date: lead.last_activity_at ? { start: iso(lead.last_activity_at) } : null },
    Source: { rich_text: richText(lead.source, 200) },
    "Crusonia link": { url: leadUrl(publicUrl, lead.id) },
    [NOTION_KEY_PROPERTY]: { rich_text: richText(lead.id) },
  };
}

export async function propertiesHash(props: unknown): Promise<string> {
  return (await sha256Hex(JSON.stringify(props))).slice(0, 32);
}

// ---------- HubSpot import ----------

export const HUBSPOT_CONTACT_IMPORT_PROPERTIES = ["email", "firstname", "lastname", "jobtitle", "company", "website", "hs_email_optout"];
export const HUBSPOT_COMPANY_IMPORT_PROPERTIES = ["name", "domain", "website"];

const DEFAULT_CONSENT_VALUES = ["yes", "y", "true", "t", "1", "x", "opted_in", "optedin", "opt_in", "optin", "subscribed", "granted", "confirmed"];

export type ConsentMapping = { property: string; values: Set<string> } | null;

/** HUBSPOT_CONSENT_PROPERTY (+ HUBSPOT_CONSENT_VALUES). Unset = no mapping: imported contacts get no consent. */
export function consentMapping(env: { HUBSPOT_CONSENT_PROPERTY?: string; HUBSPOT_CONSENT_VALUES?: string }): ConsentMapping {
  const property = env.HUBSPOT_CONSENT_PROPERTY?.trim();
  if (!property) return null;
  const custom = (env.HUBSPOT_CONSENT_VALUES ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  return { property, values: new Set(custom.length ? custom : DEFAULT_CONSENT_VALUES) };
}

/**
 * Consent from a HubSpot contact: only through the mapped property, never for a contact that opted out of
 * email in HubSpot (hs_email_optout). Multi-select values (a;b) count if any value matches.
 */
export function hubspotConsent(
  props: Record<string, string | null | undefined>,
  mapping: ConsentMapping,
  importedAt: string,
): { text: string; at: string } | undefined {
  if (!mapping) return undefined;
  if ((props.hs_email_optout ?? "").trim().toLowerCase() === "true") return undefined;
  const raw = props[mapping.property]?.trim();
  if (!raw) return undefined;
  const values = raw.split(";").map((v) => v.trim().toLowerCase());
  if (!values.some((v) => mapping.values.has(v))) return undefined;
  return { text: `HubSpot import: ${mapping.property}=${raw.slice(0, 200)}`, at: importedAt };
}

export type HubSpotImportRow = ImportCandidate & { hubspot_id?: string; hubspot_company_id?: string };

type HubSpotRecord = { id: string; properties: Record<string, string | null | undefined>; associations?: Record<string, { results: { id: string }[] }> };
const clean = (v: string | null | undefined) => v?.trim() || undefined;

export function contactToCandidate(obj: HubSpotRecord, row: number, mapping: ConsentMapping, importedAt: string): HubSpotImportRow {
  const p = obj.properties;
  const rawEmail = clean(p.email);
  const email = normalizeEmail(rawEmail);
  const website = clean(p.website);
  const candidate: HubSpotImportRow = {
    row,
    email,
    rawEmail,
    name: [clean(p.firstname), clean(p.lastname)].filter(Boolean).join(" ") || undefined,
    title: clean(p.jobtitle),
    company: clean(p.company),
    website,
    domain: normalizeDomain(website) ?? domainFromEmail(email) ?? undefined,
    hubspot_id: obj.id,
    hubspot_company_id: obj.associations?.companies?.results?.[0]?.id,
  };
  const consent = email ? hubspotConsent(p, mapping, importedAt) : undefined;
  if (consent) candidate.consent = consent;
  return candidate;
}

/** A HubSpot company becomes a company-only lead (no email, no person name), deduped by domain. */
export function companyToCandidate(obj: HubSpotRecord, row: number): HubSpotImportRow {
  const p = obj.properties;
  const website = clean(p.website);
  return {
    row,
    company: clean(p.name),
    website,
    domain: normalizeDomain(clean(p.domain)) ?? normalizeDomain(website) ?? undefined,
    hubspot_company_id: obj.id,
  };
}
