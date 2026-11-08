// CSV import with a field mapping and a preview (POST /api/import/preview, nothing written), then the commit
// (POST /api/import/commit). Reuses the CSV parser, the candidate builder and the dedupe plan of the existing import
// (./csv.ts, ./crm.ts): a row matches an existing lead by email, or (without an email) by normalized company domain
// + name; a row with a new email at a company Crusonia already has is a new contact, flagged in the preview.
//
// The import `source` is the cohort: created leads record it in leads.cohort (and leads.source), plus where each one
// came from in leads.import_meta ({file, row, batch, source}). Consent is per contact: a truthy consent cell on a row
// with an email records consent_text (naming the file, row and column) and consent_at (the consent_at cell, else now).
import { z } from "zod";
import type { Sql } from "../db.ts";
import { newId } from "../ids.ts";
import { ApiError } from "../lib/errors.ts";
import { applyImportCandidates, MAX_IMPORT_ROWS, summarizeImport } from "./crm.ts";
import { CsvError, mapHeaders, parseCsv, planImport, toCandidates, type ExistingLead, type HeaderMap, type ImportCandidate, type ImportField } from "./csv.ts";

export const IMPORT_MAP_FIELDS = ["email", "name", "company", "domain", "title", "consent", "consent_at", "consent_text", "source"] as const;
type MapField = (typeof IMPORT_MAP_FIELDS)[number];

const column = z.string().trim().min(1).max(200);

export const importBodySchema = z.object({
  csv: z.string().min(1, "csv is required"),
  /** Crusonia field -> CSV column name. Without a mapping the columns are guessed from their names. */
  mapping: z.partialRecord(z.enum(IMPORT_MAP_FIELDS), column.nullish()).default({}),
  /** The cohort these contacts belong to, e.g. "Demo prospects, Nov 8". */
  source: z.string().trim().min(1, "source is required").max(200),
  file_name: z.string().trim().max(255).nullish(),
});
export type ImportBody = z.infer<typeof importBodySchema>;

export type PreviewRow = {
  row: number;
  status: "new" | "duplicate" | "invalid";
  name: string | null;
  email: string | null;
  company: string | null;
  domain: string | null;
  title: string | null;
  consent: boolean;
  consent_at: string | null;
  source: string | null;
  reason?: string;
  lead_id?: string;
  existing_since?: string;
  /** A new contact at a company already in Crusonia: that company's lead. */
  company_lead_id?: string;
};

const REASONS: Record<string, string> = {
  invalid_email: "email not valid",
  missing_email_and_domain: "no email and no company domain",
  suppressed: "on the do-not-contact list",
  duplicate_in_file: "duplicate of an earlier row in this file",
  unchanged: "already in Crusonia, nothing new in this row",
  exists: "already in Crusonia",
};

type Parsed = { header: string[]; candidates: ImportCandidate[]; rowSource: Map<number, string> };

function parse(body: ImportBody, importedAt: string): Parsed {
  let rows: string[][];
  try {
    rows = parseCsv(body.csv);
  } catch (err) {
    if (err instanceof CsvError) throw new ApiError(400, "invalid_csv", err.message);
    throw err;
  }
  if (rows.length < 2) throw new ApiError(400, "invalid_csv", "The CSV needs a header row and at least one data row");
  if (rows.length - 1 > MAX_IMPORT_ROWS) throw new ApiError(400, "invalid_csv", `Too many rows: at most ${MAX_IMPORT_ROWS} per import`);
  const header = rows[0]!.map((h) => h.trim());
  const explicit = Object.fromEntries(Object.entries(body.mapping).filter(([f, col]) => col && f !== "source")) as Partial<Record<ImportField, string>>;
  let map: HeaderMap;
  try {
    // An explicit mapping is the owner's choice: unmapped columns stay unmapped. No mapping: guess from the names.
    map = Object.keys(explicit).length ? explicitMap(header, explicit) : mapHeaders(header);
  } catch (err) {
    if (err instanceof CsvError) throw new ApiError(400, "invalid_mapping", err.message);
    throw err;
  }
  if (map.email === undefined && map.domain === undefined && map.website === undefined) {
    throw new ApiError(400, "invalid_mapping", "Map an email or a company domain column", { columns: header });
  }
  const sourceIdx = body.mapping.source ? header.findIndex((h) => h.toLowerCase() === body.mapping.source!.trim().toLowerCase()) : -1;
  if (body.mapping.source && sourceIdx < 0) throw new ApiError(400, "invalid_mapping", `Mapping for "source" names column "${body.mapping.source}", which is not in the header row`);
  const candidates = toCandidates(rows, map, importedAt);
  const rowSource = new Map<number, string>();
  rows.slice(1).forEach((cells, i) => {
    const v = sourceIdx >= 0 ? cells[sourceIdx]?.trim() : "";
    if (v) rowSource.set(i + 2, v);
  });
  const file = body.file_name?.trim() || "CSV";
  for (const c of candidates) {
    // Name the file and row in the consent record, so it can be traced back to the source document.
    if (c.consent) c.consent.text = `${c.consent.text} (${file}, row ${c.row}; import "${body.source}")`.slice(0, 1000);
  }
  return { header, candidates, rowSource };
}

function explicitMap(header: string[], explicit: Partial<Record<ImportField, string>>): HeaderMap {
  const map: HeaderMap = {};
  for (const [field, col] of Object.entries(explicit) as [ImportField, string][]) {
    const idx = header.findIndex((h) => h.toLowerCase() === col.trim().toLowerCase());
    if (idx < 0) throw new CsvError(`Mapping for "${field}" names column "${col}", which is not in the header row`);
    map[field] = idx;
  }
  return map;
}

async function existingFor(sql: Sql, candidates: ImportCandidate[]) {
  const emails = [...new Set(candidates.flatMap((c) => (c.email ? [c.email] : [])))];
  const domains = [...new Set(candidates.flatMap((c) => (c.domain ? [c.domain] : [])))];
  const [existing, suppressed] = await sql.transaction(
    [
      sql`select id, email, name, title, company, domain, website, linkedin_url, sells, best_customers, consent_at, created_at from leads
          where lower(email) = any(${emails}::text[]) or domain = any(${domains}::text[])`,
      sql`select email from suppressions where email = any(${emails}::text[])`,
    ],
    { readOnly: true },
  );
  return {
    existing: existing as (ExistingLead & { created_at: Date })[],
    suppressed: new Set(suppressed!.map((r) => r.email as string)),
  };
}

/** POST /api/import/preview: the mapped rows with their status, nothing written. */
// TODO(workspaces): scope the duplicate lookup to `ws`.
export async function previewImport(sql: Sql, _ws: string, body: ImportBody) {
  const now = new Date().toISOString();
  const { header, candidates, rowSource } = parse(body, now);
  const { existing, suppressed } = await existingFor(sql, candidates);
  const plan = planImport(candidates, existing, suppressed);
  const byId = new Map(existing.map((l) => [l.id, l]));
  // Company-level match for rows that create a new contact: any existing lead at the same normalized domain.
  const byDomain = new Map<string, ExistingLead & { created_at: Date }>();
  for (const l of existing) if (l.domain && (!byDomain.has(l.domain) || !l.email)) byDomain.set(l.domain, l);
  const result = new Map(plan.rows.map((r) => [r.row, r]));

  const rows: PreviewRow[] = candidates.map((c) => {
    const r = result.get(c.row)!;
    const base = {
      row: c.row,
      name: c.name ?? null,
      email: c.email ?? c.rawEmail ?? null,
      company: c.company ?? null,
      domain: c.domain ?? null,
      title: c.title ?? null,
      consent: Boolean(c.consent),
      consent_at: c.consent?.at ?? null,
      source: rowSource.get(c.row) ?? body.source,
    };
    if (r.status === "created") {
      const company = c.domain ? byDomain.get(c.domain) : undefined;
      return company
        ? {
            ...base,
            status: "new" as const,
            reason: `new contact at a company already in Crusonia (${company.company ?? company.domain})`,
            company_lead_id: company.id,
          }
        : { ...base, status: "new" as const };
    }
    if (r.status === "updated") {
      const lead = byId.get(r.lead_id);
      return {
        ...base,
        status: "duplicate" as const,
        reason: r.matched_by === "email" ? "matches an existing lead by email" : "matches an existing company by domain",
        lead_id: r.lead_id,
        ...(lead ? { existing_since: new Date(lead.created_at).toISOString() } : {}),
      };
    }
    const invalid = r.reason === "invalid_email" || r.reason === "missing_email_and_domain" || r.reason === "suppressed";
    const lead = r.lead_id ? byId.get(r.lead_id) : undefined;
    return {
      ...base,
      status: invalid ? ("invalid" as const) : ("duplicate" as const),
      reason: REASONS[r.reason] ?? r.reason,
      ...(r.lead_id ? { lead_id: r.lead_id } : {}),
      ...(lead ? { existing_since: new Date(lead.created_at).toISOString() } : {}),
    };
  });
  const count = (s: PreviewRow["status"]) => rows.filter((r) => r.status === s).length;
  return { columns: header, rows, counts: { new: count("new"), duplicate: count("duplicate"), invalid: count("invalid") } };
}

/**
 * POST /api/import/commit: creates the new rows (cohort = `source`), fills blank fields and grants consent on matching
 * leads (never overwrites), skips invalid and suppressed rows.
 */
export async function commitImport(sql: Sql, _ws: string, body: ImportBody, actor: string) {
  const now = new Date().toISOString();
  const { candidates, rowSource } = parse(body, now);
  const batch = newId("imp");
  const results = await applyImportCandidates(sql, candidates, { source: body.source, actor, via: "csv_import" });
  const summary = summarizeImport(results);
  const created = new Set(results.filter((r) => r.status === "created").map((r) => r.row));
  const meta = candidates
    .filter((c) => created.has(c.row))
    .map((c) => ({
      email: c.email ?? null,
      domain: c.domain ?? null,
      name: c.name ?? null,
      meta: { file: body.file_name?.trim() || null, row: c.row, batch, source: rowSource.get(c.row) ?? null },
    }));
  if (meta.length) {
    // The leads this commit created: record the cohort and where each came from.
    await sql`
      update leads l set cohort = ${body.source}, import_meta = x.meta
      from jsonb_to_recordset(${JSON.stringify(meta)}::jsonb) as x(email text, domain text, name text, meta jsonb)
      where l.import_meta is null and l.created_at >= ${now}::timestamptz - interval '1 minute'
        and ((x.email is not null and lower(l.email) = x.email)
          or (x.email is null and l.email is null and l.domain = x.domain and coalesce(lower(l.name), '') = coalesce(lower(x.name), '')))`;
  }
  await sql`insert into events (lead_id, kind, data) values (null, 'leads_imported', ${JSON.stringify({
    via: "csv_import",
    batch,
    cohort: body.source,
    file: body.file_name ?? null,
    created: summary.created,
    updated: summary.updated,
    skipped: summary.skipped,
    skip_reasons: summary.skip_reasons,
    actor,
  })}::jsonb)`;
  return { created: summary.created, updated: summary.updated, skipped: summary.skipped, cohort: body.source, batch };
}

export type { MapField };
