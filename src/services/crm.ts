// Owner-side lead management for the REST API: filtered listing, full detail with the timeline, create
// (opted-in contacts), patch (stage, consent, fields), delete and imports (CSV here; HubSpot records go
// through the same applyImportCandidates from ./crm-sync.ts). Agent-side writes (add_leads,
// evidence, scoring, drafts) live in ./leads.ts and ./drafts.ts. Every state change writes an `events` row.
// Every function acts on one workspace (`ws`): dedupe, suppression checks and lookups never cross workspaces.
import type { Lead, Sql } from "../db.ts";
import { newId, variantFor } from "../ids.ts";
import { ApiError } from "../lib/errors.ts";
import { companyDomain, normalizeEmail } from "./addresses.ts";
import {
  CsvError,
  mapHeaders,
  parseCsv,
  planImport,
  toCandidates,
  type ExistingLead,
  type ImportCandidate,
  type ImportField,
  type RowResult,
} from "./csv.ts";
import { ServiceError } from "./errors.ts";
import { getLeadDetail, LEAD_STAGES, normalizeDomain, type LeadStage } from "./leads.ts";

export { LEAD_STAGES };

const notFound = (id: string) => new ServiceError("not_found", `No lead with id ${id}`);

// ---------- list ----------

export type LeadFilters = {
  stage?: string;
  min_score?: number;
  source?: string;
  q?: string;
  limit: number;
  cursor?: string;
};

function encodeCursor(ts: string, id: string) {
  return btoa(JSON.stringify([ts, id])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const value = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")));
    if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string") return [value[0], value[1]];
  } catch {}
  throw new ApiError(400, "invalid_cursor", "cursor is not valid; pass next_cursor from the previous page");
}

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/** Newest first, keyset-paginated on (created_at, id), which never change (updated_at does). */
export async function searchLeads(sql: Sql, ws: string, f: LeadFilters) {
  const [cursorTs, cursorId] = f.cursor ? decodeCursor(f.cursor) : [null, null];
  const pattern = f.q ? likePattern(f.q) : null;
  // notes_count and rating (the latest thumbs note: "up" | "down" | null) save the list one request per row.
  const rows = await sql`
    select l.*, l.consent_at is not null as has_consent, l.created_at::text as _cursor_ts,
           (select count(*)::int from lead_notes n where n.lead_id = l.id) as notes_count,
           (select case n.kind when 'thumbs_up' then 'up' when 'thumbs_down' then 'down' end
              from lead_notes n where n.lead_id = l.id and n.kind in ('thumbs_up', 'thumbs_down')
              order by n.id desc limit 1) as rating
    from leads l
    where l.workspace_id = ${ws}
      and (${f.stage ?? null}::text is null or stage = ${f.stage ?? null})
      and (${f.min_score ?? null}::int is null or score >= ${f.min_score ?? null})
      and (${f.source ?? null}::text is null or source = ${f.source ?? null})
      and (${pattern}::text is null or email ilike ${pattern} or name ilike ${pattern}
           or company ilike ${pattern} or domain ilike ${pattern})
      and (${cursorTs}::timestamptz is null or (created_at, id) < (${cursorTs}::timestamptz, ${cursorId}))
    order by created_at desc, id desc
    limit ${f.limit + 1}`;
  const page = rows.slice(0, f.limit);
  const last = page.at(-1);
  const next_cursor = rows.length > f.limit && last ? encodeCursor(last._cursor_ts, last.id) : null;
  return { data: page.map(({ _cursor_ts, ...lead }) => lead), next_cursor };
}

// ---------- detail ----------

/** The shared detail (lead, evidence, drafts, approvals) plus messages, Naive sessions and the timeline. */
export async function getLeadFull(sql: Sql, ws: string, id: string) {
  const detail = await getLeadDetail(sql, ws, id);
  const [lookalikes, messages, sessions, timeline] = await sql.transaction(
    [
      sql`select id, company, domain, why_fit, source_url, created_at from lookalikes where workspace_id = ${ws} and lead_id = ${id} order by id`,
      // Inbound bodies are untrusted: returned as data for display, never as instructions.
      sql`select id, direction, provider_message_id, thread_id, from_addr, to_addr, subject, body, label, created_at
          from messages where workspace_id = ${ws} and lead_id = ${id} order by id desc limit 100`,
      sql`select id, purpose, status, stop_reason, created_at, updated_at from naive_sessions
          where workspace_id = ${ws} and lead_id = ${id} order by created_at desc limit 20`,
      sql`select id, kind, data, created_at from events where workspace_id = ${ws} and lead_id = ${id} order by id desc limit 200`,
    ],
    { readOnly: true },
  );
  return { ...detail, lookalikes, messages, sessions, timeline };
}

// ---------- create ----------

export type ConsentInput = { text: string; at?: string };

export type CreateLeadInput = {
  email: string;
  name?: string;
  title?: string;
  company?: string;
  domain?: string;
  website?: string;
  linkedin_url?: string;
  sells?: string;
  best_customers?: string;
  source?: string;
  consent?: ConsentInput;
};

/** An owner-entered contact. Leads without an email come from CSV import or the MCP add_leads tool. */
export async function createLead(sql: Sql, ws: string, input: CreateLeadInput, actor: string): Promise<Lead> {
  const email = normalizeEmail(input.email);
  if (!email) throw new ServiceError("invalid", `Not an email address: ${input.email}`);
  // Same rule as add_leads and CSV import: people who asked not to be contacted are not stored again.
  if ((await sql`select 1 from suppressions where workspace_id = ${ws} and email = ${email}`)[0]) {
    throw new ApiError(409, "suppressed", `${email} is on the suppression list (DELETE /api/suppressions/:email first if that is wrong)`);
  }
  const id = newId("lead");
  const consentAt = input.consent ? (input.consent.at ?? new Date().toISOString()) : null;
  const domain = normalizeDomain(input.domain) ?? companyDomain({ website: input.website, email }) ?? null;
  const rows = await sql`
    with ins as (
      insert into leads (id, workspace_id, cohort, email, name, title, company, domain, website, linkedin_url, sells, best_customers, source,
                         consent_text, consent_at, variant, stage)
      values (${id}, ${ws}, 'manual', ${email}, ${input.name ?? null}, ${input.title ?? null}, ${input.company ?? null}, ${domain},
              ${input.website ?? null}, ${input.linkedin_url ?? null}, ${input.sells ?? null}, ${input.best_customers ?? null},
              ${input.source ?? "api"}, ${input.consent?.text ?? null}, ${consentAt}::timestamptz, ${await variantFor(email)},
              ${consentAt ? "new" : "no_consent"})
      on conflict (workspace_id, email) do nothing
      returning *
    ), ev as (
      insert into events (workspace_id, lead_id, kind, data)
      select workspace_id, id, 'lead_added', jsonb_build_object('via', 'api', 'source', source, 'consent', consent_at is not null, 'actor', ${actor}::text)
      from ins
    )
    select *, consent_at is not null as has_consent from ins`;
  if (!rows[0]) {
    const existing = await sql`select id from leads where workspace_id = ${ws} and email = ${email}`;
    throw new ApiError(409, "lead_exists", `A lead with email ${email} already exists`, { lead_id: existing[0]?.id });
  }
  return rows[0] as Lead;
}

// ---------- patch ----------

export type PatchLeadInput = {
  stage?: LeadStage;
  consent?: ConsentInput | null;
  name?: string | null;
  title?: string | null;
  company?: string | null;
  website?: string | null;
  linkedin_url?: string | null;
  sells?: string | null;
  best_customers?: string | null;
};

const PATCHABLE = ["name", "title", "company", "website", "linkedin_url", "sells", "best_customers"] as const;

export async function patchLead(sql: Sql, ws: string, id: string, patch: PatchLeadInput, actor: string): Promise<Lead> {
  const lead = (await sql`select * from leads where workspace_id = ${ws} and id = ${id}`)[0] as Lead | undefined;
  if (!lead) throw notFound(id);

  const next = { ...lead };
  const changed: string[] = [];
  for (const key of PATCHABLE) {
    if (patch[key] !== undefined && patch[key] !== lead[key]) {
      next[key] = patch[key];
      changed.push(key);
    }
  }
  if (changed.includes("website")) next.domain = companyDomain({ website: next.website, email: lead.email }) ?? lead.domain;

  let consentChange: "granted" | "revoked" | null = null;
  if (patch.consent === null && lead.consent_at) {
    next.consent_at = null;
    next.consent_text = null;
    consentChange = "revoked";
  } else if (patch.consent) {
    if (!lead.email) throw new ServiceError("invalid", "This lead has no email address; consent applies to an address");
    next.consent_text = patch.consent.text;
    next.consent_at = new Date(patch.consent.at ?? Date.now());
    if (lead.consent_at) changed.push("consent_text");
    else consentChange = "granted";
  }

  if (patch.stage) next.stage = patch.stage;
  else if (consentChange === "granted" && lead.stage === "no_consent") next.stage = "new";
  else if (consentChange === "revoked" && lead.stage === "new") next.stage = "no_consent";

  const events: { kind: string; data: Record<string, unknown> }[] = [];
  if (next.stage !== lead.stage) events.push({ kind: "lead_stage_changed", data: { via: "api", from: lead.stage, to: next.stage, actor } });
  if (consentChange) events.push({ kind: `lead_consent_${consentChange}`, data: { via: "api", actor } });
  if (changed.length) events.push({ kind: "lead_updated", data: { via: "api", fields: changed, actor } });
  if (!events.length) return lead;

  const queries = [
    sql`update leads set name = ${next.name}, title = ${next.title}, company = ${next.company}, website = ${next.website},
          domain = ${next.domain}, linkedin_url = ${next.linkedin_url}, sells = ${next.sells},
          best_customers = ${next.best_customers}, consent_text = ${next.consent_text},
          consent_at = ${next.consent_at}::timestamptz, stage = ${next.stage}, updated_at = now()
        where workspace_id = ${ws} and id = ${id} returning *, consent_at is not null as has_consent`,
    sql`insert into events (workspace_id, lead_id, kind, data)
        select ${ws}, ${id}, e->>'kind', e->'data' from jsonb_array_elements(${JSON.stringify(events)}::jsonb) e`,
  ];
  if (consentChange === "revoked") {
    // No consent, no email: pending send approvals close now (the send path re-checks consent anyway).
    queries.push(
      sql`update drafts set status = 'draft' where workspace_id = ${ws} and lead_id = ${id} and status = 'pending_approval'`,
      sql`with v as (update approvals set status = 'expired', decided_at = now(), decided_via = 'consent_revoked'
                     where workspace_id = ${ws} and lead_id = ${id} and kind = 'send' and status = 'pending' returning code)
          insert into events (workspace_id, lead_id, kind, data)
          select ${ws}, ${id}, 'approval_closed', jsonb_build_object('code', code, 'reason', 'consent_revoked') from v`,
    );
  }
  const [updated] = await sql.transaction(queries);
  return updated![0] as Lead;
}

// ---------- delete ----------

export async function deleteLead(sql: Sql, ws: string, id: string, actor: string): Promise<void> {
  // Cascades to evidence, drafts, approvals, messages and sessions; the events (audit trail) stay.
  const rows = await sql`
    with del as (delete from leads where workspace_id = ${ws} and id = ${id} returning id, workspace_id)
    insert into events (workspace_id, lead_id, kind, data)
    select workspace_id, id, 'lead_deleted', jsonb_build_object('via', 'api', 'actor', ${actor}::text) from del
    returning lead_id`;
  if (!rows[0]) throw notFound(id);
}

// ---------- CSV import ----------

export const MAX_IMPORT_ROWS = 10_000;
const CHUNK = 500;
const MAX_ROW_RESULTS = 1_000;

export type ImportInput = {
  csv: string;
  mapping?: Partial<Record<ImportField, string>>;
  source?: string;
  dry_run?: boolean;
};

export async function importLeads(sql: Sql, ws: string, input: ImportInput, actor: string) {
  let rows: string[][];
  let map;
  try {
    rows = parseCsv(input.csv);
    if (rows.length < 2) throw new CsvError("The CSV needs a header row and at least one data row");
    if (rows.length - 1 > MAX_IMPORT_ROWS) throw new CsvError(`Too many rows: at most ${MAX_IMPORT_ROWS} per import`);
    map = mapHeaders(rows[0]!, input.mapping);
  } catch (err) {
    if (err instanceof CsvError) throw new ApiError(400, "invalid_csv", err.message);
    throw err;
  }
  if (map.email === undefined && map.website === undefined && map.domain === undefined) {
    throw new ApiError(400, "invalid_csv", 'No email, domain or website column found; pass `mapping`, e.g. {"email": "Work Email"}', {
      headers: rows[0],
    });
  }

  const source = input.source ?? "csv_import";
  const cohort = `import:${newId("imp")}`;
  const results = await applyImportCandidates(sql, ws, toCandidates(rows, map, new Date().toISOString()), {
    source,
    actor,
    via: "csv_import",
    dryRun: input.dry_run,
    cohort,
  });
  const { skip_reasons, ...summary } = summarizeImport(results);
  if (!input.dry_run) {
    await sql`insert into events (workspace_id, lead_id, kind, data)
              values (${ws}, null, 'leads_imported', ${JSON.stringify({ via: "csv_import", ...summary, source, cohort, actor })}::jsonb)`;
  }
  return {
    dry_run: Boolean(input.dry_run),
    // The batch the created leads are recorded under (leads.cohort).
    ...(input.dry_run ? {} : { cohort }),
    ...summary,
    skip_reasons,
    columns: Object.fromEntries(Object.entries(map).map(([field, idx]) => [field, rows[0]![idx!]])),
    rows: results.slice(0, MAX_ROW_RESULTS).map((r) => (r.status === "created" ? { row: r.row, status: r.status } : r)),
    rows_truncated: results.length > MAX_ROW_RESULTS,
  };
}

export type ApplyImportOptions = {
  /** leads.source for created leads. */
  source: string;
  actor: string;
  /** events.data.via: 'csv_import', 'hubspot_import'. The CRM sync trigger ignores 'hubspot_import'. */
  via: string;
  dryRun?: boolean;
  /** leads.cohort for created leads: the import batch ('import:<id>', 'hubspot_import:<time>'). */
  cohort?: string;
};

/**
 * Applies import candidates (CSV rows, HubSpot records) with the dedupe plan from ./csv.ts: creates new leads
 * (no consent unless the candidate carries it), fills blank fields on existing ones and grants consent, never
 * overwrites. Suppressed addresses are skipped. Shared by the CSV import and the HubSpot import.
 */
export async function applyImportCandidates(sql: Sql, ws: string, candidates: ImportCandidate[], opts: ApplyImportOptions): Promise<RowResult[]> {
  const { source, actor, via } = opts;
  const cohort = opts.cohort ?? `import:${newId("imp")}`;
  const emails = [...new Set(candidates.flatMap((c) => (c.email ? [c.email] : [])))];
  const domains = [...new Set(candidates.flatMap((c) => (c.domain ? [c.domain] : [])))];
  const [existing, suppressedRows] = await sql.transaction(
    [
      sql`select id, email, name, title, company, domain, website, linkedin_url, sells, best_customers, consent_at from leads
          where workspace_id = ${ws} and (lower(email) = any(${emails}::text[]) or (email is null and domain = any(${domains}::text[])))`,
      sql`select email from suppressions where workspace_id = ${ws} and email = any(${emails}::text[])`,
    ],
    { readOnly: true },
  );
  const suppressed = new Set(suppressedRows!.map((r) => r.email as string));
  const plan = planImport(candidates, existing as ExistingLead[], suppressed);
  const results: RowResult[] = plan.rows;
  if (opts.dryRun) return results;

  const creates = await Promise.all(
    plan.creates.map(async (c) => ({
      id: newId("lead"),
      key: c.key,
      email: c.email ?? null,
      name: c.name ?? null,
      title: c.title ?? null,
      company: c.company ?? null,
      domain: c.domain ?? null,
      website: c.website ?? null,
      linkedin_url: c.linkedin_url ?? null,
      sells: c.sells ?? null,
      best_customers: c.best_customers ?? null,
      consent_text: c.consent?.text ?? null,
      consent_at: c.consent?.at ?? null,
      // Same seed as add_leads (email, else the domain+name key) so a contact always gets the same variant.
      variant: await variantFor(c.email ?? c.key),
      stage: c.consent ? "new" : "no_consent",
    })),
  );
  const inserted = new Set<string>();
  const withEmail = creates.filter((c) => c.email);
  const withoutEmail = creates.filter((c) => !c.email);
  for (let i = 0; i < withEmail.length; i += CHUNK) {
    const done = await sql`
      with r as (${createRecordset(sql, withEmail.slice(i, i + CHUNK))}),
      ins as (
        insert into leads (id, workspace_id, cohort, email, name, title, company, domain, website, linkedin_url, sells, best_customers, source,
                           consent_text, consent_at, variant, stage)
        select id, ${ws}, ${cohort}, email, name, title, company, domain, website, linkedin_url, sells, best_customers, ${source},
               consent_text, consent_at, variant, stage from r
        on conflict (workspace_id, email) do nothing
        returning id, email, consent_at
      ), ev as (
        insert into events (workspace_id, lead_id, kind, data)
        select ${ws}, id, 'lead_added', jsonb_build_object('via', ${via}::text, 'source', ${source}::text,
                                                    'consent', consent_at is not null, 'actor', ${actor}::text)
        from ins
      )
      select 'e:' || email as key from ins`;
    for (const row of done) inserted.add(row.key as string);
  }
  for (let i = 0; i < withoutEmail.length; i += CHUNK) {
    const done = await sql`
      with r as (${createRecordset(sql, withoutEmail.slice(i, i + CHUNK))}),
      ins as (
        insert into leads (id, workspace_id, cohort, email, name, title, company, domain, website, linkedin_url, sells, best_customers, source,
                           variant, stage)
        select id, ${ws}, ${cohort}, null, name, title, company, domain, website, linkedin_url, sells, best_customers, ${source},
               variant, 'no_consent' from r
        on conflict (workspace_id, domain) where email is null do nothing
        returning id, domain, name
      ), ev as (
        insert into events (workspace_id, lead_id, kind, data)
        select ${ws}, id, 'lead_added', jsonb_build_object('via', ${via}::text, 'source', ${source}::text, 'consent', false, 'actor', ${actor}::text)
        from ins
      )
      select 'd:' || domain || '|' || coalesce(lower(name), '') as key from ins`;
    for (const row of done) inserted.add(row.key as string);
  }
  // A concurrent import or create can win the race for a key: report those rows as skipped.
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === "created" && !inserted.has(r.key)) results[i] = { row: r.row, status: "skipped", reason: "exists" };
  }

  const updates = [...plan.updates].map(([id, changes]) => ({ id, ...changes, fields: Object.keys(changes) }));
  for (let i = 0; i < updates.length; i += CHUNK) {
    await sql`
      with u as (
        select * from jsonb_to_recordset(${JSON.stringify(updates.slice(i, i + CHUNK))}::jsonb) as x(
          id text, email text, name text, title text, company text, domain text, website text, linkedin_url text,
          sells text, best_customers text, consent_text text, consent_at timestamptz, fields jsonb)
      ), upd as (
        update leads l set
          email = case when l.email is null and u.email is not null
                        and not exists (select 1 from leads e where e.workspace_id = ${ws} and e.email = u.email) then u.email else l.email end,
          name = coalesce(l.name, u.name),
          title = coalesce(l.title, u.title),
          company = coalesce(l.company, u.company),
          domain = coalesce(l.domain, u.domain),
          website = coalesce(l.website, u.website),
          linkedin_url = coalesce(l.linkedin_url, u.linkedin_url),
          sells = coalesce(l.sells, u.sells),
          best_customers = coalesce(l.best_customers, u.best_customers),
          consent_text = case when l.consent_at is null and u.consent_at is not null then u.consent_text else l.consent_text end,
          consent_at = coalesce(l.consent_at, u.consent_at),
          stage = case when l.stage = 'no_consent' and l.consent_at is null and u.consent_at is not null then 'new' else l.stage end,
          updated_at = now()
        from u where l.workspace_id = ${ws} and l.id = u.id
        returning l.id
      )
      insert into events (workspace_id, lead_id, kind, data)
      select ${ws}, u.id, 'lead_updated', jsonb_build_object('via', ${via}::text, 'fields', u.fields, 'actor', ${actor}::text)
      from u join upd on upd.id = u.id`;
  }
  return results;
}

/** Counts per status plus skip reasons. */
export function summarizeImport(results: RowResult[]) {
  const count = (s: RowResult["status"]) => results.filter((r) => r.status === s).length;
  const skip_reasons: Record<string, number> = {};
  for (const r of results) if (r.status === "skipped") skip_reasons[r.reason] = (skip_reasons[r.reason] ?? 0) + 1;
  return { created: count("created"), updated: count("updated"), skipped: count("skipped"), skip_reasons };
}

function createRecordset(sql: Sql, rows: unknown[]) {
  return sql`select * from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as x(
    id text, email text, name text, title text, company text, domain text, website text, linkedin_url text,
    sells text, best_customers text, consent_text text, consent_at timestamptz, variant text, stage text)`;
}
