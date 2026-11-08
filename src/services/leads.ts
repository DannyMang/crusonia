// Leads: agent-found people/companies (no consent), listing, detail, evidence and scoring.
// Every write also appends an `events` row in the same statement or transaction.
// Batched writes keep agent round trips down (each MCP call in a Naive session that read people's data waits for a
// confirmation): add_leads takes inline evidence and a score per lead, save_research stores a lead's evidence,
// score, rationale and next step in one call.
import { z } from "zod";
import type { Approval, Draft, Lead, Sql } from "../db.ts";
import { newId, variantFor } from "../ids.ts";
import { normalizeDomain, whyNoDomain } from "./domains.ts";
import { missingEvidenceQuestion, missingRequirements, type RequirementGap } from "./qualification.ts";
import { OWNER_WORKSPACE_ID, workflowForLead } from "./workflow-defs.ts";
import { ServiceError } from "./errors.ts";

// Stages a lead can be in (see schema.sql). Agent-found leads start in `no_consent` (found, not scored yet). Scoring
// moves them to `qualified` or `disqualified` like any other lead; `has_consent` (consent_at) stays false, which is
// what keeps them out of email: a qualified lead without consent only gets manual-channel tasks.
export const LEAD_STAGES = [
  "new",
  "no_consent",
  "researching",
  "qualified",
  "disqualified",
  "needs_review",
  "awaiting_approval",
  "sent",
  "replied",
  "interested",
  "not_interested",
  // Set by the owner (PATCH /api/leads/:id) when a conversation turned into a meeting.
  "meeting_booked",
  "unsubscribed",
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

// Scoring moves a lead to qualified/disqualified only from these stages (found, in research, or scored before).
// Leads already in the send flow (awaiting_approval, sent, replied, ...) keep their stage.
export const SCORABLE_STAGES: LeadStage[] = ["new", "no_consent", "researching", "qualified", "disqualified", "needs_review"];

/** Evidence saved with a batch write: at most a few strong items per lead. */
export const MAX_EVIDENCE_PER_CALL = 5;

export const MAX_LEADS_PER_CALL = 100;

const text = (max: number) => z.string().trim().min(1).max(max);

export const evidenceItemSchema = z.object({
  claim: text(2000).describe("One factual statement about the lead or their company, e.g. 'Hiring 3 SDRs (job post, Oct 2026)'."),
  source_url: z.httpUrl().max(2048).describe("Public URL of the page that states it (not a search results page)."),
  requirement: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .nullish()
    .describe("The id of the qualification workflow's evidence requirement this item satisfies, if any (get_workflow)."),
});

const url = z.httpUrl().max(2048);

/** A named person at the company, from a public page you read. */
export const contactSchema = z.object({
  name: text(200).describe("Full name as the page states it."),
  title: text(200).nullish().describe("Job title, if the page states it."),
  linkedin_url: url.nullish().describe("Their LinkedIn profile URL, if you read it on a public page."),
  x_url: url.nullish().describe("Their X profile URL, if you read it on a public page."),
  github_url: url.nullish().describe("Their GitHub profile URL, if you read it on a public page."),
  source_url: url.describe("The page that names them."),
});
export type ContactInput = z.infer<typeof contactSchema>;

export const LINK_KINDS = ["website", "linkedin", "github", "x", "other"] as const;

/** A company link (its site, LinkedIn page, GitHub org, X account...), from a public page you read. */
export const linkSchema = z.object({
  url: url.describe("The link, e.g. https://github.com/acme or https://www.linkedin.com/company/acme."),
  kind: z.enum(LINK_KINDS).nullish().describe("website, linkedin, github, x or other. Inferred from the URL when omitted."),
  source_url: url.describe("The page you read it on (the company site itself for its own links)."),
});
export type LinkInput = z.infer<typeof linkSchema>;

export const leadInputSchema = z.object({
  email: z.email().max(320).nullish().describe("Work email, if known. Omit rather than guess."),
  name: text(200).nullish().describe("Person's full name. Omit for a company-only lead."),
  title: text(200).nullish().describe("Job title, e.g. 'VP Sales'."),
  company: text(200).nullish().describe("Company name."),
  domain: text(253)
    .nullish()
    .describe("The company's own domain, e.g. 'acme.com' (never a job board, LinkedIn or other host). Required when there is no email: one lead per company domain."),
  website: z.httpUrl().max(2048).nullish().describe("The company's own website. Used to derive the domain if `domain` is omitted."),
  linkedin_url: z.httpUrl().max(2048).nullish().describe("The person's LinkedIn profile (or the company page for a company-only lead)."),
  source: text(100).describe("Short label for where the lead was found, e.g. 'google_search', 'company_website', 'apify:linkedin-profile-scraper'."),
  source_url: z.httpUrl().max(2048).describe("URL of the page the lead was found on (provenance)."),
  contacts: z.array(contactSchema).max(10).default([]).describe("Optional: other named people at the company, from pages you read."),
  links: z.array(linkSchema).max(10).default([]).describe("Optional: company links (LinkedIn page, GitHub org, X account...) from pages you read."),
  evidence: z
    .array(evidenceItemSchema)
    .max(MAX_EVIDENCE_PER_CALL)
    .default([])
    .describe("Optional: the facts that make it a match, each with the URL of the page that states it (1-3 strong items)."),
  score: z.number().int().min(0).max(100).nullish().describe("Optional: fit with the profile, 0-100. Send with qualified and rationale."),
  qualified: z.boolean().nullish().describe("Optional: your verdict. Send with score and rationale."),
  rationale: text(4000).nullish().describe("Optional: why, citing the evidence. Send with score and qualified."),
  why_summary: text(1200)
    .nullish()
    .describe("Optional: why we picked this company, in 2-4 plain sentences, citing this lead's evidence items by number ([1] = its first evidence item)."),
}).refine(scoreComplete, { message: "Send score, qualified and rationale together (or none of them).", path: ["score"] });
/** add_leads input; defaults (empty evidence, contacts, links) may be omitted by callers outside MCP. */
export type LeadInput = z.input<typeof leadInputSchema>;

function scoreComplete(v: { score?: number | null; qualified?: boolean | null; rationale?: string | null }): boolean {
  const given = [v.score, v.qualified, v.rationale].filter((x) => x !== undefined && x !== null).length;
  return given === 0 || given === 3;
}

export type AddLeadResult = {
  /**
   * created: a new lead (company, or person with an email). merged: an existing company got something new (a person,
   * missing fields, evidence, a first score). known: already in Crusonia with nothing new, or excluded (disqualified
   * earlier, or excluded by the owner) and skipped. skipped: not stored (no usable domain or email, suppressed).
   */
  status: "created" | "merged" | "known" | "skipped";
  id?: string;
  email: string | null;
  domain: string | null;
  name: string | null;
  stage?: string;
  reason?: string;
  /** Inline evidence saved for this lead (new items only), and whether its inline score was stored. */
  evidence_saved?: number;
  scored?: boolean;
};

export { normalizeDomain };

type EmailRow = {
  id: string;
  email: string;
  name: string | null;
  title: string | null;
  company: string | null;
  domain: string | null;
  website: string | null;
  linkedin_url: string | null;
  source: string;
  source_url: string;
  variant: "A" | "B";
};

type CompanyRow = {
  id: string;
  domain: string;
  name: string | null;
  title: string | null;
  company: string | null;
  website: string | null;
  linkedin_url: string | null;
  source: string;
  source_url: string;
  variant: "A" | "B";
};

type Target = { domain: string; id: string; stage: string; score: number | null; excluded: boolean; created: boolean };

const EXCLUDED_REASON =
  "Already in Crusonia and excluded (disqualified earlier or excluded by the owner): skipped. The owner can un-exclude it.";

/**
 * Upserts agent-found leads, one lead per company. Without an email, a lead is keyed by its company's normalized
 * domain (./domains.ts: registrable, never a job board or other host): a company already in Crusonia gets the new
 * contacts, links, missing fields, evidence and (if it had none) score merged in instead of a second row; a company that was
 * disqualified or excluded by the owner is remembered and skipped. With an email, the lead is a person deduped by
 * email (as before). Never touches consent, or the stage of an existing lead (except through its first score);
 * keeps the first-seen name and `source`/`source_url`. New leads get stage `no_consent`: Crusonia never emails them
 * (sends require recorded consent). Concurrent calls for the same domain are serialized by an advisory lock.
 * TODO(workspaces): a unique index on (workspace_id, domain) for company rows replaces the lock.
 */
export async function addLeads(sql: Sql, inputs: LeadInput[]): Promise<{ results: AddLeadResult[]; counts: Record<string, number> }> {
  if (inputs.length > MAX_LEADS_PER_CALL) {
    throw new ServiceError("invalid", `Send at most ${MAX_LEADS_PER_CALL} leads per call (got ${inputs.length}).`);
  }

  const results: AddLeadResult[] = [];
  const byEmail = new Map<string, EmailRow>();
  const byDomain = new Map<string, CompanyRow>();
  const keyOf: (string | null)[] = [];
  const firstOfKey = new Set<number>();

  for (const [i, input] of inputs.entries()) {
    const email = input.email ? input.email.trim().toLowerCase() : null;
    const domain = normalizeDomain(input.domain) ?? normalizeDomain(input.website);
    const name = input.name?.trim() || null;
    results.push({ status: "skipped", email, domain, name });
    if (!email && !domain) {
      const why = whyNoDomain(input.domain) ?? whyNoDomain(input.website);
      results[i]!.reason = why ? `No company domain: ${why}. Pass the company's own domain or website.` : "Needs an email, or the company's own domain or website.";
      keyOf.push(null);
      continue;
    }
    if (email) {
      const key = `e:${email}`;
      keyOf.push(key);
      const existing = byEmail.get(key);
      if (existing) {
        existing.name ??= name;
        existing.title ??= input.title ?? null;
        existing.company ??= input.company ?? null;
        existing.domain ??= domain;
        existing.website ??= input.website ?? null;
        existing.linkedin_url ??= input.linkedin_url ?? null;
        continue;
      }
      firstOfKey.add(i);
      byEmail.set(key, {
        id: newId("lead"), email, name, title: input.title ?? null, company: input.company ?? null, domain,
        website: input.website ?? null, linkedin_url: input.linkedin_url ?? null, source: input.source,
        source_url: input.source_url, variant: await variantFor(email),
      });
      continue;
    }
    const key = `d:${domain}`;
    keyOf.push(key);
    const existing = byDomain.get(key);
    if (existing) {
      // Same company twice in one call: one lead (its contacts, links and evidence are merged below).
      existing.company ??= input.company ?? null;
      existing.website ??= input.website ?? null;
      if (!existing.name && name) Object.assign(existing, { name, title: input.title ?? null, linkedin_url: input.linkedin_url ?? existing.linkedin_url });
      continue;
    }
    firstOfKey.add(i);
    byDomain.set(key, {
      id: newId("lead"), domain: domain!, name, title: input.title ?? null, company: input.company ?? null,
      website: input.website ?? null, linkedin_url: input.linkedin_url ?? null, source: input.source,
      source_url: input.source_url, variant: await variantFor(key),
    });
  }

  // People who asked not to be contacted are not stored again.
  const emailRows = [...byEmail.values()];
  const suppressed = new Set<string>();
  if (emailRows.length) {
    const found = await sql`select email from suppressions where email = any(${emailRows.map((r) => r.email)}::text[])`;
    for (const r of found) suppressed.add(r.email as string);
  }
  const outcome = new Map<string, { id: string; status: AddLeadResult["status"]; stage?: string; target?: Target }>();
  await upsertEmailLeads(sql, emailRows.filter((r) => !suppressed.has(r.email)), outcome);
  await upsertCompanies(sql, [...byDomain.values()], outcome);

  for (const [i, result] of results.entries()) {
    const key = keyOf[i];
    if (!key) continue;
    if (key.startsWith("e:") && suppressed.has(key.slice(2))) {
      Object.assign(result, { status: "skipped", reason: "Email is on the suppression list (asked not to be contacted)." });
      continue;
    }
    const o = outcome.get(key);
    if (!o) {
      Object.assign(result, { status: "skipped", reason: "Not stored (unexpected): retry this lead." });
      continue;
    }
    const excluded = o.status === "known" && o.target?.excluded;
    Object.assign(result, { id: o.id, stage: o.stage, status: firstOfKey.has(i) || excluded ? o.status : "merged" });
    if (excluded) result.reason = EXCLUDED_REASON;
    else if (!firstOfKey.has(i)) result.reason = "Same company or person as an earlier lead in this call: merged into it.";
  }

  // Inline research (evidence, a score, the why-summary) for every stored lead that has some, in one batch. An
  // existing company keeps its score and why-summary; it gains new evidence.
  const research = new Map<string, ResearchInput & { indices: number[] }>();
  for (const [i, input] of inputs.entries()) {
    const result = results[i]!;
    const o = keyOf[i] ? outcome.get(keyOf[i]!) : undefined;
    if (!result.id || !o || result.status === "skipped" || o.target?.excluded) continue;
    const hasScore = input.score !== undefined && input.score !== null;
    const contacts = leadContacts(input);
    const links = leadLinks(input, result.domain);
    if (!input.evidence?.length && !hasScore && !input.why_summary && !contacts.length && !links.length) continue;
    const fresh = o.status === "created" || !o.target || o.target.score === null;
    const item: ResearchInput & { indices: number[] } = research.get(result.id) ?? {
      lead_id: result.id,
      evidence: [],
      indices: [],
      why_mode: "if_empty",
      contacts: [],
      links: [],
      domain: result.domain,
    };
    const offset = item.evidence.length;
    item.evidence.push(...(input.evidence ?? []));
    item.contacts!.push(...contacts);
    item.links!.push(...links);
    item.indices.push(i);
    if (hasScore && fresh && item.score === undefined) Object.assign(item, { score: input.score!, qualified: input.qualified!, rationale: input.rationale! });
    // Citations are numbered per lead in this call; shift them when several inputs fold into one lead.
    if (input.why_summary && !item.why_summary) item.why_summary = offset ? shiftCitations(input.why_summary, offset) : input.why_summary;
    research.set(result.id, item);
  }
  if (research.size) {
    const saved = await saveResearchBatch(sql, [...research.values()]);
    for (const r of saved) {
      const item = research.get(r.lead_id)!;
      for (const i of item.indices) {
        const result = results[i]!;
        result.evidence_saved = r.evidence_saved;
        if (r.scored) Object.assign(result, { scored: true, stage: r.stage });
        if (result.status === "known" && (r.evidence_saved > 0 || r.scored || r.contacts_added > 0 || r.links_added > 0)) {
          Object.assign(result, { status: "merged", reason: undefined });
        }
      }
    }
  }
  for (const r of results) if (r.status === "known" && !r.reason) r.reason = "Already in Crusonia: nothing new to add.";

  const counts = { created: 0, merged: 0, known: 0, skipped: 0 };
  for (const r of results) counts[r.status]++;
  return { results, counts };
}

async function upsertEmailLeads(sql: Sql, rows: EmailRow[], outcome: Map<string, { id: string; status: AddLeadResult["status"]; stage?: string }>) {
  if (!rows.length) return;
  const json = JSON.stringify(rows);
  const [, set] = await sql.transaction([
    // A person first stored without an email (domain + name) gets the email attached instead of a duplicate row.
    sql`
      with input as (
        select * from jsonb_to_recordset(${json}::jsonb) as x(email text, name text, domain text, source text, source_url text)
      ),
      promoted as (
        update leads l set email = i.email, updated_at = now()
        from input i
        where l.email is null and i.domain is not null and coalesce(i.name, '') <> ''
          and l.domain = i.domain and coalesce(lower(l.name), '') = lower(i.name)
          and not exists (select 1 from leads e where e.email = i.email)
        returning l.id, l.email, i.source, i.source_url
      )
      insert into events (lead_id, kind, data)
      select id, 'lead_email_found', jsonb_build_object('via', 'mcp', 'email', email, 'source', source, 'source_url', source_url)
      from promoted`,
    sql`
      with input as (
        select * from jsonb_to_recordset(${json}::jsonb) as x(
          id text, email text, name text, title text, company text, domain text, website text,
          linkedin_url text, source text, source_url text, variant text)
      ),
      up as (
        insert into leads as l (id, email, name, title, company, domain, website, linkedin_url, source, source_url, variant, stage)
        select id, email, name, title, company, domain, website, linkedin_url, source, source_url, variant, 'no_consent' from input
        on conflict (email) do update set
          name = coalesce(l.name, excluded.name),
          title = coalesce(excluded.title, l.title),
          company = coalesce(excluded.company, l.company),
          domain = coalesce(excluded.domain, l.domain),
          website = coalesce(excluded.website, l.website),
          linkedin_url = coalesce(excluded.linkedin_url, l.linkedin_url),
          updated_at = now()
        returning l.id, l.email, l.stage, (l.xmax = 0) as inserted
      ),
      ev as (
        insert into events (lead_id, kind, data)
        select up.id, case when up.inserted then 'lead_added' else 'lead_updated' end,
               jsonb_build_object('via', 'mcp', 'source', i.source, 'source_url', i.source_url)
        from up join input i on i.email = up.email
      )
      select 'e:' || email as key, id, stage, inserted from up`,
  ]);
  for (const r of set ?? []) outcome.set(r.key as string, { id: r.id as string, stage: r.stage as string, status: r.inserted ? "created" : "merged" });
}

async function upsertCompanies(sql: Sql, rows: CompanyRow[], outcome: Map<string, { id: string; status: AddLeadResult["status"]; stage?: string; target?: Target }>) {
  if (!rows.length) return;
  const json = JSON.stringify(rows);
  const domains = rows.map((r) => r.domain).sort();
  const input = sql`select * from jsonb_to_recordset(${json}::jsonb) as x(
    id text, domain text, name text, title text, company text, website text, linkedin_url text,
    source text, source_url text, variant text)`;
  // The lead that stands for each domain: the one just created, else the oldest company row (no email), else the
  // oldest person row with that domain.
  const targets = sql`
    select distinct on (i.domain) i.domain, l.id, l.stage, l.score, (l.excluded_at is not null or l.stage = 'disqualified') as excluded,
           (l.id = i.id) as created
    from input i join leads l on l.domain = i.domain
    order by i.domain, (l.id = i.id) desc, (l.email is null) desc, l.created_at, l.id`;
  const [, , found] = await sql.transaction([
    sql`select count(pg_advisory_xact_lock(hashtext('crusonia:lead-domain:' || d)))::int as locked
        from (select d from unnest(${domains}::text[]) as d order by d) s`,
    sql`
      with input as (${input}),
      ins as (
        insert into leads (id, email, name, title, company, domain, website, linkedin_url, source, source_url, variant, stage)
        select id, null, name, title, company, domain, website, linkedin_url, source, source_url, variant, 'no_consent'
        from input i
        where not exists (select 1 from leads e where e.domain = i.domain)
        on conflict do nothing
        returning id
      )
      insert into events (lead_id, kind, data)
      select ins.id, 'lead_added', jsonb_build_object('via', 'mcp', 'source', i.source, 'source_url', i.source_url)
      from ins join input i on i.id = ins.id`,
    sql`
      with input as (${input}),
      t as (${targets}),
      up as (
        update leads l set
          company = coalesce(l.company, i.company),
          website = coalesce(l.website, i.website),
          name = coalesce(l.name, i.name),
          title = case when l.name is null and i.name is not null then i.title else l.title end,
          linkedin_url = case when l.name is null and i.name is not null then coalesce(i.linkedin_url, l.linkedin_url) else l.linkedin_url end,
          updated_at = now()
        from input i join t on t.domain = i.domain
        where l.id = t.id and not t.created and not t.excluded
          and ((l.company is null and i.company is not null) or (l.website is null and i.website is not null)
               or (l.name is null and i.name is not null))
        returning l.id, l.stage
      ),
      ev as (
        insert into events (lead_id, kind, data)
        select up.id, 'lead_updated', jsonb_build_object('via', 'mcp', 'merged', true, 'source', i.source, 'source_url', i.source_url)
        from up join t on t.id = up.id join input i on i.domain = t.domain
      )
      select t.domain, t.id, coalesce(up.stage, t.stage) as stage, t.score, t.excluded, t.created, (up.id is not null) as merged
      from t left join up on up.id = t.id`,
  ]);
  for (const r of (found ?? []) as (Target & { merged: boolean })[]) {
    const target: Target = { domain: r.domain, id: r.id, stage: r.stage, score: r.score, excluded: r.excluded, created: r.created };
    outcome.set(`d:${r.domain}`, { id: r.id, stage: r.stage, status: r.created ? "created" : r.merged ? "merged" : "known", target });
  }
}

export type Contact = {
  name: string;
  title: string | null;
  linkedin_url: string | null;
  x_url: string | null;
  github_url: string | null;
  source_url: string;
  /** When we stored it (YYYY-MM-DD). */
  found_at: string;
};
export type Link = { kind: (typeof LINK_KINDS)[number]; url: string; source_url: string; found_at: string };

const today = () => new Date().toISOString().slice(0, 10);

export function toContact(c: ContactInput): Contact {
  return {
    name: c.name.trim(),
    title: c.title ?? null,
    linkedin_url: c.linkedin_url ?? null,
    x_url: c.x_url ?? null,
    github_url: c.github_url ?? null,
    source_url: c.source_url,
    found_at: today(),
  };
}

/** A link's kind from its host: the company's own domain is its website. */
export function linkKind(rawUrl: string, companyDomain: string | null): Link["kind"] {
  let host = "";
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/^(www|mobile|m)\./, "");
  } catch {
    return "other";
  }
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "linkedin";
  if (host === "github.com") return "github";
  if (host === "x.com" || host === "twitter.com") return "x";
  if (companyDomain && (host === companyDomain || host.endsWith(`.${companyDomain}`))) return "website";
  return "other";
}

export function toLink(l: LinkInput, companyDomain: string | null): Link {
  return { kind: l.kind ?? linkKind(l.url, companyDomain), url: l.url, source_url: l.source_url, found_at: today() };
}

/** add_leads: the lead's person and its listed contacts. */
function leadContacts(input: LeadInput): Contact[] {
  const list = (input.contacts ?? []).map(toContact);
  const name = input.name?.trim();
  if (name) list.unshift(toContact({ name, title: input.title ?? null, linkedin_url: input.linkedin_url ?? null, source_url: input.source_url }));
  return list;
}

/** add_leads: the company website and the listed links (a LinkedIn company page given as linkedin_url counts too). */
function leadLinks(input: LeadInput, domain: string | null): Link[] {
  const list = (input.links ?? []).map((l) => toLink(l, domain));
  if (input.website) list.unshift(toLink({ url: input.website, kind: "website", source_url: input.source_url }, domain));
  if (input.linkedin_url && /linkedin\.com\/company\//i.test(input.linkedin_url)) list.push(toLink({ url: input.linkedin_url, kind: "linkedin", source_url: input.source_url }, domain));
  return list;
}

/** "[1] and [2, 3]" with offset 2 -> "[3] and [4, 5]". */
function shiftCitations(text: string, offset: number): string {
  return text.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_m, inner: string) => `[${inner.split(",").map((n) => Number(n.trim()) + offset).join(", ")}]`);
}

/**
 * Rewrites "[n]" citations that number the evidence items of one call (1-based) to their numbers in the lead's
 * evidence list (`positions[n - 1]`, oldest first, as get_lead shows them). Citations of items that were not saved
 * are dropped.
 */
export function renumberCitations(text: string, positions: (number | undefined)[]): string {
  return text
    .replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_m, inner: string) => {
      const nums = [...new Set(inner.split(",").map((n) => positions[Number(n.trim()) - 1]).filter((n): n is number => n !== undefined))];
      return nums.length ? `[${nums.join(", ")}]` : "";
    })
    .replace(/[ \t]+([.,;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export type LeadSummary = Pick<
  Lead,
  "id" | "email" | "name" | "title" | "company" | "domain" | "stage" | "score" | "qualified" | "source" | "updated_at"
> & { has_consent: boolean; linkedin_url?: string | null; next_step?: string | null; why_summary?: string | null; review_question?: string | null };

export async function listLeads(sql: Sql, opts: { stage?: LeadStage | null; limit?: number } = {}): Promise<LeadSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200);
  const stage = opts.stage ?? null;
  const rows = await sql`
    select id, email, name, title, company, domain, linkedin_url, stage, score, qualified, next_step, source, updated_at,
           consent_at is not null as has_consent
    from leads
    where (${stage}::text is null or stage = ${stage})
    order by updated_at desc, id
    limit ${limit}`;
  return rows as LeadSummary[];
}

export type Evidence = { id: string; lead_id: string; claim: string; source_url: string; created_at: Date; n?: number };

export type LeadNote = { id: string; author: string; kind: string; body: string; created_at: Date; updated_at: Date };

export type LeadDetail = {
  lead: Lead & { has_consent: boolean };
  /** Oldest first; `n` is the number a why-summary cites ([1] = the first). */
  evidence: Evidence[];
  drafts: Draft[];
  approvals: Approval[];
  /** Newest first: the owner's (`user:...`) and agents' (`agent:...`) notes on this company. */
  notes: LeadNote[];
};

export async function getLeadDetail(sql: Sql, id: string): Promise<LeadDetail> {
  const [leads, evidence, drafts, approvals, notes] = await sql.transaction(
    [
      sql`select *, consent_at is not null as has_consent from leads where id = ${id}`,
      sql`select * from evidence where lead_id = ${id} order by id`,
      sql`select * from drafts where lead_id = ${id} order by version desc`,
      sql`select * from approvals where lead_id = ${id} order by created_at desc`,
      sql`select id::text, author, kind, body, created_at, updated_at from lead_notes where lead_id = ${id} order by id desc limit 100`,
    ],
    { readOnly: true },
  );
  const lead = leads?.[0];
  if (!lead) throw new ServiceError("not_found", `No lead with id ${id}. Use list_leads to find lead ids.`);
  return {
    lead: lead as LeadDetail["lead"],
    evidence: (evidence as Evidence[]).map((e, i) => ({ ...e, n: i + 1 })),
    drafts: drafts as Draft[],
    approvals: approvals as Approval[],
    notes: notes as LeadNote[],
  };
}

export const evidenceInputSchema = evidenceItemSchema.extend({
  lead_id: text(64).describe("Lead id, e.g. 'lead_3f2a...' (from add_leads or list_leads)."),
});

export async function saveEvidence(sql: Sql, input: z.infer<typeof evidenceInputSchema>): Promise<Evidence> {
  const rows = await sql`
    with ins as (
      insert into evidence (lead_id, claim, source_url)
      select id, ${input.claim}, ${input.source_url} from leads where id = ${input.lead_id}
      returning *
    ),
    ev as (
      insert into events (lead_id, kind, data)
      select lead_id, 'evidence_saved', jsonb_build_object('via', 'mcp', 'evidence_id', id, 'source_url', source_url) from ins
    ),
    touch as (update leads set updated_at = now() where id in (select lead_id from ins))
    select * from ins`;
  if (!rows[0]) throw new ServiceError("not_found", `No lead with id ${input.lead_id}. Use list_leads to find lead ids.`);
  return rows[0] as Evidence;
}

export const scoreInputSchema = z.object({
  lead_id: text(64).describe("Lead id to score."),
  score: z.number().int().min(0).max(100).describe("Fit with the saved ideal customer profile, 0 (no fit) to 100 (perfect fit)."),
  rationale: text(4000).describe("Why: cite the evidence (claims + URLs) the score is based on."),
  qualified: z.boolean().describe("Your verdict: is this lead worth pursuing?"),
});

/**
 * Required evidence the lead doesn't have yet, counting `adding` (this call's items). The requirements are those of
 * the workflow version the lead was run under, else the default workflow's (./workflow-defs.ts).
 */
async function evidenceGaps(sql: Sql, leadId: string, adding: { requirement?: string | null }[] = []): Promise<RequirementGap[]> {
  const workflow = await workflowForLead(sql, OWNER_WORKSPACE_ID, leadId);
  if (!workflow?.evidence_requirements.some((r) => r.required !== false)) return [];
  const rows = await sql`select distinct requirement from evidence where lead_id = ${leadId} and requirement is not null`;
  return missingRequirements(workflow, [...rows.map((r) => r.requirement as string), ...adding.map((e) => e.requirement)]);
}

export async function scoreLead(sql: Sql, input: z.infer<typeof scoreInputSchema>): Promise<LeadSummary> {
  // Pause on missing evidence: never a verdict without the workflow's required evidence.
  const gaps = await evidenceGaps(sql, input.lead_id);
  if (gaps.length) {
    throw new ServiceError(
      "invalid",
      `Lead ${input.lead_id} lacks required evidence (${gaps.map((g) => g.id).join(", ")}): save it with save_research, or flag the lead with flag_for_review instead of scoring.`,
    );
  }
  const rows = await sql`
    with up as (
      update leads set
        score = ${input.score},
        qualified = ${input.qualified},
        rationale = ${input.rationale},
        review_question = null,
        stage = case when stage = any(${SCORABLE_STAGES}::text[])
                     then (case when ${input.qualified}::boolean then 'qualified' else 'disqualified' end)
                     else stage end,
        updated_at = now()
      where id = ${input.lead_id}
      returning *
    ),
    ev as (
      insert into events (lead_id, kind, data)
      select id, 'lead_scored', jsonb_build_object('via', 'mcp', 'score', score, 'qualified', qualified, 'stage', stage) from up
    )
    select id, email, name, title, company, domain, stage, score, qualified, source, updated_at,
           consent_at is not null as has_consent
    from up`;
  if (!rows[0]) throw new ServiceError("not_found", `No lead with id ${input.lead_id}. Use list_leads to find lead ids.`);
  return rows[0] as LeadSummary;
}

// ---------- batched research (save_research, add_leads inline) ----------

export const researchInputSchema = z.object({
  lead_id: text(64).describe("Lead id to save research for."),
  evidence: z
    .array(evidenceItemSchema)
    .max(MAX_EVIDENCE_PER_CALL)
    .default([])
    .describe("The strongest facts you rely on (about 3), each with the URL of the page that states it. Already-saved items are skipped."),
  score: z.number().int().min(0).max(100).nullish().describe("Fit with the saved profile, 0 (no fit) to 100 (perfect fit). Omit when you set review_question."),
  qualified: z.boolean().nullish().describe("Your verdict: is this lead worth pursuing? Omit when you set review_question."),
  rationale: text(4000).nullish().describe("Two to four sentences citing the evidence, and what is still unknown."),
  review_question: text(500)
    .nullish()
    .describe("Set instead of a score when required evidence is missing or sources conflict: the one question that must be answered first. The lead goes to needs_review; never guess."),
  next_step: text(500)
    .nullish()
    .describe("Suggested next step for the owner, e.g. 'LinkedIn note to the CEO about the SDR job post' or 'none: not a fit'."),
  why_summary: text(1200)
    .nullish()
    .describe("Why we picked this company: 2-4 plain sentences citing the evidence items of this call by number ([1] = the first item). To cite something already saved, include it in evidence again (it is not saved twice)."),
  contacts: z.array(contactSchema).max(10).default([]).describe("Named people at the company you read about on public pages (merged by name)."),
  links: z.array(linkSchema).max(10).default([]).describe("Company links you read on public pages: LinkedIn page, GitHub org, X account... (merged by URL)."),
}).refine((v) => Boolean(v.review_question) || (scoreComplete(v) && v.score !== undefined && v.score !== null), {
  message: "Send score, qualified and rationale, or a review_question when evidence is missing.",
  path: ["score"],
});
export type ResearchSaveInput = z.input<typeof researchInputSchema>;

type ResearchInput = {
  lead_id: string;
  evidence: { claim: string; source_url: string; requirement?: string | null }[];
  score?: number;
  qualified?: boolean;
  rationale?: string;
  next_step?: string | null;
  /** Cites `evidence` by number (1-based, this call); stored with the numbers of the lead's evidence list. */
  why_summary?: string | null;
  /** set: replace the lead's why-summary (save_research). if_empty: only when it has none (add_leads). */
  why_mode?: "set" | "if_empty";
  contacts?: Contact[];
  links?: Link[];
  /** The lead's company domain, to tell its website from other links. */
  domain?: string | null;
};

export type ResearchResult = {
  lead_id: string;
  evidence_saved: number;
  scored: boolean;
  stage: string | null;
  contacts_added: number;
  links_added: number;
};

function dedupeBy<T>(list: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((t) => {
    const k = key(t);
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

const contactKey = (c: { name: string }) => c.name.trim().toLowerCase();
const linkKey = (l: { url: string }) => l.url.trim().replace(/\/+$/, "").toLowerCase();

/**
 * Evidence (deduped on lead + claim + URL), contacts (merged by name) and links (merged by URL), and, when given, the
 * score, verdict, rationale and next step for one or more leads, in one transaction under a per-lead lock. Scoring
 * follows score_lead's stage rules. Leads that do not exist are skipped.
 */
export async function saveResearchBatch(sql: Sql, items: ResearchInput[]): Promise<ResearchResult[]> {
  if (!items.length) return [];
  // Deduped here (not with DISTINCT ON) so the insert keeps the call's order: evidence ids follow `ord`.
  const seen = new Set<string>();
  const evidence = items
    .flatMap((i) => i.evidence.map((e) => ({ lead_id: i.lead_id, claim: e.claim, source_url: e.source_url, requirement: e.requirement ?? null })))
    .filter((e) => {
      const k = JSON.stringify([e.lead_id, e.claim, e.source_url]);
      return seen.has(k) ? false : (seen.add(k), true);
    })
    .map((e, ord) => ({ ...e, ord }));
  const scores = items
    .filter((i) => i.score !== undefined)
    .map((i) => ({ lead_id: i.lead_id, score: i.score, qualified: i.qualified, rationale: i.rationale, next_step: i.next_step ?? null }));
  const people = items
    .filter((i) => i.contacts?.length || i.links?.length)
    .map((i) => ({ id: i.lead_id, contacts: dedupeBy(i.contacts ?? [], contactKey), links: dedupeBy(i.links ?? [], linkKey) }));
  const ids = [...new Set(items.map((i) => i.lead_id))].sort();
  const [, savedRows, scoredRows, , mergedRows] = await sql.transaction([
    sql`select count(pg_advisory_xact_lock(hashtext('crusonia:lead:' || id)))::int as locked from (select unnest(${ids}::text[]) as id order by 1) s`,
    sql`
      with input as (
        select * from jsonb_to_recordset(${JSON.stringify(evidence)}::jsonb) as x(lead_id text, claim text, source_url text, requirement text, ord int)
      ),
      tag as (
        -- An item saved before without its requirement id gets it now.
        update evidence e set requirement = i.requirement
        from input i
        where e.lead_id = i.lead_id and e.claim = i.claim and e.source_url = i.source_url and i.requirement is not null and e.requirement is null
      ),
      ins as (
        insert into evidence (lead_id, claim, source_url, requirement)
        select i.lead_id, i.claim, i.source_url, i.requirement from input i
        where exists (select 1 from leads l where l.id = i.lead_id)
          and not exists (select 1 from evidence e where e.lead_id = i.lead_id and e.claim = i.claim and e.source_url = i.source_url)
        order by i.ord
        returning *
      ),
      ev as (
        insert into events (lead_id, kind, data)
        select lead_id, 'evidence_saved', jsonb_build_object('via', 'mcp', 'evidence_id', id, 'source_url', source_url) from ins
      )
      select lead_id, count(*)::int as n from ins group by lead_id`,
    sql`
      with input as (
        select * from jsonb_to_recordset(${JSON.stringify(scores)}::jsonb)
          as x(lead_id text, score int, qualified boolean, rationale text, next_step text)
      ),
      up as (
        update leads l set
          score = i.score,
          qualified = i.qualified,
          rationale = i.rationale,
          review_question = null,
          next_step = coalesce(i.next_step, l.next_step),
          stage = case when l.stage = any(${SCORABLE_STAGES}::text[])
                       then (case when i.qualified then 'qualified' else 'disqualified' end)
                       else l.stage end,
          updated_at = now()
        from input i
        where l.id = i.lead_id
        returning l.id, l.score, l.qualified, l.stage, l.consent_at is not null as has_consent
      ),
      ev as (
        insert into events (lead_id, kind, data)
        select id, 'lead_scored', jsonb_build_object('via', 'mcp', 'score', score, 'qualified', qualified, 'stage', stage) from up
      )
      select id, stage from up`,
    sql`update leads set updated_at = now() where id = any(${[...new Set(evidence.map((e) => e.lead_id))]}::text[])`,
    sql`
      with x as (select * from jsonb_to_recordset(${JSON.stringify(people)}::jsonb) as x(id text, contacts jsonb, links jsonb)),
      n as (
        select l.id,
               coalesce((select jsonb_agg(c) from jsonb_array_elements(x.contacts) c
                         where not exists (select 1 from jsonb_array_elements(l.contacts) e where lower(e->>'name') = lower(c->>'name'))), '[]'::jsonb) as newc,
               coalesce((select jsonb_agg(k) from jsonb_array_elements(x.links) k
                         where not exists (select 1 from jsonb_array_elements(l.links) e
                                           where lower(rtrim(e->>'url', '/')) = lower(rtrim(k->>'url', '/')))), '[]'::jsonb) as newl
        from leads l join x on x.id = l.id
      ),
      up as (
        update leads l set contacts = l.contacts || n.newc, links = l.links || n.newl, updated_at = now()
        from n where l.id = n.id and (jsonb_array_length(n.newc) > 0 or jsonb_array_length(n.newl) > 0)
        returning l.id
      ),
      ev as (
        insert into events (lead_id, kind, data)
        select n.id, 'lead_updated', jsonb_build_object('via', 'mcp', 'contacts_added', jsonb_array_length(n.newc), 'links_added', jsonb_array_length(n.newl))
        from n join up on up.id = n.id
      )
      select id, jsonb_array_length(newc)::int as contacts_added, jsonb_array_length(newl)::int as links_added from n`,
  ]);
  const saved = new Map((savedRows as { lead_id: string; n: number }[]).map((r) => [r.lead_id, r.n]));
  const scored = new Map((scoredRows as { id: string; stage: string }[]).map((r) => [r.id, r.stage]));
  const merged = new Map((mergedRows as { id: string; contacts_added: number; links_added: number }[]).map((r) => [r.id, r]));
  await saveWhySummaries(sql, items.filter((i) => i.why_summary));
  return items.map((i) => ({
    lead_id: i.lead_id,
    evidence_saved: saved.get(i.lead_id) ?? 0,
    scored: scored.has(i.lead_id),
    stage: scored.get(i.lead_id) ?? null,
    contacts_added: merged.get(i.lead_id)?.contacts_added ?? 0,
    links_added: merged.get(i.lead_id)?.links_added ?? 0,
  }));
}

/**
 * Stores why-summaries with their citations renumbered from the call's evidence items to the lead's evidence list
 * (oldest first, 1-based: the numbers get_lead shows).
 */
async function saveWhySummaries(sql: Sql, items: ResearchInput[]): Promise<void> {
  if (!items.length) return;
  const rows = (await sql`
    select lead_id, claim, source_url, row_number() over (partition by lead_id order by id)::int as n
    from evidence where lead_id = any(${items.map((i) => i.lead_id)}::text[])`) as { lead_id: string; claim: string; source_url: string; n: number }[];
  const position = new Map(rows.map((r) => [JSON.stringify([r.lead_id, r.claim, r.source_url]), r.n]));
  const updates = items.map((i) => ({
    id: i.lead_id,
    why: renumberCitations(i.why_summary!, i.evidence.map((e) => position.get(JSON.stringify([i.lead_id, e.claim, e.source_url])))),
    overwrite: i.why_mode === "set",
  }));
  await sql`
    update leads l set why_summary = x.why, updated_at = now()
    from jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) as x(id text, why text, overwrite boolean)
    where l.id = x.id and x.why <> '' and (x.overwrite or l.why_summary is null)`;
}

/** MCP save_research: one lead's evidence, score, rationale, next step and why-summary in one call. */
export async function saveResearch(sql: Sql, input: z.infer<typeof researchInputSchema>) {
  const [row] = await sql`select domain from leads where id = ${input.lead_id}`;
  if (!row) throw new ServiceError("not_found", `No lead with id ${input.lead_id}. Use list_leads to find lead ids.`);
  const domain = (row.domain as string | null) ?? null;
  // Pause on missing evidence: with required evidence missing (or the agent's own question), no score is stored and
  // the lead goes to needs_review with the question; the evidence, contacts and links found so far are kept.
  const gaps = await evidenceGaps(sql, input.lead_id, input.evidence);
  const review = input.review_question ?? (gaps.length ? missingEvidenceQuestion(gaps) : null);
  const scoring = !review && input.score !== undefined && input.score !== null;
  const [result] = await saveResearchBatch(sql, [
    {
      lead_id: input.lead_id,
      evidence: input.evidence,
      ...(scoring ? { score: input.score!, qualified: input.qualified!, rationale: input.rationale! } : {}),
      next_step: input.next_step,
      why_summary: input.why_summary,
      why_mode: "set",
      contacts: input.contacts.map(toContact),
      links: input.links.map((l) => toLink(l, domain)),
    },
  ]);
  if (scoring && !result?.scored) throw new ServiceError("not_found", `No lead with id ${input.lead_id}. Use list_leads to find lead ids.`);
  if (review) await flagForReview(sql, { lead_id: input.lead_id, question: review, missing: gaps.map((g) => g.id) });
  const [lead] = await sql`
    select id, email, name, title, company, domain, linkedin_url, stage, score, qualified, next_step, why_summary, review_question, source, updated_at,
           consent_at is not null as has_consent,
           (select count(*)::int from evidence where lead_id = leads.id) as evidence_total
    from leads where id = ${input.lead_id}`;
  const summary = lead as LeadSummary & { evidence_total: number };
  return {
    lead: summary,
    evidence_saved: result?.evidence_saved ?? 0,
    contacts_added: result?.contacts_added ?? 0,
    links_added: result?.links_added ?? 0,
    // Set when the lead was not scored: required evidence ids still missing, and the question it waits on.
    ...(review ? { needs_review: true, missing_requirements: gaps, review_question: review } : {}),
    // What the agent may do next, so it never has to ask: email only with consent, manual channels otherwise.
    draft_channels: !summary.qualified || summary.stage === "needs_review" ? [] : summary.has_consent && summary.email ? ["email"] : ["linkedin", "x", "intro", ...(summary.email ? ["email_manual"] : [])],
  };
}

export const flagInputSchema = z.object({
  lead_id: text(64).describe("Lead id to flag."),
  question: text(500).describe("The one specific question that must be answered before the lead can be scored, e.g. 'Is acme.io the same company as Acme Labs?'"),
  missing: z.array(text(64)).max(20).default([]).describe("Ids of the workflow's evidence requirements you could not source, if any."),
});

/**
 * The lead waits for a person: stage needs_review (from a found, researching or scored stage; leads in the send flow
 * keep theirs) with the question. Research of other leads goes on; scoring it later clears the question.
 */
export async function flagForReview(sql: Sql, input: { lead_id: string; question: string; missing?: string[] }) {
  const rows = await sql`
    with up as (
      update leads set review_question = ${input.question},
             stage = case when stage = any(${SCORABLE_STAGES}::text[]) then 'needs_review' else stage end,
             updated_at = now()
      where id = ${input.lead_id}
      returning id, stage, review_question
    ),
    ev as (
      insert into events (lead_id, kind, data)
      select id, 'lead_needs_review', jsonb_build_object('via', 'mcp', 'question', review_question, 'missing', ${JSON.stringify(input.missing ?? [])}::jsonb, 'stage', stage)
      from up
    )
    select * from up`;
  if (!rows[0]) throw new ServiceError("not_found", `No lead with id ${input.lead_id}. Use list_leads to find lead ids.`);
  return rows[0] as { id: string; stage: string; review_question: string };
}
