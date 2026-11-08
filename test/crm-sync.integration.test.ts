// CRM sync against a real Postgres (a Neon dev branch, never production) with HubSpot and Notion faked at
// fetch (test/helpers/fake-crm.ts). Skipped unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=<dev branch url> bun test test/crm-sync.integration.test.ts
// Rows are marked with this run's id and deleted afterwards; the crm_sync settings are restored.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getSql, type Sql } from "../src/db.ts";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";
import type { FetchFn } from "../src/providers/http.ts";
import { createLead } from "../src/services/crm.ts";
import { runCrmSync, startHubSpotImport, enqueueManualSync } from "../src/services/crm-sync.ts";
import { addLeads, saveEvidence, scoreLead } from "../src/services/leads.ts";
import { fakeHubSpot, fakeNotion, fakePace } from "./helpers/fake-crm.ts";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const run = crypto.randomUUID().slice(0, 8);
const domain = (name: string) => `${name}-${run}.it-crm.example.com`;
const email = (name: string, d = "acme") => `${name}@${domain(d)}`;
let sql: Sql;
let started: string;
const saved = new Map<string, unknown>();
const SETTINGS = ["crm_sync_targets", "crm_sync:hubspot", "crm_sync:notion"];

const baseEnv = (over: Partial<Env> = {}): Env => ({
  PUBLIC_URL: "https://crusonia.example",
  HUBSPOT_ACCESS_TOKEN: "pat-test",
  HUBSPOT_SYNC_ENABLED: "true",
  NOTION_API_TOKEN: "ntn_test",
  NOTION_LEADS_DATABASE_ID: "db_test",
  NOTION_SYNC_ENABLED: "true",
  ...over,
});

/** Routes api.hubapi.com and api.notion.com to their fakes. */
function providers(hs = fakeHubSpot(), nt = fakeNotion()) {
  const fn: FetchFn = (u, init) => (u.startsWith("https://api.notion.com") ? nt.fn(u, init) : hs.fn(u, init));
  return { fn, hs, nt };
}

async function optedIn(name: string, d = name) {
  return createLead(sql, { email: email(name, d), name: `${name} Tester`, company: `Co ${name}`, website: `https://${domain(d)}`, source: "it_crm", consent: { text: "integration test opt-in" } }, "test");
}
const queueRows = (leadId: string) => sql`select target, entity, reason, version, attempts, status, last_error, next_attempt_at from crm_sync_queue where lead_id = ${leadId} order by target`;
const setTargets = (targets: string[]) =>
  sql`insert into settings (key, value) values ('crm_sync_targets', ${JSON.stringify(targets)}::jsonb) on conflict (key) do update set value = excluded.value`;

suite("CRM sync (database, faked HubSpot and Notion)", () => {
  beforeAll(async () => {
    sql = getSql(url);
    started = ((await sql`select now()::text as t`)[0]!.t as string);
    for (const r of await sql`select key, value from settings where key = any(${SETTINGS}::text[])`) saved.set(r.key as string, r.value);
    // A stale import job from an aborted run would make startHubSpotImport answer 409.
    await sql`delete from crm_sync_queue where entity = 'import'`;
  });

  afterAll(async () => {
    if (!sql) return;
    const ids = (await sql`select id from leads where source in ('it_crm', 'hubspot_import') and (email like ${`%${run}.it-crm.example.com`} or domain like ${`%${run}.it-crm.example.com`})`).map(
      (r) => r.id as string,
    );
    await sql.transaction([
      sql`delete from events where lead_id = any(${ids}::text[]) or (lead_id is null and data::text like ${`%${run}%`})`,
      sql`delete from leads where id = any(${ids}::text[])`,
      sql`delete from crm_sync_queue where entity = 'import' or (created_at >= ${started}::timestamptz and reason = 'manual')`,
      sql`delete from settings where key = any(${SETTINGS}::text[])`,
      ...[...saved].map(([k, v]) => sql`insert into settings (key, value) values (${k}, ${JSON.stringify(v)}::jsonb)`),
    ]);
    // Rows the trigger queued for other leads while this suite had the targets switched on.
    await sql`delete from crm_sync_queue where created_at >= ${started}::timestamptz and reason <> 'manual'
              and not (${[...saved.get("crm_sync_targets") as string[] ?? []]}::text[] @> array[target])`;
  });

  test("the events trigger: nothing while sync is off; one collapsed row per lead and target when on; import events skipped", async () => {
    await setTargets([]);
    const lead = await optedIn("trigger");
    expect(await queueRows(lead.id)).toHaveLength(0);

    await setTargets(["hubspot", "notion"]);
    await saveEvidence(sql, { lead_id: lead.id, claim: "Hiring SDRs", source_url: "https://example.com/jobs" });
    await scoreLead(sql, { lead_id: lead.id, score: 77, rationale: "Fits", qualified: true });
    const rows = await queueRows(lead.id);
    expect(rows.map((r) => [r.target, r.entity, r.reason, r.status])).toEqual([
      ["hubspot", "lead", "lead_scored", "pending"],
      ["notion", "lead", "lead_scored", "pending"],
    ]);
    expect(rows[0]!.version).toBe(2);

    const other = await optedIn("trigger-import");
    await sql`delete from crm_sync_queue where lead_id = ${other.id}`;
    await sql`insert into events (lead_id, kind, data) values (${other.id}, 'lead_updated', '{"via":"hubspot_import"}'::jsonb)`;
    expect(await queueRows(other.id)).toHaveLength(0);

    // Deleting a lead logs lead_deleted for a lead that no longer exists: no error, its rows cascade away.
    const gone = await optedIn("trigger-delete");
    await sql`with d as (delete from leads where id = ${gone.id} returning id)
              insert into events (lead_id, kind, data) select id, 'lead_deleted', '{}'::jsonb from d`;
    expect(await queueRows(gone.id)).toHaveLength(0);
    await setTargets([]);
  });

  test("the cron pushes to HubSpot and Notion, stores the external ids, and a second sync writes nothing", async () => {
    const lead = await optedIn("push");
    await saveEvidence(sql, { lead_id: lead.id, claim: "Hiring 3 SDRs", source_url: "https://example.com/jobs" });
    await saveEvidence(sql, { lead_id: lead.id, claim: "Hiring 3 SDRs", source_url: "https://example.com/jobs" });
    await saveEvidence(sql, { lead_id: lead.id, claim: "Raised a seed round", source_url: "https://example.com/news" });
    await scoreLead(sql, { lead_id: lead.id, score: 81, rationale: "Hiring SDRs. Fresh funding.", qualified: true });
    await sql`insert into messages (lead_id, direction, provider_message_id, thread_id, subject, body)
              values (${lead.id}, 'out', ${`<m-${run}@agentmail.to>`}, ${`thr_${run}`}, 'Hello', 'Hi there')`;
    const env = baseEnv();
    const p = providers();
    const updatedAt = (await sql`select updated_at from leads where id = ${lead.id}`)[0]!.updated_at;

    expect(await enqueueManualSync(sql, env, { target: "hubspot", lead_ids: [lead.id, "lead_missing"] })).toMatchObject({ queued: 1, unknown_lead_ids: ["lead_missing"] });
    await enqueueManualSync(sql, env, { target: "notion", lead_ids: [lead.id] });
    const report = (await runCrmSync(sql, env, p.fn, { leadIds: [lead.id], pace: fakePace() })) as any;
    expect(report.hubspot.leads).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    expect(report.notion.leads).toMatchObject({ claimed: 1, done: 1 });

    const [row] = await sql`select hubspot_id, hubspot_company_id, hubspot_state, hubspot_synced_at, notion_page_id, notion_hash, updated_at from leads where id = ${lead.id}`;
    expect(row!.hubspot_id).toBe(p.hs.byEmail(email("push", "push"))!.id);
    expect(row!.hubspot_company_id).toBe([...p.hs.companies.values()][0]!.id);
    expect(row!.hubspot_state).toEqual({ lead_status: "OPEN", assoc: `${row!.hubspot_id}:${row!.hubspot_company_id}` });
    expect(row!.notion_page_id).toBe([...p.nt.pages.keys()][0]!);
    expect(new Date(row!.updated_at).getTime()).toBe(new Date(updatedAt).getTime()); // sync never touches updated_at
    const contact = p.hs.byEmail(email("push", "push"))!.properties;
    expect(contact).toMatchObject({ crusonia_fit_score: "81", crusonia_stage: "qualified", crusonia_source: "it_crm", hs_lead_status: "OPEN" });
    const page = [...p.nt.pages.values()][0]!.properties;
    expect(page["Evidence count"]).toEqual({ number: 3 });
    expect(page["Crusonia link"]).toEqual({ url: `https://crusonia.example/leads/${lead.id}` });

    const notes = await sql`select hubspot_note_id from evidence where lead_id = ${lead.id} order by id`;
    expect(notes.every((n) => n.hubspot_note_id)).toBe(true);
    expect(notes[0]!.hubspot_note_id).toBe(notes[1]!.hubspot_note_id); // identical evidence shares one note
    expect((await sql`select hubspot_note_id from messages where lead_id = ${lead.id}`)[0]!.hubspot_note_id).toBeTruthy();
    expect(p.hs.notes.size).toBe(3);
    expect(await queueRows(lead.id)).toHaveLength(0);
    const status = (await sql`select value from settings where key = 'crm_sync:hubspot'`)[0]!.value as any;
    expect(status.last_success_at).toBeTruthy();
    expect(status.last_error).toBeNull();

    // Again: HubSpot is only read, Notion is not called at all.
    const hsWrites = p.hs.writes().length;
    const ntCalls = p.nt.calls.length;
    await enqueueManualSync(sql, env, { target: "hubspot", lead_ids: [lead.id] });
    await enqueueManualSync(sql, env, { target: "notion", lead_ids: [lead.id] });
    const again = (await runCrmSync(sql, env, p.fn, { leadIds: [lead.id], pace: fakePace() })) as any;
    expect(again.hubspot.leads).toMatchObject({ skipped: 1, failed: 0 });
    expect(p.hs.writes().length).toBe(hsWrites);
    expect(p.nt.calls.length).toBe(ntCalls);
    expect(p.hs.contacts.size).toBe(1);
    expect(p.nt.pages.size).toBe(1);
  });

  test("a 429 defers the item to Retry-After without counting an attempt; an outage retries with backoff", async () => {
    const lead = await optedIn("limits");
    const env = baseEnv({ NOTION_SYNC_ENABLED: "false" });
    const p = providers(fakeHubSpot({ rateLimit: { count: 5, retryAfter: "30" } }));
    await enqueueManualSync(sql, env, { target: "hubspot", lead_ids: [lead.id] });
    const report = (await runCrmSync(sql, env, p.fn, { leadIds: [lead.id], pace: fakePace() })) as any;
    expect(report.hubspot.leads).toMatchObject({ deferred: 1, retried: 0 });
    let [q] = await queueRows(lead.id);
    expect(q).toMatchObject({ status: "pending", attempts: 0 });
    const wait = new Date(q!.next_attempt_at).getTime() - Date.now();
    expect(wait).toBeGreaterThan(20_000);
    expect(wait).toBeLessThan(40_000);
    expect(((await sql`select value from settings where key = 'crm_sync:hubspot'`)[0]!.value as any).rate_limited_until).toBeTruthy();

    await sql`update crm_sync_queue set next_attempt_at = now() where lead_id = ${lead.id}`;
    const down: FetchFn = async () => new Response("bad gateway", { status: 502 });
    await runCrmSync(sql, env, down, { leadIds: [lead.id], pace: fakePace() });
    [q] = await queueRows(lead.id);
    expect(q).toMatchObject({ status: "pending", attempts: 1 });
    expect(q!.last_error).toContain("502");
    const backoff = new Date(q!.next_attempt_at).getTime() - Date.now();
    expect(backoff).toBeGreaterThan(30_000);
    expect(backoff).toBeLessThan(90_000);
  });

  test("queued leads outside the scope are dropped without calling HubSpot", async () => {
    const env = baseEnv({ NOTION_SYNC_ENABLED: "false" });
    await setTargets(["hubspot"]);
    const { results } = await addLeads(sql, [{ email: email("scraped"), name: "Scraped Person", source: "it_crm", source_url: "https://example.com/team" }]);
    const leadId = results[0]!.id!;
    expect(await queueRows(leadId)).toHaveLength(1);
    const p = providers();
    const report = (await runCrmSync(sql, env, p.fn, { leadIds: [leadId], pace: fakePace() })) as any;
    expect(report.hubspot.leads).toMatchObject({ claimed: 0, done: 0 });
    expect(await queueRows(leadId)).toHaveLength(0);
    expect(p.hs.calls).toHaveLength(0);
    await setTargets([]);
  });

  test("HubSpot import: contacts and companies become leads without consent, linked by id; research is never overwritten; re-runs add nothing", async () => {
    const hs = fakeHubSpot();
    const client = { create: (type: "contacts" | "companies", props: Record<string, string>) => hs.fn(`https://api.hubapi.com/crm/v3/objects/${type}`, { method: "POST", body: JSON.stringify({ properties: props }) }) };
    // Existing lead with research and a variant: the import may only fill blanks and link it.
    const existing = await optedIn("known", "known");
    await saveEvidence(sql, { lead_id: existing.id, claim: "Uses Clay", source_url: "https://example.com/clay" });
    await scoreLead(sql, { lead_id: existing.id, score: 64, rationale: "Decent fit", qualified: true });
    const before = (await sql`select * from leads where id = ${existing.id}`)[0]!;
    await client.create("contacts", { email: email("known", "known"), firstname: "Someone", lastname: "Else", jobtitle: "VP Sales", company: "Renamed Co" });
    await client.create("contacts", { email: email("fresh", "fresh"), firstname: "Fresh", lastname: "Contact", newsletter_opt_in: "yes" });
    await client.create("contacts", { email: "not-an-email", firstname: "Broken" });
    await client.create("companies", { name: "Imported Co", domain: domain("company") });

    // HubSpot sync on, so the trigger is live for this lead set: the import's own events must still queue nothing.
    const env = baseEnv({ NOTION_SYNC_ENABLED: "false" });
    await setTargets(["hubspot"]);
    const job = await startHubSpotImport(sql, env, "test");
    expect(job.job).toMatchObject({ phase: "contacts", consent_property: null });
    await expect(startHubSpotImport(sql, env, "test")).rejects.toMatchObject({ status: 409, code: "import_running" });

    for (let i = 0; i < 4; i++) await runCrmSync(sql, env, hs.fn, { leadIds: [], pace: fakePace() });
    expect((await sql`select count(*)::int as n from crm_sync_queue where entity = 'import'`)[0]!.n).toBe(0);
    const last = ((await sql`select value from settings where key = 'crm_sync:hubspot'`)[0]!.value as any).last_import;
    expect(last).toMatchObject({ phase: "companies", created: 2, skipped: 1 });

    const fresh = (await sql`select * from leads where email = ${email("fresh", "fresh")}`)[0]!;
    expect(fresh).toMatchObject({ source: "hubspot_import", stage: "no_consent", consent_at: null, name: "Fresh Contact" });
    expect(fresh.hubspot_id).toBe(hs.byEmail(email("fresh", "fresh"))!.id);
    const company = (await sql`select * from leads where domain = ${domain("company")} and email is null`)[0]!;
    expect(company).toMatchObject({ company: "Imported Co", name: null, stage: "no_consent", hubspot_company_id: [...hs.companies.keys()][0] });

    const after = (await sql`select * from leads where id = ${existing.id}`)[0]!;
    for (const k of ["name", "company", "score", "rationale", "qualified", "stage", "variant", "consent_at", "experiment_id", "source"]) {
      expect(after[k]).toEqual(before[k]);
    }
    expect(after.title).toBe("VP Sales"); // was blank
    expect(after.hubspot_id).toBe(hs.byEmail(email("known", "known"))!.id);
    expect((await sql`select count(*)::int as n from evidence where lead_id = ${existing.id}`)[0]!.n).toBe(1);
    // Import events do not queue pushes back to HubSpot.
    expect(await queueRows(fresh.id)).toHaveLength(0);

    await startHubSpotImport(sql, env, "test");
    for (let i = 0; i < 4; i++) await runCrmSync(sql, env, hs.fn, { leadIds: [], pace: fakePace() });
    const second = ((await sql`select value from settings where key = 'crm_sync:hubspot'`)[0]!.value as any).last_import;
    expect(second.created).toBe(0);
    expect((await sql`select count(*)::int as n from leads where email = ${email("fresh", "fresh")}`)[0]!.n).toBe(1);

    // With an opt-in property mapped, the contact that opted in gets consent (and only that one).
    await startHubSpotImport(sql, { ...env, HUBSPOT_CONSENT_PROPERTY: "newsletter_opt_in" }, "test");
    for (let i = 0; i < 4; i++) await runCrmSync(sql, { ...env, HUBSPOT_CONSENT_PROPERTY: "newsletter_opt_in" }, hs.fn, { leadIds: [], pace: fakePace() });
    const consented = (await sql`select stage, consent_text from leads where email = ${email("fresh", "fresh")}`)[0]!;
    expect(consented).toEqual({ stage: "new", consent_text: "HubSpot import: newsletter_opt_in=yes" });
    expect((await sql`select consent_text from leads where id = ${existing.id}`)[0]!.consent_text).toBe("integration test opt-in");
    await setTargets([]);
  });

  test("API: status shows the queue and the last sync; the import answers 202 then 409", async () => {
    const env = { ...baseEnv({ NOTION_SYNC_ENABLED: "false" }), DATABASE_URL: url, MCP_TOKEN: "owner-token" } as Env;
    const call = (path: string, init: RequestInit = {}) =>
      worker.fetch(new Request(`https://example.test${path}`, { ...init, headers: { Authorization: "Bearer owner-token", "content-type": "application/json" } }), env, {} as ExecutionContext);
    const lead = await optedIn("api");
    const queued = await call("/api/integrations/sync", { method: "POST", body: JSON.stringify({ target: "hubspot", lead_ids: [lead.id] }) });
    expect(queued.status).toBe(202);
    expect(await queued.json()).toMatchObject({ target: "hubspot", queued: 1 });
    // No lead_ids: every lead in the scope (this opted-in lead included; an agent-found one is not).
    const { results } = await addLeads(sql, [{ email: email("api-scraped"), source: "it_crm", source_url: "https://example.com/x" }]);
    const all = await call("/api/integrations/sync", { method: "POST", body: JSON.stringify({ target: "hubspot" }) });
    expect(all.status).toBe(202);
    expect(((await all.json()) as any).scope).toBe("qualified");
    expect((await queueRows(lead.id)).map((r) => r.reason)).toEqual(["manual"]);
    expect((await queueRows(results[0]!.id!)).filter((r) => r.reason === "manual")).toHaveLength(0);

    const res = await call("/api/integrations/crm");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.hubspot).toMatchObject({ enabled: true, configured: true, active: true });
    expect(body.hubspot.queue.pending).toBeGreaterThanOrEqual(1);
    expect(body.hubspot.last_success_at).toBeTruthy();
    expect(body.notion).toMatchObject({ enabled: false, active: false });

    const status = (await (await call("/api/status")).json()) as any;
    expect(status.crm_sync.hubspot.queue_depth).toBeGreaterThanOrEqual(1);

    const first = await call("/api/integrations/hubspot/import", { method: "POST", body: "{}" });
    expect(first.status).toBe(202);
    const second = await call("/api/integrations/hubspot/import", { method: "POST", body: "{}" });
    expect(second.status).toBe(409);
    const crm = (await (await call("/api/integrations/crm")).json()) as any;
    expect(crm.hubspot.import).toMatchObject({ status: "running", phase: "contacts" });
    await sql`delete from crm_sync_queue where entity = 'import'`;
  });
});
