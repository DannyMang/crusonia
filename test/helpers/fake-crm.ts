// In-memory fakes of the HubSpot and Notion endpoints CRM sync uses, served through a fetch double. Stateful,
// so tests can assert idempotency (a second sync writes nothing) and recovery (notes found by their ref).
import type { FetchFn, Pace } from "../../src/providers/http.ts";
import type { SyncLead } from "../../src/services/crm-fields.ts";

export type Call = { method: string; path: string; query: URLSearchParams; body: any; headers: Headers };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Virtual clock: sleeps advance time instantly and are recorded. */
export function fakePace(start = 1_700_000_000_000): Pace & { slept: number[]; t: () => number } {
  let t = start;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    slept,
    t: () => t,
  };
}

type Obj = { id: string; properties: Record<string, string | null>; companies: Set<string> };

export type FakeHubSpotOptions = {
  /** Token has crm.objects.companies.* (default true). */
  companiesScope?: boolean;
  /** The crusonia_* properties exist (default true). */
  customProperties?: boolean;
  /** Answer the next N requests with 429 (Retry-After seconds). */
  rateLimit?: { count: number; retryAfter?: string };
};

const CUSTOM = ["crusonia_fit_score", "crusonia_fit_rationale", "crusonia_stage", "crusonia_last_outreach_at", "crusonia_source", "crusonia_lead_id"];

export function fakeHubSpot(opts: FakeHubSpotOptions = {}) {
  const companiesScope = opts.companiesScope ?? true;
  const custom = opts.customProperties ?? true;
  const contacts = new Map<string, Obj>();
  const companies = new Map<string, Obj>();
  const notes = new Map<string, { body: string; timestamp: string; contact?: string; company?: string }>();
  const calls: Call[] = [];
  let nextId = 1000;
  let limited = opts.rateLimit ? { ...opts.rateLimit } : undefined;
  const id = () => String(nextId++);

  const missingScope = () =>
    json(
      {
        status: "error",
        message: "This app hasn't been granted all required scopes to make this call.",
        category: "MISSING_SCOPES",
        errors: [{ message: "One or more of the following scopes are required.", context: { requiredGranularScopes: ["crm.objects.companies.read"] } }],
      },
      403,
    );
  const notFound = () => json({ status: "error", message: "resource not found", category: "OBJECT_NOT_FOUND" }, 404);
  const view = (o: Obj, wanted: string[] | null, withCompanies: boolean) => ({
    id: o.id,
    properties: Object.fromEntries((wanted ?? Object.keys(o.properties)).map((k) => [k, o.properties[k] ?? null])),
    ...(withCompanies ? { associations: { companies: { results: [...o.companies].map((c) => ({ id: c, type: "contact_to_company" })) } } } : {}),
  });
  const propsOf = (q: URLSearchParams) => (q.get("properties") ? q.get("properties")!.split(",") : null);
  const byEmail = (email: string) => [...contacts.values()].find((c) => c.properties.email?.toLowerCase() === email.toLowerCase());

  const fn: FetchFn = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    const headers = new Headers(init.headers as Record<string, string>);
    calls.push({ method, path: u.pathname, query: u.searchParams, body, headers });
    if (limited && limited.count > 0) {
      limited.count--;
      return json({ status: "error", message: "You have reached your ten_secondly_rolling limit.", errorType: "RATE_LIMIT" }, 429, limited.retryAfter ? { "Retry-After": limited.retryAfter } : {});
    }
    const p = u.pathname;
    const q = u.searchParams;
    const touchesCompanies =
      /companies|\/company\//.test(p) ||
      q.get("associations")?.includes("companies") ||
      (body?.associations ?? []).some((a: any) => [279, 190].includes(a.types?.[0]?.associationTypeId));
    if (!companiesScope && touchesCompanies && !/properties\/contacts/.test(p)) return missingScope();

    let m: RegExpExecArray | null;
    if ((m = /^\/crm\/v3\/properties\/(contacts|companies)\/batch\/read$/.exec(p))) {
      const names: string[] = body.inputs.map((i: { name: string }) => i.name);
      return json({ results: custom ? names.filter((n) => CUSTOM.includes(n)).map((name) => ({ name })) : [] });
    }
    if ((m = /^\/crm\/v3\/objects\/(contacts|companies)$/.exec(p))) {
      const store = m[1] === "contacts" ? contacts : companies;
      if (method === "GET") {
        const all = [...store.values()].sort((a, b) => Number(a.id) - Number(b.id));
        const start = q.get("after") ? Number(q.get("after")) : 0;
        const limit = Number(q.get("limit") ?? 100);
        const page = all.slice(start, start + limit);
        return json({
          results: page.map((o) => view(o, propsOf(q), q.get("associations") === "companies")),
          ...(start + limit < all.length ? { paging: { next: { after: String(start + limit) } } } : {}),
        });
      }
      if (method === "POST") {
        if (m[1] === "contacts" && body.properties.email && byEmail(body.properties.email)) {
          return json({ status: "error", message: `Contact already exists. Existing ID: ${byEmail(body.properties.email)!.id}`, category: "CONFLICT" }, 409);
        }
        const o: Obj = { id: id(), properties: { ...body.properties }, companies: new Set() };
        for (const a of body.associations ?? []) o.companies.add(String(a.to.id));
        store.set(o.id, o);
        return json(view(o, null, false), 201);
      }
    }
    if ((m = /^\/crm\/v3\/objects\/(contacts|companies)\/([^/]+)$/.exec(p)) && m[2] !== "search") {
      const store = m[1] === "contacts" ? contacts : companies;
      const key = decodeURIComponent(m[2]!);
      const o = q.get("idProperty") === "email" ? byEmail(key) : store.get(key);
      if (!o) return notFound();
      if (method === "GET") return json(view(o, propsOf(q), q.get("associations") === "companies"));
      if (method === "PATCH") {
        Object.assign(o.properties, body.properties);
        return json(view(o, null, false));
      }
    }
    if (p === "/crm/v3/objects/companies/search") {
      const domain = body.filterGroups[0].filters[0].value;
      const hit = [...companies.values()].filter((c) => c.properties.domain === domain).sort((a, b) => Number(a.id) - Number(b.id))[0];
      return json({ total: hit ? 1 : 0, results: hit ? [view(hit, body.properties, false)] : [] });
    }
    if ((m = /^\/crm\/v4\/objects\/contact\/([^/]+)\/associations\/default\/company\/([^/]+)$/.exec(p)) && method === "PUT") {
      contacts.get(m[1]!)?.companies.add(m[2]!);
      return json({ status: "COMPLETE", results: [] });
    }
    if (p === "/crm/v3/objects/notes" && method === "POST") {
      const noteId = id();
      const note: { body: string; timestamp: string; contact?: string; company?: string } = {
        body: body.properties.hs_note_body,
        timestamp: body.properties.hs_timestamp,
      };
      for (const a of body.associations ?? []) {
        if (a.types[0].associationTypeId === 202) note.contact = String(a.to.id);
        if (a.types[0].associationTypeId === 190) note.company = String(a.to.id);
      }
      notes.set(noteId, note);
      return json({ id: noteId, properties: body.properties }, 201);
    }
    if (p === "/crm/v3/objects/notes/search") {
      const f = body.filterGroups[0].filters[0];
      const on = f.propertyName === "associations.contact" ? "contact" : "company";
      const hits = [...notes].filter(([, n]) => n[on] === String(f.value));
      return json({ total: hits.length, results: hits.map(([nid, n]) => ({ id: nid, properties: { hs_note_body: n.body } })) });
    }
    return json({ status: "error", message: `unmocked ${method} ${p}` }, 404);
  };

  const writes = () => calls.filter((c) => c.method !== "GET" && !c.path.endsWith("/search") && !c.path.endsWith("/batch/read"));
  return { fn, calls, contacts, companies, notes, writes, byEmail, setRateLimit: (r: FakeHubSpotOptions["rateLimit"]) => (limited = r ? { ...r } : undefined) };
}

type Page = { id: string; properties: Record<string, any>; in_trash?: boolean };

export function fakeNotion(opts: { dataSourceId?: string; rateLimit?: { count: number; retryAfter?: string } } = {}) {
  const dataSourceId = opts.dataSourceId ?? "ds_1";
  const pages = new Map<string, Page>();
  const databases = new Map<string, { id: string; parent: string; title: string; dataSource: string; properties: Record<string, any> }>();
  const children = new Map<string, { id: string; type: string; child_database?: { title: string } }[]>();
  const calls: Call[] = [];
  let nextId = 1;
  let limited = opts.rateLimit ? { ...opts.rateLimit } : undefined;
  const leadIdOf = (pg: Page) => pg.properties["Lead ID"]?.rich_text?.[0]?.text?.content;

  const fn: FetchFn = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    const headers = new Headers(init.headers as Record<string, string>);
    calls.push({ method, path: u.pathname, query: u.searchParams, body, headers });
    if (limited && limited.count > 0) {
      limited.count--;
      return json({ object: "error", status: 429, code: "rate_limited", message: "Rate limited" }, 429, limited.retryAfter ? { "Retry-After": limited.retryAfter } : {});
    }
    const p = u.pathname;
    let m: RegExpExecArray | null;
    if ((m = /^\/v1\/databases\/([^/]+)$/.exec(p)) && method === "GET") {
      const db = databases.get(m[1]!);
      return json({ object: "database", id: m[1], data_sources: [{ id: db?.dataSource ?? dataSourceId, name: "Crusonia leads" }] });
    }
    if (p === "/v1/databases" && method === "POST") {
      const dbId = `db_${nextId++}`;
      const ds = `ds_${nextId++}`;
      const parent = body.parent.page_id;
      databases.set(dbId, { id: dbId, parent, title: body.title[0].text.content, dataSource: ds, properties: body.initial_data_source.properties });
      children.set(parent, [...(children.get(parent) ?? []), { id: dbId, type: "child_database", child_database: { title: body.title[0].text.content } }]);
      return json({ object: "database", id: dbId, data_sources: [{ id: ds }] });
    }
    if ((m = /^\/v1\/blocks\/([^/]+)\/children$/.exec(p))) {
      return json({ object: "list", results: children.get(m[1]!) ?? [], has_more: false, next_cursor: null });
    }
    if ((m = /^\/v1\/data_sources\/([^/]+)$/.exec(p))) {
      const db = [...databases.values()].find((d) => d.dataSource === m![1]);
      if (method === "PATCH" && db) Object.assign(db.properties, body.properties);
      const props = Object.fromEntries(Object.entries(db?.properties ?? {}).map(([k, v]: [string, any]) => [k, { id: k, type: v.type }]));
      return json({ object: "data_source", id: m[1], properties: props });
    }
    if ((m = /^\/v1\/data_sources\/([^/]+)\/query$/.exec(p))) {
      const want = body.filter?.rich_text?.equals;
      const hits = [...pages.values()].filter((pg) => !want || leadIdOf(pg) === want);
      return json({ object: "list", results: hits.map((pg) => ({ object: "page", id: pg.id, in_trash: Boolean(pg.in_trash) })), has_more: false, next_cursor: null });
    }
    if (p === "/v1/pages" && method === "POST") {
      const pg = { id: `page_${nextId++}`, properties: body.properties };
      pages.set(pg.id, pg);
      return json({ object: "page", ...pg });
    }
    if ((m = /^\/v1\/pages\/([^/]+)$/.exec(p)) && method === "PATCH") {
      const pg = pages.get(m[1]!);
      if (!pg) return json({ object: "error", status: 404, code: "object_not_found", message: "Could not find page" }, 404);
      if (pg.in_trash) return json({ object: "error", status: 400, code: "validation_error", message: "Can't edit block that is in trash." }, 400);
      Object.assign(pg.properties, body.properties);
      return json({ object: "page", id: pg.id });
    }
    return json({ object: "error", status: 404, code: "object_not_found", message: `unmocked ${method} ${p}` }, 404);
  };
  return { fn, calls, pages, databases, children, leadIdOf, writes: () => calls.filter((c) => c.method !== "GET" && !c.path.endsWith("/query")) };
}

/** A lead as the sync reads it (an opted-out, qualified agent-found lead at Acme by default). */
export function syncLead(over: Partial<SyncLead> = {}): SyncLead {
  return {
    id: "lead_1",
    email: "ada@acme.com",
    name: "Ada Lovelace",
    title: "CTO",
    company: "Acme",
    domain: "acme.com",
    website: "https://acme.com",
    source: "google_search",
    stage: "qualified",
    score: 82,
    qualified: true,
    rationale: "Hiring SDRs. Just raised a Series A.",
    hubspot_id: null,
    consent_at: null,
    hubspot_company_id: null,
    hubspot_state: {},
    notion_page_id: null,
    notion_hash: null,
    last_outreach_at: null,
    last_activity_at: "2026-11-07T10:00:00.000Z",
    evidence_count: 2,
    signal: "Hiring 3 SDRs (job post)",
    ...over,
  };
}
