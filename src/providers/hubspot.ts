// Thin HubSpot CRM client (v3 object/property APIs, v4 default associations): only what CRM sync and
// `bun run setup --crm` need. Paced under HubSpot's limits (private apps: 100 requests / 10 s on Free and
// Starter, search: 5 / s); a 429 waits out a short Retry-After once, otherwise throws RateLimitError.
// https://developers.hubspot.com/docs/api-reference/legacy/crm (the v3 paths stay supported next to the
// date-versioned ones).
import { defaultFetch, pacedJson, ProviderError, realPace, Throttle, type FetchFn, type Pace } from "./http.ts";

export const HUBSPOT_BASE = "https://api.hubapi.com";

// HubSpot-defined association type ids (https://developers.hubspot.com/docs/api-reference/legacy/crm/associations).
export const ASSOC_CONTACT_TO_COMPANY = 279;
export const ASSOC_NOTE_TO_CONTACT = 202;
export const ASSOC_NOTE_TO_COMPANY = 190;

export type HubSpotObjectType = "contacts" | "companies";
export type HubSpotObject = {
  id: string;
  properties: Record<string, string | null | undefined>;
  associations?: Record<string, { results: { id: string; type?: string }[] }>;
  archived?: boolean;
};
export type HubSpotPage = { results: HubSpotObject[]; paging?: { next?: { after: string } } };

export type PropertyDefinition = {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  groupName: string;
  description?: string;
  options?: { label: string; value: string; displayOrder?: number; hidden?: boolean }[];
};

/** Scopes a 403 says are missing (HubSpot category MISSING_SCOPES), else []. */
export function missingScopes(err: unknown): string[] {
  if (!(err instanceof ProviderError) || err.provider !== "hubspot" || err.status !== 403) return [];
  const d = err.details as { category?: string; errors?: { context?: { requiredGranularScopes?: string[] } }[] } | undefined;
  if (d?.category !== "MISSING_SCOPES") return [];
  const scopes = (d.errors ?? []).flatMap((e) => e.context?.requiredGranularScopes ?? []);
  return scopes.length ? [...new Set(scopes)] : ["(unspecified)"];
}

/** The existing record id from a 409 "Contact already exists. Existing ID: 123". */
export function conflictExistingId(err: unknown): string | undefined {
  if (!(err instanceof ProviderError) || err.status !== 409) return undefined;
  const message = (err.details as { message?: string } | undefined)?.message ?? err.message;
  return /Existing ID:\s*(\d+)/i.exec(message)?.[1];
}

export const isNotFound = (err: unknown) => err instanceof ProviderError && err.status === 404;

export type HubSpotClientOptions = {
  pace?: Pace;
  /** Gap between calls; 220 ms keeps every endpoint (search included) under its limit. */
  minIntervalMs?: number;
  maxInlineWaitMs?: number;
  baseUrl?: string;
};

export class HubSpotClient {
  private readonly policy;
  private readonly baseUrl: string;

  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchFn = defaultFetch,
    opts: HubSpotClientOptions = {},
  ) {
    const pace = opts.pace ?? realPace;
    this.policy = {
      pace,
      throttle: new Throttle(opts.minIntervalMs ?? 220, pace),
      maxInlineWaitMs: opts.maxInlineWaitMs ?? 2_000,
      // HubSpot's burst window is 10 s and 429s usually carry no Retry-After.
      defaultRetryAfterMs: 10_000,
    };
    this.baseUrl = opts.baseUrl ?? HUBSPOT_BASE;
  }

  /** Number of HTTP calls made (the sync reports it; Workers count subrequests). */
  calls = 0;

  request<T>(method: "GET" | "POST" | "PATCH" | "PUT", path: string, body?: unknown): Promise<T> {
    this.calls++;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return pacedJson<T>("hubspot", this.fetchFn, { method, url: `${this.baseUrl}${path}`, headers, body }, this.policy);
  }

  private async getOrNull<T>(path: string): Promise<T | null> {
    try {
      return await this.request<T>("GET", path);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  // ---------- contacts and companies ----------

  /**
   * A contact by record id, or by email with `byEmail`. Null when HubSpot has no such (unarchived) contact.
   * `withCompanies` also returns associated company ids (needs a companies read scope).
   */
  getContact(idOrEmail: string, properties: string[], opts: { byEmail?: boolean; withCompanies?: boolean } = {}): Promise<HubSpotObject | null> {
    const qs = new URLSearchParams({ properties: properties.join(",") });
    if (opts.withCompanies) qs.set("associations", "companies");
    if (opts.byEmail) qs.set("idProperty", "email");
    return this.getOrNull<HubSpotObject>(`/crm/v3/objects/contacts/${encodeURIComponent(idOrEmail)}?${qs}`);
  }

  getCompany(id: string, properties: string[]): Promise<HubSpotObject | null> {
    const qs = new URLSearchParams({ properties: properties.join(",") });
    return this.getOrNull<HubSpotObject>(`/crm/v3/objects/companies/${encodeURIComponent(id)}?${qs}`);
  }

  /** Oldest company with this exact domain (HubSpot does not enforce unique domains). */
  async findCompanyByDomain(domain: string, properties: string[]): Promise<HubSpotObject | null> {
    const res = await this.request<{ results?: HubSpotObject[] }>("POST", "/crm/v3/objects/companies/search", {
      filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: domain }] }],
      properties,
      sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
      limit: 1,
    });
    return res.results?.[0] ?? null;
  }

  createObject(objectType: HubSpotObjectType, properties: Record<string, string>, associations: { to: string; typeId: number }[] = []) {
    return this.request<HubSpotObject>("POST", `/crm/v3/objects/${objectType}`, {
      properties,
      ...(associations.length
        ? { associations: associations.map((a) => ({ to: { id: a.to }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: a.typeId }] })) }
        : {}),
    });
  }

  updateObject(objectType: HubSpotObjectType, id: string, properties: Record<string, string>) {
    return this.request<HubSpotObject>("PATCH", `/crm/v3/objects/${objectType}/${encodeURIComponent(id)}`, { properties });
  }

  /** Default (unlabeled) contact -> company association. Idempotent. */
  associateContactToCompany(contactId: string, companyId: string) {
    return this.request<unknown>(
      "PUT",
      `/crm/v4/objects/contact/${encodeURIComponent(contactId)}/associations/default/company/${encodeURIComponent(companyId)}`,
    );
  }

  /** Paginated listing (import). `after` is the cursor from the previous page. */
  listObjects(objectType: HubSpotObjectType, opts: { properties: string[]; after?: string; limit?: number; associations?: string[] }) {
    const qs = new URLSearchParams({ limit: String(opts.limit ?? 100), properties: opts.properties.join(","), archived: "false" });
    if (opts.after) qs.set("after", opts.after);
    if (opts.associations?.length) qs.set("associations", opts.associations.join(","));
    return this.request<HubSpotPage>("GET", `/crm/v3/objects/${objectType}?${qs}`);
  }

  // ---------- notes ----------

  createNote(input: { body: string; timestamp: string; contactId?: string | null; companyId?: string | null }) {
    const associations = [
      ...(input.contactId ? [{ to: input.contactId, typeId: ASSOC_NOTE_TO_CONTACT }] : []),
      ...(input.companyId ? [{ to: input.companyId, typeId: ASSOC_NOTE_TO_COMPANY }] : []),
    ];
    return this.request<HubSpotObject>("POST", "/crm/v3/objects/notes", {
      properties: { hs_timestamp: input.timestamp, hs_note_body: input.body },
      associations: associations.map((a) => ({ to: { id: a.to }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: a.typeId }] })),
    });
  }

  /** Bodies of the notes on a record (newest first, up to maxPages x 100), to find notes we already created. */
  async noteBodies(on: "contact" | "company", id: string, maxPages = 3): Promise<{ id: string; body: string }[]> {
    const out: { id: string; body: string }[] = [];
    let after: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.request<HubSpotPage & { paging?: { next?: { after: string } } }>("POST", "/crm/v3/objects/notes/search", {
        filterGroups: [{ filters: [{ propertyName: `associations.${on}`, operator: "EQ", value: id }] }],
        properties: ["hs_note_body"],
        sorts: [{ propertyName: "hs_timestamp", direction: "DESCENDING" }],
        limit: 100,
        ...(after ? { after } : {}),
      });
      for (const r of res.results ?? []) out.push({ id: r.id, body: r.properties.hs_note_body ?? "" });
      after = res.paging?.next?.after;
      if (!after) break;
    }
    return out;
  }

  // ---------- properties (schema) ----------

  /** Which of `names` exist on the object (batch read; missing names are simply absent). */
  async existingProperties(objectType: HubSpotObjectType, names: string[]): Promise<Set<string>> {
    const res = await this.request<{ results?: { name: string }[] }>("POST", `/crm/v3/properties/${objectType}/batch/read`, {
      archived: false,
      inputs: names.map((name) => ({ name })),
    });
    return new Set((res.results ?? []).map((p) => p.name));
  }

  getProperty(objectType: HubSpotObjectType, name: string) {
    return this.getOrNull<PropertyDefinition>(`/crm/v3/properties/${objectType}/${encodeURIComponent(name)}`);
  }

  createProperty(objectType: HubSpotObjectType, def: PropertyDefinition) {
    return this.request<PropertyDefinition>("POST", `/crm/v3/properties/${objectType}`, def);
  }

  updateProperty(objectType: HubSpotObjectType, name: string, patch: Partial<PropertyDefinition>) {
    return this.request<PropertyDefinition>("PATCH", `/crm/v3/properties/${objectType}/${encodeURIComponent(name)}`, patch);
  }

  getPropertyGroup(objectType: HubSpotObjectType, name: string) {
    return this.getOrNull<{ name: string; label: string }>(`/crm/v3/properties/${objectType}/groups/${encodeURIComponent(name)}`);
  }

  createPropertyGroup(objectType: HubSpotObjectType, group: { name: string; label: string; displayOrder?: number }) {
    return this.request<{ name: string }>("POST", `/crm/v3/properties/${objectType}/groups`, group);
  }
}
