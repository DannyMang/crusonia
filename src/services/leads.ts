// Leads: agent-found people/companies (no consent), listing, detail, evidence and scoring.
// Every write also appends an `events` row in the same statement or transaction.
import { z } from "zod";
import type { Approval, Draft, Lead, Sql } from "../db.ts";
import { newId, variantFor } from "../ids.ts";
import { ServiceError } from "./errors.ts";

// Stages a lead can be in (see schema.sql). Agent-found leads start (and stay) in `no_consent`.
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
  "unsubscribed",
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

// Scoring moves a lead to qualified/disqualified only from these stages. Leads without consent keep
// `no_consent` (the verdict is still stored in `qualified`), and leads already in the send flow keep theirs.
const SCORABLE_STAGES: LeadStage[] = ["new", "researching", "qualified", "disqualified", "needs_review"];

export const MAX_LEADS_PER_CALL = 100;

const text = (max: number) => z.string().trim().min(1).max(max);

export const leadInputSchema = z.object({
  email: z.email().max(320).nullish().describe("Work email, if known. Omit rather than guess."),
  name: text(200).nullish().describe("Person's full name. Omit for a company-only lead."),
  title: text(200).nullish().describe("Job title, e.g. 'VP Sales'."),
  company: text(200).nullish().describe("Company name."),
  domain: text(253).nullish().describe("Company domain, e.g. 'acme.com'. Required when there is no email (used to dedupe)."),
  website: z.httpUrl().max(2048).nullish().describe("Company website URL. Used to derive the domain if `domain` is omitted."),
  linkedin_url: z.httpUrl().max(2048).nullish().describe("LinkedIn profile or company page URL."),
  source: text(100).describe("Short label for where the lead was found, e.g. 'google_search', 'company_website', 'apify:linkedin-profile-scraper'."),
  source_url: z.httpUrl().max(2048).describe("URL of the page the lead was found on (provenance)."),
});
export type LeadInput = z.infer<typeof leadInputSchema>;

export type AddLeadResult = {
  status: "added" | "updated" | "skipped";
  id?: string;
  email: string | null;
  domain: string | null;
  name: string | null;
  stage?: string;
  reason?: string;
};

/** "https://www.Acme.com/about" or "WWW.acme.com" -> "acme.com". Returns null if it doesn't look like a domain. */
export function normalizeDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  let host = value.trim().toLowerCase();
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(host) ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

type Row = {
  id: string;
  email: string | null;
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

/**
 * Upserts agent-found leads. Dedupes by email, else by company domain + name. Never touches consent or
 * stage of an existing lead, and keeps the first-seen name and `source`/`source_url`; newer title,
 * company, website and LinkedIn values replace older ones. New leads get stage
 * `no_consent`: Crusonia never emails them (sends require recorded consent).
 */
export async function addLeads(sql: Sql, inputs: LeadInput[]): Promise<{ results: AddLeadResult[]; counts: Record<string, number> }> {
  if (inputs.length > MAX_LEADS_PER_CALL) {
    throw new ServiceError("invalid", `Send at most ${MAX_LEADS_PER_CALL} leads per call (got ${inputs.length}).`);
  }

  const results: AddLeadResult[] = [];
  const byKey = new Map<string, Row>();
  const order: { key: string | null; merged?: boolean; result: AddLeadResult }[] = [];

  for (const input of inputs) {
    const email = input.email ? input.email.trim().toLowerCase() : null;
    const domain = normalizeDomain(input.domain) ?? normalizeDomain(input.website);
    const name = input.name?.trim() || null;
    const base = { email, domain, name };
    if (!email && !domain) {
      order.push({ key: null, result: { status: "skipped", ...base, reason: "Needs an email, or a company domain/website to dedupe on." } });
      continue;
    }
    const key = email ? `e:${email}` : `d:${domain}|${(name ?? "").toLowerCase()}`;
    const existing = byKey.get(key);
    if (existing) {
      // Same lead twice in one call: fill gaps from the later copy.
      existing.name ??= name;
      existing.title ??= input.title ?? null;
      existing.company ??= input.company ?? null;
      existing.domain ??= domain;
      existing.website ??= input.website ?? null;
      existing.linkedin_url ??= input.linkedin_url ?? null;
      order.push({ key, merged: true, result: { status: "skipped", ...base, reason: "Duplicate of an earlier lead in this call (merged into it)." } });
      continue;
    }
    byKey.set(key, {
      id: newId("lead"),
      email,
      name,
      title: input.title ?? null,
      company: input.company ?? null,
      domain,
      website: input.website ?? null,
      linkedin_url: input.linkedin_url ?? null,
      source: input.source,
      source_url: input.source_url,
      variant: await variantFor(email ?? key),
    });
    order.push({ key, result: { status: "added", ...base } });
  }

  const rows = [...byKey.values()];
  const withEmail = rows.filter((r) => r.email);
  const withoutEmail = rows.filter((r) => !r.email);

  // People who asked not to be contacted are not stored again.
  const suppressed = new Set<string>();
  if (withEmail.length) {
    const found = await sql`select email from suppressions where email = any(${withEmail.map((r) => r.email)}::text[])`;
    for (const r of found) suppressed.add(r.email as string);
  }
  const emailRows = withEmail.filter((r) => !suppressed.has(r.email!));

  const queries = [];
  if (emailRows.length) {
    const json = JSON.stringify(emailRows);
    // A person first stored without an email (domain + name) gets the email attached instead of a duplicate row.
    queries.push(sql`
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
      from promoted`);
    queries.push(sql`
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
      select 'e:' || email as key, id, stage, inserted from up`);
  }
  if (withoutEmail.length) {
    const json = JSON.stringify(withoutEmail);
    queries.push(sql`
      with input as (
        select * from jsonb_to_recordset(${json}::jsonb) as x(
          id text, name text, title text, company text, domain text, website text,
          linkedin_url text, source text, source_url text, variant text)
      ),
      up as (
        insert into leads as l (id, email, name, title, company, domain, website, linkedin_url, source, source_url, variant, stage)
        select id, null, name, title, company, domain, website, linkedin_url, source, source_url, variant, 'no_consent' from input
        on conflict (domain, (coalesce(lower(name), ''))) where email is null do update set
          title = coalesce(excluded.title, l.title),
          company = coalesce(excluded.company, l.company),
          website = coalesce(excluded.website, l.website),
          linkedin_url = coalesce(excluded.linkedin_url, l.linkedin_url),
          updated_at = now()
        returning l.id, l.domain, l.name, l.stage, (l.xmax = 0) as inserted
      ),
      ev as (
        insert into events (lead_id, kind, data)
        select up.id, case when up.inserted then 'lead_added' else 'lead_updated' end,
               jsonb_build_object('via', 'mcp', 'source', i.source, 'source_url', i.source_url)
        from up join input i on i.domain = up.domain and coalesce(lower(i.name), '') = coalesce(lower(up.name), '')
      )
      select 'd:' || domain || '|' || coalesce(lower(name), '') as key, id, stage, inserted from up`);
  }

  const outcome = new Map<string, { id: string; stage: string; inserted: boolean }>();
  if (queries.length) {
    const sets = await sql.transaction(queries);
    for (const set of sets) for (const r of set) if (r.key) outcome.set(r.key as string, r as never);
  }

  for (const { key, merged, result } of order) {
    if (key && merged) {
      result.id = outcome.get(key)?.id;
    } else if (key) {
      const email = key.startsWith("e:") ? key.slice(2) : null;
      if (email && suppressed.has(email)) {
        Object.assign(result, { status: "skipped", reason: "Email is on the suppression list (asked not to be contacted)." });
      } else {
        const o = outcome.get(key);
        if (o) Object.assign(result, { status: o.inserted ? "added" : "updated", id: o.id, stage: o.stage });
        else Object.assign(result, { status: "skipped", reason: "Not stored (unexpected): retry this lead." });
      }
    }
    results.push(result);
  }

  const counts = { added: 0, updated: 0, skipped: 0 };
  for (const r of results) counts[r.status]++;
  return { results, counts };
}

export type LeadSummary = Pick<
  Lead,
  "id" | "email" | "name" | "title" | "company" | "domain" | "stage" | "score" | "qualified" | "source" | "updated_at"
> & { has_consent: boolean };

export async function listLeads(sql: Sql, opts: { stage?: LeadStage | null; limit?: number } = {}): Promise<LeadSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200);
  const stage = opts.stage ?? null;
  const rows = await sql`
    select id, email, name, title, company, domain, stage, score, qualified, source, updated_at,
           consent_at is not null as has_consent
    from leads
    where (${stage}::text is null or stage = ${stage})
    order by updated_at desc, id
    limit ${limit}`;
  return rows as LeadSummary[];
}

export type Evidence = { id: string; lead_id: string; claim: string; source_url: string; created_at: Date };

export type LeadDetail = {
  lead: Lead & { has_consent: boolean };
  evidence: Evidence[];
  drafts: Draft[];
  approvals: Approval[];
};

export async function getLeadDetail(sql: Sql, id: string): Promise<LeadDetail> {
  const [leads, evidence, drafts, approvals] = await sql.transaction(
    [
      sql`select *, consent_at is not null as has_consent from leads where id = ${id}`,
      sql`select * from evidence where lead_id = ${id} order by id`,
      sql`select * from drafts where lead_id = ${id} order by version desc`,
      sql`select * from approvals where lead_id = ${id} order by created_at desc`,
    ],
    { readOnly: true },
  );
  const lead = leads?.[0];
  if (!lead) throw new ServiceError("not_found", `No lead with id ${id}. Use list_leads to find lead ids.`);
  return {
    lead: lead as LeadDetail["lead"],
    evidence: evidence as Evidence[],
    drafts: drafts as Draft[],
    approvals: approvals as Approval[],
  };
}

export const evidenceInputSchema = z.object({
  lead_id: text(64).describe("Lead id, e.g. 'lead_3f2a...' (from add_leads or list_leads)."),
  claim: text(2000).describe("One factual statement about the lead or their company, e.g. 'Hiring 3 SDRs (job post, Oct 2026)'."),
  source_url: z.httpUrl().max(2048).describe("Public URL that supports the claim."),
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

export async function scoreLead(sql: Sql, input: z.infer<typeof scoreInputSchema>): Promise<LeadSummary> {
  const rows = await sql`
    with up as (
      update leads set
        score = ${input.score},
        qualified = ${input.qualified},
        rationale = ${input.rationale},
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
