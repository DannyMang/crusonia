// `bun run setup --crm`: the HubSpot properties and the Notion database CRM sync writes to. Idempotent: existing
// properties, groups and the database are found and reused (missing pieces are added). Clients are passed in so
// test/crm-setup.test.ts runs it against mocked HTTP.
import { HubSpotClient, missingScopes, type PropertyDefinition } from "../../src/providers/hubspot.ts";
import { NotionClient, type NotionBlock } from "../../src/providers/notion.ts";
import {
  HUBSPOT_GROUP,
  HUBSPOT_OBJECTS,
  HUBSPOT_PROPERTIES,
  LEAD_STATUS_FOR_STAGE,
  NOTION_DATABASE_TITLE,
  notionSchema,
} from "../../src/services/crm-fields.ts";

export type SetupReport = { done: string[]; notes: string[] };

const scopeNote = (what: string, err: unknown) => {
  const scopes = missingScopes(err);
  return scopes.length ? `${what}: the HubSpot token lacks ${scopes.join(", ")}. Add it to the private app, then re-run \`bun run setup --crm\`.` : undefined;
};

/** The "crusonia" property group and crusonia_* properties on contacts and companies. */
export async function setupHubSpot(client: HubSpotClient): Promise<SetupReport> {
  const report: SetupReport = { done: [], notes: [] };
  for (const objectType of HUBSPOT_OBJECTS) {
    try {
      if (!(await client.getPropertyGroup(objectType, HUBSPOT_GROUP.name))) {
        await client.createPropertyGroup(objectType, HUBSPOT_GROUP);
        report.done.push(`HubSpot ${objectType}: created property group "${HUBSPOT_GROUP.label}"`);
      }
      const created: string[] = [];
      const updated: string[] = [];
      for (const spec of HUBSPOT_PROPERTIES) {
        const def: PropertyDefinition = {
          name: spec.name,
          label: spec.label,
          type: spec.type,
          fieldType: spec.fieldType,
          groupName: HUBSPOT_GROUP.name,
          description: spec.description,
          ...(spec.options ? { options: spec.options } : {}),
        };
        const existing = await client.getProperty(objectType, spec.name);
        if (!existing) {
          await client.createProperty(objectType, def);
          created.push(spec.name);
        } else if (existing.type !== spec.type) {
          report.notes.push(`HubSpot ${objectType}.${spec.name} exists with type ${existing.type} (expected ${spec.type}); left as is, values may be rejected.`);
        } else if (spec.options) {
          // New stages become new options; options someone added in HubSpot are kept.
          const have = new Set((existing.options ?? []).map((o) => o.value));
          const missing = spec.options.filter((o) => !have.has(o.value));
          if (missing.length) {
            await client.updateProperty(objectType, spec.name, { options: [...(existing.options ?? []), ...missing] });
            updated.push(`${spec.name} (+${missing.length} options)`);
          }
        }
      }
      report.done.push(
        `HubSpot ${objectType}: ${created.length ? `created ${created.join(", ")}` : "properties already present"}${updated.length ? `; updated ${updated.join(", ")}` : ""}`,
      );
    } catch (err) {
      const note = scopeNote(`HubSpot ${objectType} properties`, err);
      if (!note) throw err;
      report.notes.push(note);
    }
  }
  // hs_lead_status is HubSpot's; portals can edit its options. Say which of our statuses it would reject.
  try {
    const status = await client.getProperty("contacts", "hs_lead_status");
    const options = new Set((status?.options ?? []).map((o) => o.value));
    const wanted = [...new Set(Object.values(LEAD_STATUS_FOR_STAGE).filter((v): v is string => Boolean(v)))];
    const missing = wanted.filter((v) => !options.has(v));
    if (!status) report.notes.push("HubSpot contacts have no hs_lead_status property; lead status will not sync.");
    else if (missing.length) report.notes.push(`hs_lead_status has no option ${missing.join(", ")}; leads in those stages keep their status. Add the options in HubSpot.`);
  } catch (err) {
    const note = scopeNote("Reading hs_lead_status", err);
    if (!note) throw err;
    report.notes.push(note);
  }
  return report;
}

async function findChildDatabase(client: NotionClient, pageId: string): Promise<string | undefined> {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await client.listBlockChildren(pageId, cursor);
    const hit = res.results.find((b: NotionBlock) => b.type === "child_database" && b.child_database?.title === NOTION_DATABASE_TITLE);
    if (hit) return hit.id;
    if (!res.has_more || !res.next_cursor) return undefined;
    cursor = res.next_cursor;
  }
  return undefined;
}

/** Adds columns the database lacks (never removes or retypes the owner's columns). */
async function ensureColumns(client: NotionClient, databaseId: string, report: SetupReport) {
  const db = await client.retrieveDatabase(databaseId);
  const dataSourceId = db.data_sources?.[0]?.id;
  if (!dataSourceId) {
    report.notes.push(`Notion database "${NOTION_DATABASE_TITLE}" has no data source; delete it and re-run to recreate it.`);
    return;
  }
  const ds = await client.retrieveDataSource(dataSourceId);
  const schema = notionSchema();
  const have = new Map(Object.entries(ds.properties).map(([name, p]) => [name, p.type]));
  const missing: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(schema)) {
    const type = (def as { type: string }).type;
    if (!have.has(name)) {
      if (type === "title") report.notes.push(`Notion: the title column is not named "${name}"; rename it to "${name}".`);
      else missing[name] = def;
    } else if (have.get(name) !== type) {
      report.notes.push(`Notion column "${name}" is ${have.get(name)} (expected ${type}); sync writes to it will fail until it is changed back.`);
    }
  }
  if (Object.keys(missing).length) {
    await client.updateDataSource(dataSourceId, missing);
    report.done.push(`Notion: added columns ${Object.keys(missing).join(", ")}`);
  } else {
    report.done.push(`Notion: database "${NOTION_DATABASE_TITLE}" has every column`);
  }
}

/**
 * Creates the "Crusonia leads" database under the shared parent page, or reuses it (NOTION_LEADS_DATABASE_ID,
 * else a child database with that title on the page). Returns the database id to store.
 */
export async function setupNotion(client: NotionClient, opts: { parentPageId?: string; databaseId?: string }): Promise<SetupReport & { databaseId?: string; created?: boolean }> {
  const report: SetupReport = { done: [], notes: [] };
  if (opts.databaseId) {
    await ensureColumns(client, opts.databaseId, report);
    return { ...report, databaseId: opts.databaseId, created: false };
  }
  if (!opts.parentPageId) {
    report.notes.push(
      "Notion skipped: share a page with the integration (page menu > Connections), put its id in NOTION_PARENT_PAGE_ID, then re-run `bun run setup --crm --write`.",
    );
    return report;
  }
  const existing = await findChildDatabase(client, opts.parentPageId);
  if (existing) {
    await ensureColumns(client, existing, report);
    report.done.unshift(`Notion: found "${NOTION_DATABASE_TITLE}" on the parent page`);
    return { ...report, databaseId: existing, created: false };
  }
  const db = await client.createDatabase({ parentPageId: opts.parentPageId, title: NOTION_DATABASE_TITLE, properties: notionSchema() });
  report.done.push(`Notion: created "${NOTION_DATABASE_TITLE}"`);
  return { ...report, databaseId: db.id, created: true };
}
