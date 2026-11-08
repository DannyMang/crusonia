// CRM sync: pushes leads to HubSpot and to a Notion database, and imports HubSpot contacts and companies.
//
//   enqueue  events trigger (src/schema.sql) for targets listed in settings 'crm_sync_targets', which the cron
//            mirrors from HUBSPOT_SYNC_ENABLED / NOTION_SYNC_ENABLED; POST /api/integrations/sync; the import job.
//   drain    the minute cron (runCrmSync): a small batch per target, paced under each provider's rate limit,
//            retried with backoff (./crm-queue.ts). Every push is an upsert keyed by ids stored on our rows.
//   rules    field ownership lives in ./crm-fields.ts.
//
// Nothing is written to HubSpot or Notion unless that target's switch is "true". The import only reads HubSpot.
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { ApiError } from "../lib/errors.ts";
import { RateLimitError, realPace, type FetchFn, type Pace } from "../providers/http.ts";
import {
  ASSOC_CONTACT_TO_COMPANY,
  conflictExistingId,
  HubSpotClient,
  missingScopes,
  type HubSpotObject,
} from "../providers/hubspot.ts";
import { isGonePage, NotionClient } from "../providers/notion.ts";
import { applyImportCandidates, summarizeImport } from "./crm.ts";
import {
  companyIdentity,
  companyToCandidate,
  consentMapping,
  contactIdentity,
  contactToCandidate,
  CRM_TARGETS,
  flagOn,
  HUBSPOT_COMPANY_IMPORT_PROPERTIES,
  HUBSPOT_CONTACT_IMPORT_PROPERTIES,
  HUBSPOT_PROPERTY_NAMES,
  inScope,
  leadStatusFor,
  NOTION_KEY_PROPERTY,
  notionProperties,
  ownedProperties,
  parseNoteRefs,
  planCreate,
  planNotes,
  planUpdate,
  propertiesHash,
  syncScope,
  type CrmTarget,
  type EvidenceRow,
  type HubSpotImportRow,
  type HubSpotState,
  type MessageRow,
  type SyncLead,
  type SyncScope,
} from "./crm-fields.ts";
import { drain, emptyReport, enqueueLeads, sqlQueueStore, type DrainReport, type HandleResult, type QueueItem } from "./crm-queue.ts";
import { describeError } from "./errors.ts";

// ---------- config ----------

export type TargetConfig = {
  /** The switch (HUBSPOT_SYNC_ENABLED / NOTION_SYNC_ENABLED) is "true". */
  enabled: boolean;
  /** Every key the target needs is set. */
  configured: boolean;
  /** enabled and configured: the cron writes to this target. */
  active: boolean;
  missing: string[];
  scope: SyncScope;
};

export const SWITCH: Record<CrmTarget, keyof Env> = { hubspot: "HUBSPOT_SYNC_ENABLED", notion: "NOTION_SYNC_ENABLED" };
const LABEL: Record<CrmTarget, string> = { hubspot: "HubSpot", notion: "Notion" };
const DEFAULT_BATCH = 5;

function target(env: Env, t: CrmTarget, keys: (keyof Env)[], scopeRaw: string | undefined): TargetConfig {
  const missing = keys.filter((k) => !env[k]) as string[];
  const enabled = flagOn(env[SWITCH[t]] as string | undefined);
  return { enabled, configured: missing.length === 0, active: enabled && missing.length === 0, missing, scope: syncScope(scopeRaw) };
}

export function crmConfig(env: Env) {
  const batch = Number.parseInt(env.CRM_SYNC_BATCH_SIZE ?? "", 10);
  return {
    hubspot: target(env, "hubspot", ["HUBSPOT_ACCESS_TOKEN"], env.HUBSPOT_SYNC_SCOPE),
    notion: target(env, "notion", ["NOTION_API_TOKEN", "NOTION_LEADS_DATABASE_ID"], env.NOTION_SYNC_SCOPE),
    batchSize: Number.isFinite(batch) && batch > 0 ? Math.min(batch, 50) : DEFAULT_BATCH,
  };
}

/** Tells the events trigger which targets to queue for (settings 'crm_sync_targets'). */
function mirrorTargets(sql: Sql, active: CrmTarget[]) {
  return sql`
    insert into settings (key, value) values ('crm_sync_targets', ${JSON.stringify(active)}::jsonb)
    on conflict (key) do update set value = excluded.value where settings.value is distinct from excluded.value`;
}

// ---------- reading a lead ----------

function syncLeadQuery(sql: Sql, leadId: string) {
  return sql`
    select l.id, l.email, l.name, l.title, l.company, l.domain, l.website, l.source, l.stage, l.score, l.qualified,
           l.rationale, l.consent_at, l.hubspot_id, l.hubspot_company_id, l.hubspot_state, l.notion_page_id, l.notion_hash,
           (select max(m.created_at) from messages m where m.lead_id = l.id and m.direction = 'out') as last_outreach_at,
           greatest(l.updated_at, (select max(m.created_at) from messages m where m.lead_id = l.id)) as last_activity_at,
           (select count(*)::int from evidence e where e.lead_id = l.id) as evidence_count,
           (select e.claim from evidence e where e.lead_id = l.id order by e.id limit 1) as signal
    from leads l where l.id = ${leadId}`;
}

export async function loadSyncLead(sql: Sql, leadId: string): Promise<SyncLead | undefined> {
  return (await syncLeadQuery(sql, leadId))[0] as SyncLead | undefined;
}

export type HubSpotSnapshot = { lead: SyncLead; evidence: EvidenceRow[]; messages: MessageRow[] };

async function loadHubSpotSnapshot(sql: Sql, leadId: string): Promise<HubSpotSnapshot | undefined> {
  const [leads, evidence, messages] = await sql.transaction(
    [
      syncLeadQuery(sql, leadId),
      sql`select id::text as id, claim, source_url, created_at, hubspot_note_id from evidence where lead_id = ${leadId} order by id`,
      sql`select id::text as id, direction, subject, body, label, created_at, hubspot_note_id from messages
          where lead_id = ${leadId} order by id`,
    ],
    { readOnly: true },
  );
  const lead = leads?.[0] as SyncLead | undefined;
  return lead ? { lead, evidence: evidence as EvidenceRow[], messages: messages as MessageRow[] } : undefined;
}

// ---------- HubSpot push ----------

export type HubSpotContext = {
  /** crusonia_* properties that exist in the portal, per object (see hubspotAvailability). */
  available: { contacts: ReadonlySet<string>; companies: ReadonlySet<string> };
  /** Objects this run found the token cannot write ("companies"); later leads skip them without a call. */
  blocked?: Set<string>;
  maxNotes?: number;
};

export type HubSpotProgress = {
  contactId: string | null;
  companyId: string | null;
  state: HubSpotState;
  evidenceNotes: { ids: string[]; noteId: string }[];
  messageNotes: { id: string; noteId: string }[];
  created: { contact: boolean; company: boolean };
  writes: number;
  warnings: string[];
  more: boolean;
  /** Nothing could be synced (a company-only lead without the companies scope). */
  skipped?: boolean;
};

export const newProgress = (lead: SyncLead): HubSpotProgress => ({
  contactId: null,
  companyId: null,
  state: { ...(lead.hubspot_state ?? {}) },
  evidenceNotes: [],
  messageNotes: [],
  created: { contact: false, company: false },
  writes: 0,
  warnings: [],
  more: false,
});

const CONTACT_READ = ["email", "firstname", "lastname", "jobtitle", "company", "website", "hs_lead_status"];

async function upsertCompany(client: HubSpotClient, lead: SyncLead, ctx: HubSpotContext, p: HubSpotProgress, companyOnly: boolean) {
  const owned = companyOnly ? ownedProperties(lead, ctx.available.companies) : {};
  const read = ["name", "domain", ...Object.keys(owned)];
  let company: HubSpotObject | null = lead.hubspot_company_id ? await client.getCompany(lead.hubspot_company_id, read) : null;
  company ??= await client.findCompanyByDomain(lead.domain!, read);
  const identity = companyIdentity(lead);
  if (!company) {
    const created = await client.createObject("companies", planCreate({ identity, owned, leadStatus: null }));
    p.companyId = created.id;
    p.created.company = true;
    p.writes++;
    return;
  }
  p.companyId = company.id;
  // The domain is how we found it; only the name may be filled in.
  const plan = planUpdate(company.properties, { identity: { name: identity.name ?? "" }, owned, leadStatus: null }, p.state);
  if (Object.keys(plan.properties).length) {
    await client.updateObject("companies", company.id, plan.properties);
    p.writes++;
  }
}

/**
 * Runs `fn` with company access unless this run already found the token lacks it; a missing-scope error while
 * using companies marks them blocked and retries without (the contact itself needs only the contacts scope).
 */
async function companiesOptional<T>(ctx: HubSpotContext, p: HubSpotProgress, fn: (useCompanies: boolean) => Promise<T>): Promise<T> {
  const use = !ctx.blocked?.has("companies");
  try {
    return await fn(use);
  } catch (err) {
    const scopes = missingScopes(err);
    if (!use || !scopes.length) throw err;
    ctx.blocked?.add("companies");
    const warning = `Companies are not synced: the HubSpot token lacks ${scopes.join(", ")}`;
    if (!p.warnings.includes(warning)) p.warnings.push(warning);
    return fn(false);
  }
}

async function upsertContact(client: HubSpotClient, lead: SyncLead, ctx: HubSpotContext, p: HubSpotProgress) {
  const desired = { identity: contactIdentity(lead), owned: ownedProperties(lead, ctx.available.contacts), leadStatus: leadStatusFor(lead.stage) };
  const read = [...new Set([...CONTACT_READ, ...Object.keys(desired.owned)])];
  const get = (idOrEmail: string, byEmail = false) =>
    companiesOptional(ctx, p, (withCompanies) => client.getContact(idOrEmail, read, { byEmail, withCompanies }));
  let contact = lead.hubspot_id ? await get(lead.hubspot_id) : null;
  contact ??= await get(lead.email!, true);
  if (!contact) {
    try {
      const created = await companiesOptional(ctx, p, (useCompanies) =>
        client.createObject("contacts", planCreate(desired), useCompanies && p.companyId ? [{ to: p.companyId, typeId: ASSOC_CONTACT_TO_COMPANY }] : []),
      );
      p.contactId = created.id;
      p.created.contact = true;
      p.writes++;
      p.state.lead_status = desired.leadStatus ?? undefined;
      if (p.companyId && !ctx.blocked?.has("companies")) p.state.assoc = `${created.id}:${p.companyId}`;
      return;
    } catch (err) {
      // Created meanwhile (or by an earlier attempt that timed out): update that one instead.
      const existing = conflictExistingId(err);
      if (!existing) throw err;
      contact = await get(existing);
      if (!contact) throw err;
    }
  }
  p.contactId = contact.id;
  const plan = planUpdate(contact.properties, desired, p.state);
  if (Object.keys(plan.properties).length) {
    await client.updateObject("contacts", contact.id, plan.properties);
    p.writes++;
  }
  p.state.lead_status = plan.leadStatus;
  p.warnings.push(...plan.skipped);
  if (p.companyId && !ctx.blocked?.has("companies") && p.state.assoc !== `${contact.id}:${p.companyId}`) {
    const linked = contact.associations?.companies?.results?.some((r) => r.id === p.companyId);
    if (!linked) {
      await companiesOptional(ctx, p, async (useCompanies) => {
        if (useCompanies) await client.associateContactToCompany(contact.id, p.companyId!);
      });
      if (ctx.blocked?.has("companies")) return;
      p.writes++;
    }
    p.state.assoc = `${contact.id}:${p.companyId}`;
  }
}

async function pushNotes(client: HubSpotClient, snap: HubSpotSnapshot, p: HubSpotProgress, maxNotes: number) {
  const on = p.contactId ? { contactId: p.contactId } : p.companyId ? { companyId: p.companyId } : null;
  if (!on) return;
  const plan = await planNotes(snap.evidence, snap.messages);
  p.evidenceNotes.push(...plan.reuse);
  if (!plan.create.length) return;
  // A note created by an attempt that died before saving its id carries our ref: find it instead of adding a
  // second one. A record created in this run has no notes yet.
  const fresh = on.contactId ? p.created.contact : p.created.company;
  const existing = new Map<string, string>();
  if (!fresh) {
    const notes = await client.noteBodies(on.contactId ? "contact" : "company", (on.contactId ?? on.companyId)!);
    for (const n of notes) for (const ref of parseNoteRefs(n.body)) existing.set(ref, n.id);
  }
  const batch = plan.create.slice(0, maxNotes);
  p.more = plan.create.length > batch.length;
  for (const note of batch) {
    let noteId = existing.get(note.ref);
    if (!noteId) {
      noteId = (await client.createNote({ body: note.body, timestamp: note.timestamp, ...on })).id;
      p.writes++;
    }
    if (note.evidenceIds.length) p.evidenceNotes.push({ ids: note.evidenceIds, noteId });
    if (note.messageId) p.messageNotes.push({ id: note.messageId, noteId });
  }
}

/**
 * Upserts the company (by domain) and the contact (by email), associates them, writes the fields we own,
 * and adds missing evidence and email notes. Mutates `p` as it goes so a failure part-way still lets the
 * caller save what was created. A person lead's company is optional: without the companies scope it is
 * skipped with a warning and the contact still syncs.
 */
export async function pushLeadToHubSpot(client: HubSpotClient, snap: HubSpotSnapshot, ctx: HubSpotContext, p = newProgress(snap.lead)) {
  const { lead } = snap;
  const person = Boolean(lead.email);
  p.companyId = lead.hubspot_company_id ?? null;
  p.contactId = lead.hubspot_id ?? null;
  if (lead.domain && !ctx.blocked?.has("companies")) {
    try {
      await upsertCompany(client, lead, ctx, p, !person);
    } catch (err) {
      const scopes = missingScopes(err);
      if (!scopes.length) throw err;
      ctx.blocked?.add("companies");
      p.warnings.push(`Companies are not synced: the HubSpot token lacks ${scopes.join(", ")}`);
    }
  }
  if (!person && ctx.blocked?.has("companies")) {
    // A company-only lead has nothing else to sync. Completed with a warning; a manual sync retries it later.
    p.skipped = true;
    return p;
  }
  if (person) await upsertContact(client, lead, ctx, p);
  await pushNotes(client, snap, p, ctx.maxNotes ?? 20);
  return p;
}

async function saveHubSpotProgress(sql: Sql, leadId: string, p: HubSpotProgress, complete: boolean) {
  const evidence = p.evidenceNotes.flatMap((n) => n.ids.map((id) => ({ id, note_id: n.noteId })));
  await sql.transaction([
    sql`update leads set hubspot_id = coalesce(${p.contactId}, hubspot_id), hubspot_company_id = coalesce(${p.companyId}, hubspot_company_id),
               hubspot_state = ${JSON.stringify(p.state)}::jsonb,
               hubspot_synced_at = case when ${complete}::boolean then now() else hubspot_synced_at end
        where id = ${leadId}`,
    sql`update evidence e set hubspot_note_id = x.note_id
        from jsonb_to_recordset(${JSON.stringify(evidence)}::jsonb) as x(id text, note_id text)
        where e.id = x.id::bigint and e.lead_id = ${leadId} and e.hubspot_note_id is null`,
    sql`update messages m set hubspot_note_id = x.note_id
        from jsonb_to_recordset(${JSON.stringify(p.messageNotes.map((n) => ({ id: n.id, note_id: n.noteId })))}::jsonb) as x(id text, note_id text)
        where m.id = x.id::bigint and m.lead_id = ${leadId} and m.hubspot_note_id is null`,
  ]);
}

export async function syncLeadToHubSpot(sql: Sql, client: HubSpotClient, item: QueueItem, ctx: HubSpotContext & { scope: SyncScope }): Promise<HandleResult> {
  const snap = await loadHubSpotSnapshot(sql, item.lead_id!);
  if (!snap) return { skipped: true };
  if (!item.payload.force && !inScope(snap.lead, "hubspot", ctx.scope)) return { skipped: true };
  const p = newProgress(snap.lead);
  try {
    await pushLeadToHubSpot(client, snap, ctx, p);
  } catch (err) {
    // Keep the ids of whatever was created before the failure, so the retry updates instead of searching again.
    if (p.contactId || p.companyId || p.evidenceNotes.length || p.messageNotes.length) {
      await saveHubSpotProgress(sql, snap.lead.id, p, false).catch((e) => console.error("crm sync: saving partial progress failed:", describeError(e)));
    }
    throw err;
  }
  await saveHubSpotProgress(sql, snap.lead.id, p, true);
  return { more: p.more, warnings: p.warnings, skipped: p.skipped || (p.writes === 0 && !p.more) };
}

/** Which crusonia_* properties exist (one batch read per object), with warnings for what is missing. */
export async function hubspotAvailability(client: HubSpotClient): Promise<{ available: HubSpotContext["available"]; warnings: string[] }> {
  const warnings: string[] = [];
  const available = { contacts: new Set<string>(), companies: new Set<string>() };
  for (const obj of ["contacts", "companies"] as const) {
    try {
      available[obj] = await client.existingProperties(obj, HUBSPOT_PROPERTY_NAMES);
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      const scopes = missingScopes(err);
      if (scopes.length) {
        warnings.push(`HubSpot ${obj}: cannot read properties (token lacks ${scopes.join(", ")})`);
        continue;
      }
      warnings.push(`HubSpot ${obj}: property check failed (${describeError(err)})`);
      continue;
    }
    const missing = HUBSPOT_PROPERTY_NAMES.filter((n) => !available[obj].has(n));
    if (missing.length && obj === "contacts") {
      warnings.push(
        `HubSpot contacts: ${missing.length} Crusonia properties missing (${missing.join(", ")}); run \`bun run setup --crm\` ` +
          "(needs crm.schemas.contacts.write). Until then only standard fields and notes are synced.",
      );
    }
  }
  return { available, warnings };
}

// ---------- Notion push ----------

/** `dataSource` resolves the database's data source id; called only when a page must be found or created. */
export type NotionContext = { dataSource: () => Promise<string>; publicUrl: string };

/** Upserts the lead's page (keyed by the Lead ID column). Unchanged properties = no call. */
export async function pushLeadToNotion(client: NotionClient, lead: SyncLead, ctx: NotionContext) {
  const props = notionProperties(lead, ctx.publicUrl);
  const hash = await propertiesHash(props);
  if (lead.notion_page_id && lead.notion_hash === hash) return { changed: false, created: false, pageId: lead.notion_page_id, hash };
  if (lead.notion_page_id) {
    try {
      await client.updatePage(lead.notion_page_id, props);
      return { changed: true, created: false, pageId: lead.notion_page_id, hash };
    } catch (err) {
      if (!isGonePage(err)) throw err;
    }
  }
  const dataSourceId = await ctx.dataSource();
  const found = await client.queryDataSource(dataSourceId, { filter: { property: NOTION_KEY_PROPERTY, rich_text: { equals: lead.id } }, page_size: 5 });
  const existing = found.results.find((r) => !r.in_trash);
  if (existing) {
    await client.updatePage(existing.id, props);
    return { changed: true, created: false, pageId: existing.id, hash };
  }
  const page = await client.createPage(dataSourceId, props);
  return { changed: true, created: true, pageId: page.id, hash };
}

export async function syncLeadToNotion(sql: Sql, client: NotionClient, item: QueueItem, ctx: NotionContext & { scope: SyncScope }): Promise<HandleResult> {
  const lead = await loadSyncLead(sql, item.lead_id!);
  if (!lead) return { skipped: true };
  if (!item.payload.force && !inScope(lead, "notion", ctx.scope)) return { skipped: true };
  const out = await pushLeadToNotion(client, lead, ctx);
  if (!out.changed) return { skipped: true };
  await sql`update leads set notion_page_id = ${out.pageId}, notion_hash = ${out.hash}, notion_synced_at = now() where id = ${lead.id}`;
  return {};
}

export async function notionDataSourceId(client: NotionClient, databaseId: string): Promise<string> {
  const db = await client.retrieveDatabase(databaseId);
  const id = db.data_sources?.[0]?.id;
  if (!id) throw new ApiError(503, "not_configured", "NOTION_LEADS_DATABASE_ID has no data source; re-run `bun run setup --crm`");
  return id;
}

// ---------- HubSpot import ----------

export type ImportPayload = {
  phase: "contacts" | "companies";
  after: string | null;
  pages: number;
  created: number;
  updated: number;
  skipped: number;
  linked: number;
  started_at: string;
  actor: string;
  consent_property: string | null;
  /** Set when the token cannot read companies: contacts are imported without their company link. */
  companies_skipped?: string;
};

const IMPORT_SOURCE = "hubspot_import";

/** Stores HubSpot ids on the leads that came from these records (never replaces an existing link). */
async function linkImported(sql: Sql, rows: HubSpotImportRow[]): Promise<number> {
  const contacts = rows.filter((r) => r.hubspot_id).map((r) => ({
    email: r.email ?? null,
    domain: r.domain ?? null,
    name: r.name ?? null,
    hubspot_id: r.hubspot_id,
    company_id: r.hubspot_company_id ?? null,
  }));
  const companies = rows.filter((r) => !r.hubspot_id && r.hubspot_company_id && r.domain).map((r) => ({ domain: r.domain, company_id: r.hubspot_company_id }));
  const queries = [];
  if (contacts.length) {
    queries.push(sql`
      with x as (select * from jsonb_to_recordset(${JSON.stringify(contacts)}::jsonb) as x(email text, domain text, name text, hubspot_id text, company_id text))
      update leads l set hubspot_id = coalesce(l.hubspot_id, x.hubspot_id), hubspot_company_id = coalesce(l.hubspot_company_id, x.company_id)
      from x
      where ((x.email is not null and l.email = x.email)
             or (x.email is null and l.email is null and l.domain = x.domain and coalesce(lower(l.name), '') = coalesce(lower(x.name), '')))
        and (l.hubspot_id is null or (l.hubspot_id = x.hubspot_id and l.hubspot_company_id is null and x.company_id is not null))
      returning l.id`);
  }
  if (companies.length) {
    queries.push(sql`
      with x as (select * from jsonb_to_recordset(${JSON.stringify(companies)}::jsonb) as x(domain text, company_id text))
      update leads l set hubspot_company_id = x.company_id
      from x
      where l.email is null and l.domain = x.domain and coalesce(l.name, '') = '' and l.hubspot_company_id is null
      returning l.id`);
  }
  if (!queries.length) return 0;
  const sets = await sql.transaction(queries);
  return sets.reduce((n, set) => n + set.length, 0);
}

/**
 * One page (100 records) of the import job: contacts first, then companies. Records go through the same
 * dedupe and fill-blanks-only rules as the CSV import; consent only via HUBSPOT_CONSENT_PROPERTY.
 */
export async function runImportStep(sql: Sql, client: HubSpotClient, item: QueueItem, env: Env): Promise<HandleResult> {
  const p = { ...(item.payload as ImportPayload) };
  const mapping = consentMapping(env);
  const importedAt = new Date().toISOString();
  let rows: HubSpotImportRow[];
  let after: string | undefined;

  if (p.phase === "contacts") {
    const properties = [...HUBSPOT_CONTACT_IMPORT_PROPERTIES, ...(mapping ? [mapping.property] : [])];
    let page;
    try {
      page = await client.listObjects("contacts", { properties, after: p.after ?? undefined, associations: p.companies_skipped ? [] : ["companies"] });
    } catch (err) {
      const scopes = missingScopes(err);
      if (!scopes.length || p.companies_skipped) throw err;
      // Reading associated companies needs the companies scope: import the contacts without that link.
      p.companies_skipped = `token lacks ${scopes.join(", ")}`;
      page = await client.listObjects("contacts", { properties, after: p.after ?? undefined });
    }
    rows = page.results.map((o, i) => contactToCandidate(o, p.pages * 100 + i + 1, mapping, importedAt));
    after = page.paging?.next?.after;
  } else {
    let page;
    try {
      page = await client.listObjects("companies", { properties: HUBSPOT_COMPANY_IMPORT_PROPERTIES, after: p.after ?? undefined });
    } catch (err) {
      const scopes = missingScopes(err);
      if (!scopes.length) throw err;
      p.companies_skipped = `token lacks ${scopes.join(", ")}`;
      return finishImport(sql, p);
    }
    rows = page.results.map((o, i) => companyToCandidate(o, p.pages * 100 + i + 1));
    after = page.paging?.next?.after;
  }

  const results = await applyImportCandidates(sql, rows, { source: IMPORT_SOURCE, actor: p.actor, via: IMPORT_SOURCE });
  const s = summarizeImport(results);
  p.created += s.created;
  p.updated += s.updated;
  p.skipped += s.skipped;
  p.linked += await linkImported(sql, rows);
  p.pages++;
  p.after = after ?? null;
  if (!after) {
    if (p.phase === "companies" || p.companies_skipped) return finishImport(sql, p);
    p.phase = "companies";
  }
  return { more: true, payload: p };
}

async function finishImport(sql: Sql, p: ImportPayload): Promise<HandleResult> {
  const summary = { ...p, finished_at: new Date().toISOString() };
  await sql.transaction([
    sql`insert into events (lead_id, kind, data) values (null, 'leads_imported', ${JSON.stringify({
      via: IMPORT_SOURCE,
      created: p.created,
      updated: p.updated,
      skipped: p.skipped,
      linked: p.linked,
      source: IMPORT_SOURCE,
      actor: p.actor,
    })}::jsonb)`,
    statusUpsert(sql, "hubspot", { last_import: summary }),
  ]);
  return { payload: summary };
}

// ---------- the cron step ----------

function statusUpsert(sql: Sql, t: CrmTarget, patch: Record<string, unknown>) {
  return sql`
    insert into settings (key, value) values (${`crm_sync:${t}`}, ${JSON.stringify(patch)}::jsonb)
    on conflict (key) do update set value = settings.value || excluded.value`;
}

async function recordRun(sql: Sql, t: CrmTarget, reports: DrainReport[]) {
  const claimed = reports.reduce((n, r) => n + r.claimed, 0);
  if (!claimed) return;
  const now = new Date().toISOString();
  const errors = reports.flatMap((r) => r.errors);
  const done = reports.reduce((n, r) => n + r.done + r.skipped, 0);
  const patch: Record<string, unknown> = {
    last_run_at: now,
    warnings: [...new Set(reports.flatMap((r) => r.warnings))].slice(0, 10),
  };
  if (done) patch.last_success_at = now;
  if (errors.length) Object.assign(patch, { last_error: errors.at(-1), last_error_at: now });
  else if (done) patch.last_error = null;
  const limited = reports.find((r) => r.rate_limited_until)?.rate_limited_until;
  if (limited) patch.rate_limited_until = limited;
  await statusUpsert(sql, t, patch);
}

export type RunOptions = { leadIds?: string[]; pace?: Pace; now?: () => number; random?: () => number };

/**
 * The minute cron's CRM step. Idle cost: one statement (mirror the switches, count due rows). Then per target
 * a batch of CRM_SYNC_BATCH_SIZE leads and, for HubSpot, one import page.
 */
export async function runCrmSync(sql: Sql, env: Env, fetchFn?: FetchFn, opts: RunOptions = {}): Promise<Record<string, unknown>> {
  const cfg = crmConfig(env);
  const active = CRM_TARGETS.filter((t) => cfg[t].active);
  const leadIds = opts.leadIds ?? null;
  const [, dueRows] = await sql.transaction([
    mirrorTargets(sql, active),
    sql`select target, entity, count(*)::int as n from crm_sync_queue
        where status = 'pending' and next_attempt_at <= now() and (locked_until is null or locked_until < now())
          and (${leadIds}::text[] is null or lead_id = any(${leadIds}::text[]) or entity = 'import')
        group by target, entity`,
  ]);
  const due = (t: CrmTarget, e: string) => Number(dueRows!.find((r) => r.target === t && r.entity === e)?.n ?? 0);
  const store = sqlQueueStore(sql, { leadIds: opts.leadIds });
  const drainOpts = { now: opts.now, random: opts.random };
  const pace = opts.pace ?? realPace;
  const report: Record<string, unknown> = {};

  // HubSpot: lead pushes when the switch is on; the import (read-only on HubSpot) whenever the token is set.
  if (!cfg.hubspot.configured) report.hubspot = "not configured";
  else if (!due("hubspot", "lead") && !due("hubspot", "import")) report.hubspot = cfg.hubspot.active ? "idle" : "off";
  else {
    const client = new HubSpotClient(env.HUBSPOT_ACCESS_TOKEN!, fetchFn, { pace });
    const runs: DrainReport[] = [];
    const out: Record<string, unknown> = {};
    if (cfg.hubspot.active && due("hubspot", "lead")) {
      const items = await store.claimLeads("hubspot", cfg.hubspot.scope, cfg.batchSize);
      let ctx: (HubSpotContext & { scope: SyncScope }) | undefined;
      const r = emptyReport();
      await drain(
        store,
        items,
        async (item) => {
          if (!ctx) {
            const { available, warnings } = await hubspotAvailability(client);
            r.warnings.push(...warnings);
            ctx = { available, blocked: new Set(), scope: cfg.hubspot.scope };
          }
          return syncLeadToHubSpot(sql, client, item, ctx);
        },
        { ...drainOpts, report: r },
      );
      runs.push(r);
      out.leads = r;
    }
    const limited = runs.some((r) => r.rate_limited_until || r.stopped);
    if (due("hubspot", "import") && !limited) {
      const items = await store.claim("hubspot", "import", 1);
      const r = await drain(store, items, (item) => runImportStep(sql, client, item, env), drainOpts);
      runs.push(r);
      out.import = r;
    }
    out.calls = client.calls;
    await recordRun(sql, "hubspot", runs);
    report.hubspot = out;
  }

  if (!cfg.notion.active) report.notion = cfg.notion.configured ? "off" : "not configured";
  else if (!due("notion", "lead")) report.notion = "idle";
  else {
    const client = new NotionClient(env.NOTION_API_TOKEN!, fetchFn, { pace });
    const items = await store.claimLeads("notion", cfg.notion.scope, cfg.batchSize);
    let dataSourceId: Promise<string> | undefined;
    const ctx = {
      // Once per run, and only if some lead needs a page found or created.
      dataSource: () => (dataSourceId ??= notionDataSourceId(client, env.NOTION_LEADS_DATABASE_ID!)),
      publicUrl: env.PUBLIC_URL,
      scope: cfg.notion.scope,
    };
    const r = await drain(store, items, (item) => syncLeadToNotion(sql, client, item, ctx), drainOpts);
    await recordRun(sql, "notion", [r]);
    report.notion = { leads: r, calls: client.calls };
  }
  return report;
}

// ---------- API: status, manual sync, import ----------

type TargetStatus = TargetConfig & {
  switch: string;
  last_run_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  rate_limited_until: string | null;
  warnings: string[];
  queue: { pending: number; due: number; failed: number } | null;
  recent_errors: { lead_id: string | null; entity: string; attempts: number; error: string; status: string; at: string }[];
};

/** Per-target status for GET /api/integrations/crm. `sql` null (no database) = configuration only. */
export async function getCrmStatus(sql: Sql | null, env: Env) {
  const cfg = crmConfig(env);
  const base = (t: CrmTarget): TargetStatus => ({
    ...cfg[t],
    switch: SWITCH[t],
    last_run_at: null,
    last_success_at: null,
    last_error: null,
    last_error_at: null,
    rate_limited_until: null,
    warnings: [],
    queue: null,
    recent_errors: [],
  });
  const out = {
    hubspot: {
      ...base("hubspot"),
      consent_property: consentMapping(env)?.property ?? null,
      import: null as Record<string, unknown> | null,
      last_import: null as Record<string, unknown> | null,
    },
    notion: base("notion"),
    batch_size: cfg.batchSize,
  };
  if (!sql) return out;
  const [counts, states, errors, job] = await sql.transaction(
    [
      sql`select target, count(*) filter (where status = 'pending')::int as pending,
                 count(*) filter (where status = 'pending' and next_attempt_at <= now())::int as due,
                 count(*) filter (where status = 'failed')::int as failed
          from crm_sync_queue where entity = 'lead' group by target`,
      sql`select key, value from settings where key in ('crm_sync:hubspot', 'crm_sync:notion')`,
      sql`select * from (
            select target, lead_id, entity, attempts, last_error, status, updated_at,
                   row_number() over (partition by target order by updated_at desc) as n
            from crm_sync_queue where last_error is not null) e
          where n <= 5 order by updated_at desc`,
      sql`select payload, status, attempts, last_error, next_attempt_at from crm_sync_queue
          where target = 'hubspot' and entity = 'import' limit 1`,
    ],
    { readOnly: true },
  );
  for (const t of CRM_TARGETS) {
    const c = counts!.find((r) => r.target === t);
    out[t].queue = { pending: Number(c?.pending ?? 0), due: Number(c?.due ?? 0), failed: Number(c?.failed ?? 0) };
    const s = (states!.find((r) => r.key === `crm_sync:${t}`)?.value ?? {}) as Record<string, unknown>;
    for (const k of ["last_run_at", "last_success_at", "last_error", "last_error_at", "rate_limited_until"] as const) {
      out[t][k] = (s[k] as string | null | undefined) ?? null;
    }
    out[t].warnings = (s.warnings as string[] | undefined) ?? [];
    out[t].recent_errors = errors!
      .filter((e) => e.target === t)
      .map((e) => ({
        lead_id: e.lead_id as string | null,
        entity: e.entity as string,
        attempts: Number(e.attempts),
        error: e.last_error as string,
        status: e.status as string,
        at: new Date(e.updated_at as string).toISOString(),
      }));
    if (t === "hubspot") out.hubspot.last_import = (s.last_import as Record<string, unknown> | undefined) ?? null;
  }
  const j = job![0];
  if (j) {
    out.hubspot.import = {
      status: j.status === "failed" ? "failed" : "running",
      ...(j.payload as Record<string, unknown>),
      attempts: Number(j.attempts),
      last_error: j.last_error ?? null,
      next_attempt_at: new Date(j.next_attempt_at as string).toISOString(),
    };
  }
  return out;
}

/** Short form for GET /api/status. */
export async function crmStatusSummary(sql: Sql | null, env: Env) {
  let full;
  let error: string | undefined;
  try {
    full = await getCrmStatus(sql, env);
  } catch (err) {
    error = describeError(err);
    full = await getCrmStatus(null, env);
  }
  const short = (s: TargetStatus) => ({
    enabled: s.enabled,
    configured: s.configured,
    active: s.active,
    queue_depth: s.queue ? s.queue.pending : null,
    failed: s.queue ? s.queue.failed : null,
    last_sync_at: s.last_success_at,
    last_error: s.last_error,
  });
  return { hubspot: short(full.hubspot), notion: short(full.notion), ...(error ? { error } : {}) };
}

/** 503 when the target's keys are missing; 409 when its switch is off (and `needsSwitch`). No database access. */
export function requireTarget(env: Env, t: CrmTarget, opts: { needsSwitch: boolean }) {
  const cfg = crmConfig(env)[t];
  if (!cfg.configured) throw new ApiError(503, "not_configured", `${cfg.missing.join(" and ")} ${cfg.missing.length > 1 ? "are" : "is"} not set`);
  if (opts.needsSwitch && !cfg.enabled) {
    throw new ApiError(
      409,
      "sync_disabled",
      `${LABEL[t]} sync is off: set ${SWITCH[t]}=true (in .dev.vars, then \`bun run secrets\`). Nothing is written to ${LABEL[t]} until then.`,
    );
  }
  return cfg;
}

/** POST /api/integrations/sync: queue the given leads (even outside the scope) or every lead in the scope. */
export async function enqueueManualSync(sql: Sql, env: Env, input: { target: CrmTarget; lead_ids?: string[] }) {
  const cfg = requireTarget(env, input.target, { needsSwitch: true });
  const active = CRM_TARGETS.filter((t) => crmConfig(env)[t].active);
  await mirrorTargets(sql, active);
  if (input.lead_ids) {
    const ids = [...new Set(input.lead_ids)];
    const res = await enqueueLeads(sql, input.target, { leadIds: ids }, "manual");
    const found = new Set(res.lead_ids);
    return { target: input.target, queued: res.queued, unknown_lead_ids: ids.filter((id) => !found.has(id)) };
  }
  const res = await enqueueLeads(sql, input.target, { scope: cfg.scope }, "manual");
  return { target: input.target, scope: cfg.scope, queued: res.queued };
}

/** POST /api/integrations/hubspot/import: queue the import job (409 while one runs). Read-only on HubSpot. */
export async function startHubSpotImport(sql: Sql, env: Env, actor: string) {
  requireTarget(env, "hubspot", { needsSwitch: false });
  const payload: ImportPayload = {
    phase: "contacts",
    after: null,
    pages: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    linked: 0,
    started_at: new Date().toISOString(),
    actor,
    consent_property: consentMapping(env)?.property ?? null,
  };
  const rows = await sql`
    insert into crm_sync_queue as q (target, entity, lead_id, reason, payload)
    values ('hubspot', 'import', null, 'manual', ${JSON.stringify(payload)}::jsonb)
    on conflict (target, entity, (coalesce(lead_id, ''))) do update set
      payload = excluded.payload, status = 'pending', attempts = 0, last_error = null, next_attempt_at = now(),
      locked_until = null, version = q.version + 1, updated_at = now()
    where q.status = 'failed'
    returning payload`;
  if (!rows[0]) {
    const running = await sql`select payload, attempts, last_error from crm_sync_queue where target = 'hubspot' and entity = 'import'`;
    throw new ApiError(409, "import_running", "A HubSpot import is already running; follow it in GET /api/integrations/crm", running[0]);
  }
  return {
    status: "queued",
    job: rows[0].payload as ImportPayload,
    note: "The minute cron imports 100 records per run (contacts, then companies). Imported leads have no consent unless HUBSPOT_CONSENT_PROPERTY is set.",
  };
}
