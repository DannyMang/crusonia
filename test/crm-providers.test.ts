// HubSpot and Notion clients with mocked fetch: auth headers, paths, 404/409 handling, pacing and 429s.
import { describe, expect, test } from "bun:test";
import { parseRetryAfter, ProviderError, RateLimitError, safePath, Throttle, type FetchFn } from "../src/providers/http.ts";
import { conflictExistingId, HubSpotClient, missingScopes } from "../src/providers/hubspot.ts";
import { isGonePage, NOTION_VERSION, NotionClient } from "../src/providers/notion.ts";
import { fakePace } from "./helpers/fake-crm.ts";

type Call = { url: string; init: RequestInit };
function mockFetch(...answers: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn: FetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const hdr = (c: Call) => new Headers(c.init.headers as Record<string, string>);
const failure = (p: Promise<unknown>) => p.then(() => undefined as never, (e) => e as ProviderError);

describe("Retry-After and pacing", () => {
  test("Retry-After: seconds or an HTTP date; junk is ignored", () => {
    expect(parseRetryAfter("10")).toBe(10_000);
    expect(parseRetryAfter("1.5")).toBe(1_500);
    const now = Date.parse("2026-11-08T00:00:00Z");
    expect(parseRetryAfter("Sun, 08 Nov 2026 00:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Sat, 07 Nov 2026 23:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  test("the throttle spaces calls by the minimum interval", async () => {
    const pace = fakePace();
    const t = new Throttle(340, pace);
    await t.wait();
    await t.wait();
    await t.wait();
    expect(pace.slept).toEqual([340, 340]);
  });

  test("error messages never contain email addresses from the path", () => {
    expect(safePath("https://api.hubapi.com/crm/v3/objects/contacts/ada%40acme.com?idProperty=email")).toBe("/crm/v3/objects/contacts/:email");
  });
});

describe("HubSpotClient", () => {
  test("bearer token, JSON body, v3 paths; a contact by email uses idProperty", async () => {
    const { fn, calls } = mockFetch(json({ id: "51", properties: { email: "ada@acme.com" } }));
    const client = new HubSpotClient("pat-test", fn, { pace: fakePace() });
    const c = await client.getContact("ada@acme.com", ["email", "hs_lead_status"], { byEmail: true });
    expect(c?.id).toBe("51");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/crm/v3/objects/contacts/ada%40acme.com");
    expect(url.searchParams.get("idProperty")).toBe("email");
    expect(url.searchParams.get("properties")).toBe("email,hs_lead_status");
    expect(url.searchParams.has("associations")).toBe(false);
    expect(hdr(calls[0]!).get("authorization")).toBe("Bearer pat-test");
  });

  test("404 is null, not an error", async () => {
    const { fn } = mockFetch(json({ status: "error", message: "resource not found" }, 404));
    expect(await new HubSpotClient("t", fn, { pace: fakePace() }).getContact("1", ["email"])).toBeNull();
  });

  test("409 on create exposes the existing record id", async () => {
    const { fn } = mockFetch(json({ status: "error", message: "Contact already exists. Existing ID: 777", category: "CONFLICT" }, 409));
    const err = await failure(new HubSpotClient("t", fn, { pace: fakePace() }).createObject("contacts", { email: "a@x.com" }));
    expect(conflictExistingId(err)).toBe("777");
  });

  test("403 MISSING_SCOPES names the scopes", async () => {
    const { fn } = mockFetch(
      json({ status: "error", category: "MISSING_SCOPES", message: "scopes", errors: [{ context: { requiredGranularScopes: ["crm.objects.companies.read"] } }] }, 403),
    );
    const err = await failure(new HubSpotClient("t", fn, { pace: fakePace() }).findCompanyByDomain("acme.com", ["name"]));
    expect(missingScopes(err)).toEqual(["crm.objects.companies.read"]);
    expect(missingScopes(new ProviderError("hubspot", "x", 403, false, { category: "OTHER" }))).toEqual([]);
  });

  test("429 with a short Retry-After is waited out once, then the call succeeds", async () => {
    const pace = fakePace();
    const { fn, calls } = mockFetch(json({ errorType: "RATE_LIMIT" }, 429, { "Retry-After": "1" }), json({ id: "9", properties: {} }));
    const res = await new HubSpotClient("t", fn, { pace, minIntervalMs: 0 }).updateObject("contacts", "9", { crusonia_stage: "sent" });
    expect(res.id).toBe("9");
    expect(calls).toHaveLength(2);
    expect(pace.slept).toContain(1_000);
  });

  test("429 without Retry-After (HubSpot's usual) throws RateLimitError for its 10 s window", async () => {
    const { fn, calls } = mockFetch(json({ errorType: "RATE_LIMIT", policyName: "TEN_SECONDLY_ROLLING" }, 429));
    const err = await failure(new HubSpotClient("t", fn, { pace: fakePace() }).createNote({ body: "x", timestamp: "2026-11-08T00:00:00Z", contactId: "1" }));
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(10_000);
    expect(calls).toHaveLength(1);
  });

  test("a second 429 in a row is not waited out again", async () => {
    const pace = fakePace();
    const { fn } = mockFetch(json({}, 429, { "Retry-After": "1" }), json({}, 429, { "Retry-After": "1" }));
    const err = await failure(new HubSpotClient("t", fn, { pace, minIntervalMs: 0 }).getCompany("1", ["name"]));
    expect(err).toBeInstanceOf(RateLimitError);
  });

  test("notes are created with note->contact (202) and note->company (190) associations", async () => {
    const { fn, calls } = mockFetch(json({ id: "n1", properties: {} }, 201));
    await new HubSpotClient("t", fn, { pace: fakePace() }).createNote({ body: "<p>x</p>", timestamp: "2026-11-08T00:00:00.000Z", contactId: "51", companyId: "900" });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.properties).toEqual({ hs_timestamp: "2026-11-08T00:00:00.000Z", hs_note_body: "<p>x</p>" });
    expect(body.associations.map((a: any) => [a.to.id, a.types[0].associationTypeId])).toEqual([
      ["51", 202],
      ["900", 190],
    ]);
  });

  test("calls are paced at least 220 ms apart by default", async () => {
    const pace = fakePace();
    const { fn } = mockFetch(json({ results: [] }), json({ results: [] }), json({ results: [] }));
    const client = new HubSpotClient("t", fn, { pace });
    for (let i = 0; i < 3; i++) await client.findCompanyByDomain("acme.com", ["name"]);
    expect(pace.slept).toEqual([220, 220]);
  });
});

describe("NotionClient", () => {
  test("bearer token and the Notion-Version header; pages are created in the data source", async () => {
    const { fn, calls } = mockFetch(json({ object: "page", id: "p1" }));
    await new NotionClient("ntn_test", fn, { pace: fakePace() }).createPage("ds_1", { Company: { title: [] } });
    expect(calls[0]!.url).toBe("https://api.notion.com/v1/pages");
    expect(hdr(calls[0]!).get("authorization")).toBe("Bearer ntn_test");
    expect(hdr(calls[0]!).get("notion-version")).toBe(NOTION_VERSION);
    expect(JSON.parse(calls[0]!.init.body as string).parent).toEqual({ type: "data_source_id", data_source_id: "ds_1" });
  });

  test("about 3 requests per second", async () => {
    const pace = fakePace();
    const { fn } = mockFetch(...Array.from({ length: 4 }, () => json({ object: "list", results: [], has_more: false, next_cursor: null })));
    const client = new NotionClient("t", fn, { pace });
    for (let i = 0; i < 4; i++) await client.queryDataSource("ds_1", {});
    expect(pace.slept).toEqual([340, 340, 340]);
    expect(1000 / 340).toBeLessThanOrEqual(3);
  });

  test("429 honors Retry-After: short waits inline, long ones throw RateLimitError", async () => {
    const pace = fakePace();
    const ok = mockFetch(json({ object: "error", code: "rate_limited" }, 429, { "Retry-After": "2" }), json({ object: "page", id: "p1" }));
    await new NotionClient("t", ok.fn, { pace, minIntervalMs: 0 }).updatePage("p1", {});
    expect(pace.slept).toContain(2_000);
    const slow = mockFetch(json({ object: "error", code: "rate_limited" }, 429, { "Retry-After": "30" }));
    const err = await failure(new NotionClient("t", slow.fn, { pace }).updatePage("p1", {}));
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(30_000);
  });

  test("a deleted or trashed page counts as gone (recreate); other errors do not", async () => {
    const gone = await failure(new NotionClient("t", mockFetch(json({ object: "error", code: "object_not_found", message: "Could not find page" }, 404)).fn, { pace: fakePace() }).updatePage("p", {}));
    expect(isGonePage(gone)).toBe(true);
    const trashed = await failure(new NotionClient("t", mockFetch(json({ object: "error", code: "validation_error", message: "Can't edit block that is in trash." }, 400)).fn, { pace: fakePace() }).updatePage("p", {}));
    expect(isGonePage(trashed)).toBe(true);
    const invalid = await failure(new NotionClient("t", mockFetch(json({ object: "error", code: "validation_error", message: "Stage is not a property" }, 400)).fn, { pace: fakePace() }).updatePage("p", {}));
    expect(isGonePage(invalid)).toBe(false);
  });
});
