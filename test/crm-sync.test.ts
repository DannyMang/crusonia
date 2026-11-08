// CRM sync pushes against in-memory HubSpot and Notion fakes (no database): upserts, field ownership, note
// dedupe and recovery, missing scopes, idempotency. Plus `bun run setup --crm` and the routes' config errors.
import { describe, expect, test } from "bun:test";
import { HubSpotClient, type PropertyDefinition } from "../src/providers/hubspot.ts";
import { NotionClient } from "../src/providers/notion.ts";
import type { FetchFn } from "../src/providers/http.ts";
import { setupHubSpot, setupNotion } from "../scripts/lib/crm-setup.ts";
import { evidenceRef, HUBSPOT_PROPERTY_NAMES, notionSchema, refMarker, type EvidenceRow, type MessageRow } from "../src/services/crm-fields.ts";
import { hubspotAvailability, pushLeadToHubSpot, pushLeadToNotion, type HubSpotContext, type HubSpotProgress, type HubSpotSnapshot } from "../src/services/crm-sync.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/env.ts";
import { fakeHubSpot, fakeNotion, fakePace, syncLead } from "./helpers/fake-crm.ts";

const ALL = new Set(HUBSPOT_PROPERTY_NAMES);
const ctx = (over: Partial<HubSpotContext> = {}): HubSpotContext => ({ available: { contacts: ALL, companies: ALL }, blocked: new Set(), ...over });
const hubspot = (fn: FetchFn) => new HubSpotClient("pat-test", fn, { pace: fakePace() });

const evidence: EvidenceRow[] = [
  { id: "11", claim: "Hiring 3 SDRs", source_url: "https://acme.com/jobs", created_at: "2026-11-05T00:00:00Z", hubspot_note_id: null },
  { id: "12", claim: "Hiring 3 SDRs", source_url: "https://acme.com/jobs", created_at: "2026-11-05T01:00:00Z", hubspot_note_id: null },
];
const messages: MessageRow[] = [
  { id: "21", direction: "out", subject: "Quick question", body: "Hi Ada", label: null, created_at: "2026-11-06T00:00:00Z", hubspot_note_id: null },
];
const snapshot = (over: Partial<HubSpotSnapshot> = {}): HubSpotSnapshot => ({
  lead: syncLead({ consent_at: "2026-11-01T00:00:00Z", stage: "sent", last_outreach_at: "2026-11-06T00:00:00Z" }),
  evidence: evidence.map((e) => ({ ...e })),
  messages: messages.map((m) => ({ ...m })),
  ...over,
});

/** What saveHubSpotProgress would store, applied to the snapshot (the next sync reads it back). */
function persisted(snap: HubSpotSnapshot, p: HubSpotProgress): HubSpotSnapshot {
  const evNotes = new Map(p.evidenceNotes.flatMap((n) => n.ids.map((id) => [id, n.noteId] as const)));
  const msgNotes = new Map(p.messageNotes.map((n) => [n.id, n.noteId] as const));
  return {
    lead: { ...snap.lead, hubspot_id: p.contactId ?? snap.lead.hubspot_id, hubspot_company_id: p.companyId ?? snap.lead.hubspot_company_id, hubspot_state: p.state },
    evidence: snap.evidence.map((e) => ({ ...e, hubspot_note_id: e.hubspot_note_id ?? evNotes.get(e.id) ?? null })),
    messages: snap.messages.map((m) => ({ ...m, hubspot_note_id: m.hubspot_note_id ?? msgNotes.get(m.id) ?? null })),
  };
}

describe("HubSpot push", () => {
  test("a new lead: company by domain, contact by email, associated, our fields, notes with source URLs", async () => {
    const hs = fakeHubSpot();
    const p = await pushLeadToHubSpot(hubspot(hs.fn), snapshot(), ctx());
    const company = hs.companies.get(p.companyId!)!;
    expect(company.properties).toEqual({ name: "Acme", domain: "acme.com" });
    const contact = hs.contacts.get(p.contactId!)!;
    expect(contact.properties).toMatchObject({
      email: "ada@acme.com",
      firstname: "Ada",
      lastname: "Lovelace",
      jobtitle: "CTO",
      company: "Acme",
      hs_lead_status: "ATTEMPTED_TO_CONTACT",
      crusonia_fit_score: "82",
      crusonia_stage: "sent",
      crusonia_source: "google_search",
      crusonia_lead_id: "lead_1",
      crusonia_last_outreach_at: "2026-11-06T00:00:00.000Z",
    });
    expect([...contact.companies]).toEqual([p.companyId!]);
    // Two identical evidence rows -> one note; plus the sent email. All on the contact.
    expect(hs.notes.size).toBe(2);
    const bodies = [...hs.notes.values()];
    expect(bodies.every((n) => n.contact === p.contactId)).toBe(true);
    expect(bodies[0]!.body).toContain("https://acme.com/jobs");
    expect(bodies[1]!.body).toContain("Email sent by Crusonia");
    expect(p.evidenceNotes).toEqual([{ ids: ["11", "12"], noteId: expect.any(String) }]);
    expect(p.messageNotes).toEqual([{ id: "21", noteId: expect.any(String) }]);
    expect(p.state).toEqual({ lead_status: "ATTEMPTED_TO_CONTACT", assoc: `${p.contactId}:${p.companyId}` });
    // A brand-new contact has no notes to look for.
    expect(hs.calls.some((c) => c.path.endsWith("/notes/search"))).toBe(false);
  });

  test("idempotent: syncing again with the stored ids writes nothing", async () => {
    const hs = fakeHubSpot();
    const client = hubspot(hs.fn);
    const first = snapshot();
    const p = await pushLeadToHubSpot(client, first, ctx());
    const before = hs.writes().length;
    const again = await pushLeadToHubSpot(client, persisted(first, p), ctx());
    expect(hs.writes().length).toBe(before);
    expect(again.writes).toBe(0);
    expect(hs.contacts.size).toBe(1);
    expect(hs.companies.size).toBe(1);
    expect(hs.notes.size).toBe(2);
  });

  test("an existing HubSpot contact: blanks filled, a human's name and lead status kept, our fields written", async () => {
    const hs = fakeHubSpot();
    const client = hubspot(hs.fn);
    await client.createObject("companies", { name: "Acme Corporation", domain: "acme.com" });
    await client.createObject("contacts", { email: "ada@acme.com", firstname: "Augusta", hs_lead_status: "BAD_TIMING" });
    const p = await pushLeadToHubSpot(client, snapshot({ evidence: [], messages: [] }), ctx());
    expect(hs.contacts.size).toBe(1);
    expect(hs.companies.size).toBe(1);
    const contact = hs.byEmail("ada@acme.com")!;
    expect(contact.properties.firstname).toBe("Augusta");
    expect(contact.properties.lastname).toBe("Lovelace");
    expect(contact.properties.hs_lead_status).toBe("BAD_TIMING");
    expect(contact.properties.crusonia_stage).toBe("sent");
    expect(hs.companies.get(p.companyId!)!.properties.name).toBe("Acme Corporation");
    expect(p.warnings.some((w) => w.includes("BAD_TIMING"))).toBe(true);
    expect([...contact.companies]).toEqual([p.companyId!]);
    expect(hs.calls.some((c) => c.method === "PUT" && c.path.includes("/associations/default/"))).toBe(true);
  });

  test("hs_lead_status follows our stage while HubSpot still holds the value we wrote", async () => {
    const hs = fakeHubSpot();
    const client = hubspot(hs.fn);
    const first = snapshot({ lead: syncLead({ consent_at: "2026-11-01T00:00:00Z", stage: "qualified" }), evidence: [], messages: [] });
    const p = await pushLeadToHubSpot(client, first, ctx());
    expect(hs.contacts.get(p.contactId!)!.properties.hs_lead_status).toBe("OPEN");
    const next = persisted(first, p);
    next.lead = { ...next.lead, stage: "replied" };
    await pushLeadToHubSpot(client, next, ctx());
    expect(hs.contacts.get(p.contactId!)!.properties.hs_lead_status).toBe("CONNECTED");
  });

  test("notes created by an attempt that died before saving are found by ref, not duplicated", async () => {
    const hs = fakeHubSpot();
    const client = hubspot(hs.fn);
    const contact = await client.createObject("contacts", { email: "ada@acme.com" });
    const ref = await evidenceRef("Hiring 3 SDRs", "https://acme.com/jobs");
    const orphan = await client.createNote({ body: `<p>old</p><p>${refMarker(ref)}</p>`, timestamp: "2026-11-05T00:00:00Z", contactId: contact.id });
    const p = await pushLeadToHubSpot(client, snapshot({ lead: syncLead({ hubspot_id: contact.id, domain: null }) }), ctx());
    expect(hs.notes.size).toBe(2); // the orphan + the email note
    expect(p.evidenceNotes).toEqual([{ ids: ["11", "12"], noteId: orphan.id }]);
  });

  test("notes are capped per run; the rest come on the next run (more)", async () => {
    const hs = fakeHubSpot();
    const many: EvidenceRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: String(100 + i),
      claim: `Claim ${i}`,
      source_url: `https://acme.com/${i}`,
      created_at: `2026-11-0${i + 1}T00:00:00Z`,
      hubspot_note_id: null,
    }));
    const p = await pushLeadToHubSpot(hubspot(hs.fn), snapshot({ evidence: many, messages: [] }), ctx({ maxNotes: 3 }));
    expect(hs.notes.size).toBe(3);
    expect(p.more).toBe(true);
  });

  test("without the companies scope the contact and notes still sync; company-only leads are skipped", async () => {
    const hs = fakeHubSpot({ companiesScope: false });
    const client = hubspot(hs.fn);
    const c = ctx();
    const p = await pushLeadToHubSpot(client, snapshot(), c);
    expect(p.contactId).not.toBeNull();
    expect(p.companyId).toBeNull();
    expect(hs.contacts.get(p.contactId!)!.companies.size).toBe(0);
    expect(hs.notes.size).toBe(2);
    expect(p.warnings.join(" ")).toContain("crm.objects.companies.read");
    expect(c.blocked!.has("companies")).toBe(true);
    // Next lead in the same run: no company call at all.
    const before = hs.calls.length;
    const co = await pushLeadToHubSpot(client, snapshot({ lead: syncLead({ id: "lead_2", email: null, name: null, qualified: true }) }), c);
    expect(co.skipped).toBe(true);
    expect(hs.calls.length).toBe(before);
  });

  test("custom properties not created yet: only standard fields are sent", async () => {
    const hs = fakeHubSpot({ customProperties: false });
    const client = hubspot(hs.fn);
    const { available, warnings } = await hubspotAvailability(client);
    expect(available.contacts.size).toBe(0);
    expect(warnings[0]).toContain("bun run setup --crm");
    const p = await pushLeadToHubSpot(client, snapshot({ evidence: [], messages: [] }), ctx({ available }));
    const props = hs.contacts.get(p.contactId!)!.properties;
    expect(Object.keys(props).some((k) => k.startsWith("crusonia_"))).toBe(false);
    expect(props.hs_lead_status).toBe("ATTEMPTED_TO_CONTACT");
  });

  test("a company-only lead puts our fields and notes on the company", async () => {
    const hs = fakeHubSpot();
    const lead = syncLead({ email: null, name: null, title: null, qualified: true, stage: "no_consent" });
    const p = await pushLeadToHubSpot(hubspot(hs.fn), snapshot({ lead, messages: [] }), ctx());
    expect(p.contactId).toBeNull();
    expect(hs.companies.get(p.companyId!)!.properties).toMatchObject({ name: "Acme", domain: "acme.com", crusonia_fit_score: "82", crusonia_stage: "no_consent" });
    expect([...hs.notes.values()][0]!.company).toBe(p.companyId!);
  });

  test("a 409 on create (created concurrently) updates the existing contact instead", async () => {
    const hs = fakeHubSpot();
    const client = hubspot(hs.fn);
    await client.createObject("contacts", { email: "ada@acme.com" });
    // Make the lookup by email miss once, as if the contact appeared between the read and the create.
    const original = hs.fn;
    let missed = false;
    const racy: FetchFn = async (url, init) => {
      if (!missed && url.includes("idProperty=email")) {
        missed = true;
        return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
      }
      return original(url, init);
    };
    const p = await pushLeadToHubSpot(hubspot(racy), snapshot({ evidence: [], messages: [], lead: syncLead({ domain: null, stage: "sent", consent_at: "2026-11-01T00:00:00Z" }) }), ctx());
    expect(hs.contacts.size).toBe(1);
    expect(hs.byEmail("ada@acme.com")!.id).toBe(p.contactId!);
    expect(hs.byEmail("ada@acme.com")!.properties.crusonia_stage).toBe("sent");
  });
});

describe("Notion push", () => {
  const nctx = { dataSource: async () => "ds_1", publicUrl: "https://crusonia.example" };
  const notion = (fn: FetchFn) => new NotionClient("ntn_test", fn, { pace: fakePace() });

  test("creates one page per lead, then does nothing while the lead is unchanged", async () => {
    const nt = fakeNotion();
    const client = notion(nt.fn);
    const lead = syncLead();
    const first = await pushLeadToNotion(client, lead, nctx);
    expect(first).toMatchObject({ changed: true, created: true });
    expect(nt.pages.size).toBe(1);
    const calls = nt.calls.length;
    const second = await pushLeadToNotion(client, { ...lead, notion_page_id: first.pageId, notion_hash: first.hash }, nctx);
    expect(second.changed).toBe(false);
    expect(nt.calls.length).toBe(calls);
  });

  test("a changed lead updates its page in place", async () => {
    const nt = fakeNotion();
    const client = notion(nt.fn);
    const first = await pushLeadToNotion(client, syncLead(), nctx);
    const out = await pushLeadToNotion(client, syncLead({ stage: "sent", notion_page_id: first.pageId, notion_hash: first.hash }), nctx);
    expect(out).toMatchObject({ changed: true, created: false, pageId: first.pageId });
    expect(nt.pages.get(first.pageId)!.properties.Stage).toEqual({ select: { name: "sent" } });
    expect(nt.pages.size).toBe(1);
  });

  test("a lost page id is recovered by the Lead ID column (no duplicate page)", async () => {
    const nt = fakeNotion();
    const client = notion(nt.fn);
    const first = await pushLeadToNotion(client, syncLead(), nctx);
    const out = await pushLeadToNotion(client, syncLead({ score: 90 }), nctx);
    expect(out.pageId).toBe(first.pageId);
    expect(nt.pages.size).toBe(1);
    const query = nt.calls.find((c) => c.path.endsWith("/query"))!;
    expect(query.body.filter).toEqual({ property: "Lead ID", rich_text: { equals: "lead_1" } });
  });

  test("a page deleted in Notion is recreated", async () => {
    const nt = fakeNotion();
    const client = notion(nt.fn);
    const first = await pushLeadToNotion(client, syncLead(), nctx);
    nt.pages.delete(first.pageId);
    const out = await pushLeadToNotion(client, syncLead({ stage: "sent", notion_page_id: first.pageId, notion_hash: first.hash }), nctx);
    expect(out.created).toBe(true);
    expect(out.pageId).not.toBe(first.pageId);
  });
});

// ---------- setup --crm ----------

function fakeHubSpotSchema(opts: { schemaScope?: boolean } = {}) {
  const props = { contacts: new Map<string, PropertyDefinition>(), companies: new Map<string, PropertyDefinition>() };
  const groups = { contacts: new Set<string>(), companies: new Set<string>() };
  props.contacts.set("hs_lead_status", {
    name: "hs_lead_status",
    label: "Lead Status",
    type: "enumeration",
    fieldType: "radio",
    groupName: "sales_properties",
    options: ["NEW", "OPEN", "IN_PROGRESS", "OPEN_DEAL", "UNQUALIFIED", "ATTEMPTED_TO_CONTACT", "CONNECTED"].map((value) => ({ label: value, value })),
  });
  const writes: string[] = [];
  const fn: FetchFn = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    const respond = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    const m = /^\/crm\/v3\/properties\/(contacts|companies)(?:\/(groups))?(?:\/([^/]+))?$/.exec(u.pathname);
    if (!m) return respond({ message: "unmocked" }, 404);
    const obj = m[1] as "contacts" | "companies";
    if (method !== "GET" && opts.schemaScope === false) {
      return respond({ category: "MISSING_SCOPES", message: "scopes", errors: [{ context: { requiredGranularScopes: [`crm.schemas.${obj}.write`] } }] }, 403);
    }
    if (m[2] === "groups") {
      if (method === "GET") return groups[obj].has(m[3]!) ? respond({ name: m[3], label: "Crusonia" }) : respond({ message: "not found" }, 404);
      groups[obj].add(body.name);
      writes.push(`group ${obj}`);
      return respond(body, 201);
    }
    const name = m[3] ? decodeURIComponent(m[3]) : undefined;
    if (method === "GET") return name && props[obj].has(name) ? respond(props[obj].get(name)) : respond({ message: "not found" }, 404);
    if (method === "POST") {
      props[obj].set(body.name, body);
      writes.push(`create ${obj}.${body.name}`);
      return respond(body, 201);
    }
    if (method === "PATCH" && name) {
      Object.assign(props[obj].get(name)!, body);
      writes.push(`update ${obj}.${name}`);
      return respond(props[obj].get(name));
    }
    return respond({ message: "unmocked" }, 404);
  };
  return { fn, props, groups, writes };
}

describe("setup --crm", () => {
  test("HubSpot: creates the group and properties once; a re-run changes nothing; new stages become new options", async () => {
    const hs = fakeHubSpotSchema();
    const client = hubspot(hs.fn);
    const first = await setupHubSpot(client);
    expect(hs.writes.filter((w) => w.startsWith("create")).length).toBe(HUBSPOT_PROPERTY_NAMES.length * 2);
    expect(hs.writes.filter((w) => w.startsWith("group")).length).toBe(2);
    expect(hs.props.contacts.get("crusonia_stage")!.groupName).toBe("crusonia");
    expect(hs.props.contacts.get("crusonia_last_outreach_at")).toMatchObject({ type: "datetime", fieldType: "date" });
    expect(first.notes).toEqual([]);

    hs.writes.length = 0;
    const second = await setupHubSpot(client);
    expect(hs.writes).toEqual([]);
    expect(second.done.every((d) => !d.includes("created"))).toBe(true);

    const stage = hs.props.contacts.get("crusonia_stage")!;
    stage.options = stage.options!.filter((o) => o.value !== "meeting_booked");
    await setupHubSpot(client);
    expect(hs.writes).toEqual(["update contacts.crusonia_stage"]);
    expect(hs.props.contacts.get("crusonia_stage")!.options!.some((o) => o.value === "meeting_booked")).toBe(true);
  });

  test("HubSpot: a token without the schema scopes gets a clear note, not a crash", async () => {
    const hs = fakeHubSpotSchema({ schemaScope: false });
    const report = await setupHubSpot(hubspot(hs.fn));
    expect(report.notes.some((n) => n.includes("crm.schemas.contacts.write"))).toBe(true);
    expect(report.notes.some((n) => n.includes("crm.schemas.companies.write"))).toBe(true);
  });

  test("HubSpot: reports hs_lead_status options the portal lacks", async () => {
    const hs = fakeHubSpotSchema();
    const status = hs.props.contacts.get("hs_lead_status")!;
    status.options = status.options!.filter((o) => o.value !== "OPEN_DEAL");
    const report = await setupHubSpot(hubspot(hs.fn));
    expect(report.notes.some((n) => n.includes("OPEN_DEAL"))).toBe(true);
  });

  test("Notion: needs a shared parent page; creates the database once; a re-run finds it by title", async () => {
    const nt = fakeNotion();
    const client = new NotionClient("ntn_test", nt.fn, { pace: fakePace() });
    const none = await setupNotion(client, {});
    expect(none.databaseId).toBeUndefined();
    expect(none.notes[0]).toContain("NOTION_PARENT_PAGE_ID");

    const created = await setupNotion(client, { parentPageId: "parent_1" });
    expect(created.created).toBe(true);
    const db = nt.databases.get(created.databaseId!)!;
    expect(db.title).toBe("Crusonia leads");
    expect(Object.keys(db.properties)).toEqual(Object.keys(notionSchema()));
    expect(db.properties.Company.type).toBe("title");

    const again = await setupNotion(client, { parentPageId: "parent_1" });
    expect(again).toMatchObject({ created: false, databaseId: created.databaseId });
    expect(nt.databases.size).toBe(1);
  });

  test("Notion: an existing database gets missing columns added, nothing removed", async () => {
    const nt = fakeNotion();
    const client = new NotionClient("ntn_test", nt.fn, { pace: fakePace() });
    const { databaseId } = await setupNotion(client, { parentPageId: "parent_1" });
    const db = nt.databases.get(databaseId!)!;
    delete db.properties.Signal;
    db.properties["Owner notes"] = { type: "rich_text", rich_text: {} };
    const report = await setupNotion(client, { databaseId });
    expect(report.done.join(" ")).toContain("added columns Signal");
    expect(db.properties.Signal).toBeDefined();
    expect(db.properties["Owner notes"]).toBeDefined();
  });
});

// ---------- routes (no database) ----------

describe("integration routes without a database", () => {
  const env = (over: Partial<Env> = {}): Env => ({ PUBLIC_URL: "https://example.test", MCP_TOKEN: "owner-token", ...over });
  const call = (path: string, init: RequestInit, e: Env) =>
    worker.fetch(new Request(`https://example.test${path}`, { ...init, headers: { Authorization: "Bearer owner-token", "content-type": "application/json" } }), e, {} as ExecutionContext);
  const code = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

  test("need auth", async () => {
    const res = await worker.fetch(new Request("https://example.test/api/integrations/crm"), env(), {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  test("status works without a database: everything off by default", async () => {
    const res = await call("/api/integrations/crm", {}, env({ HUBSPOT_ACCESS_TOKEN: "pat" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.hubspot).toMatchObject({ enabled: false, configured: true, active: false, scope: "qualified", consent_property: null, queue: null });
    expect(body.notion).toMatchObject({ enabled: false, configured: false, missing: ["NOTION_API_TOKEN", "NOTION_LEADS_DATABASE_ID"] });
  });

  test("manual sync: 503 without keys, 409 while the switch is off, 400 on a bad target; all before the database", async () => {
    let res = await call("/api/integrations/sync", { method: "POST", body: JSON.stringify({ target: "hubspot" }) }, env());
    expect(res.status).toBe(503);
    expect((await code(res)).code).toBe("not_configured");
    res = await call("/api/integrations/sync", { method: "POST", body: JSON.stringify({ target: "hubspot" }) }, env({ HUBSPOT_ACCESS_TOKEN: "pat" }));
    expect(res.status).toBe(409);
    const err = await code(res);
    expect(err.code).toBe("sync_disabled");
    expect(err.message).toContain("HUBSPOT_SYNC_ENABLED=true");
    res = await call("/api/integrations/sync", { method: "POST", body: JSON.stringify({ target: "salesforce" }) }, env());
    expect(res.status).toBe(400);
    // Switch on: past the checks, then the missing database answers.
    res = await call("/api/integrations/sync", { method: "POST", body: JSON.stringify({ target: "hubspot", lead_ids: ["lead_1"] }) }, env({ HUBSPOT_ACCESS_TOKEN: "pat", HUBSPOT_SYNC_ENABLED: "true" }));
    expect(res.status).toBe(503);
    expect((await code(res)).message).toContain("DATABASE_URL");
  });

  test("import needs only the token (read-only on HubSpot), not the switch", async () => {
    let res = await call("/api/integrations/hubspot/import", { method: "POST", body: "{}" }, env());
    expect(res.status).toBe(503);
    expect((await code(res)).message).toContain("HUBSPOT_ACCESS_TOKEN");
    res = await call("/api/integrations/hubspot/import", { method: "POST", body: "{}" }, env({ HUBSPOT_ACCESS_TOKEN: "pat" }));
    expect((await code(res)).message).toContain("DATABASE_URL");
  });

  test("/api/status carries a crm_sync summary", async () => {
    const res = await call("/api/status", {}, env({ HUBSPOT_ACCESS_TOKEN: "pat", HUBSPOT_SYNC_ENABLED: "true" }));
    const body = (await res.json()) as any;
    expect(body.crm_sync.hubspot).toEqual({ enabled: true, configured: true, active: true, queue_depth: null, failed: null, last_sync_at: null, last_error: null });
    expect(body.crm_sync.notion.active).toBe(false);
  });
});
