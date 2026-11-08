// Thin Notion client (API version 2026-03-11: databases hold data sources; pages are created in and queried
// from a data source). Only what CRM sync and `bun run setup --crm` need. Notion allows about 3 requests per
// second per integration, so calls are spaced 340 ms apart; a 429 honors Retry-After.
// https://developers.notion.com/reference
import { defaultFetch, pacedJson, ProviderError, realPace, Throttle, type FetchFn, type Pace } from "./http.ts";

export const NOTION_BASE = "https://api.notion.com";
export const NOTION_VERSION = "2026-03-11";

export type NotionDatabase = { id: string; data_sources?: { id: string; name?: string }[]; in_trash?: boolean; url?: string };
export type NotionDataSource = { id: string; properties: Record<string, { id: string; type: string; name?: string }> };
export type NotionPage = { id: string; in_trash?: boolean; url?: string };
export type NotionBlock = { id: string; type: string; child_database?: { title: string } };
export type NotionList<T> = { results: T[]; has_more: boolean; next_cursor: string | null };

export const notionCode = (err: unknown): string | undefined =>
  err instanceof ProviderError && err.provider === "notion" ? (err.details as { code?: string } | undefined)?.code : undefined;

/** The page is gone for us: deleted, trashed, or no longer shared with the integration. */
export function isGonePage(err: unknown): boolean {
  if (!(err instanceof ProviderError) || err.provider !== "notion") return false;
  if (err.status === 404) return true;
  return err.status === 400 && /trash|archiv/i.test(err.message);
}

export type NotionClientOptions = { pace?: Pace; minIntervalMs?: number; maxInlineWaitMs?: number; baseUrl?: string };

export class NotionClient {
  private readonly policy;
  private readonly baseUrl: string;
  calls = 0;

  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchFn = defaultFetch,
    opts: NotionClientOptions = {},
  ) {
    const pace = opts.pace ?? realPace;
    this.policy = {
      pace,
      throttle: new Throttle(opts.minIntervalMs ?? 340, pace),
      maxInlineWaitMs: opts.maxInlineWaitMs ?? 2_000,
      defaultRetryAfterMs: 1_000,
    };
    this.baseUrl = opts.baseUrl ?? NOTION_BASE;
  }

  request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    this.calls++;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, "Notion-Version": NOTION_VERSION };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return pacedJson<T>("notion", this.fetchFn, { method, url: `${this.baseUrl}${path}`, headers, body }, this.policy);
  }

  retrieveDatabase(id: string) {
    return this.request<NotionDatabase>("GET", `/v1/databases/${encodeURIComponent(id)}`);
  }

  createDatabase(input: { parentPageId: string; title: string; properties: Record<string, unknown> }) {
    return this.request<NotionDatabase>("POST", "/v1/databases", {
      parent: { type: "page_id", page_id: input.parentPageId },
      title: [{ type: "text", text: { content: input.title } }],
      initial_data_source: { properties: input.properties },
    });
  }

  retrieveDataSource(id: string) {
    return this.request<NotionDataSource>("GET", `/v1/data_sources/${encodeURIComponent(id)}`);
  }

  updateDataSource(id: string, properties: Record<string, unknown>) {
    return this.request<NotionDataSource>("PATCH", `/v1/data_sources/${encodeURIComponent(id)}`, { properties });
  }

  queryDataSource(id: string, body: { filter?: unknown; page_size?: number; start_cursor?: string }) {
    return this.request<NotionList<NotionPage>>("POST", `/v1/data_sources/${encodeURIComponent(id)}/query`, body);
  }

  listBlockChildren(blockId: string, cursor?: string) {
    const qs = new URLSearchParams({ page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) });
    return this.request<NotionList<NotionBlock>>("GET", `/v1/blocks/${encodeURIComponent(blockId)}/children?${qs}`);
  }

  createPage(dataSourceId: string, properties: Record<string, unknown>) {
    return this.request<NotionPage>("POST", "/v1/pages", { parent: { type: "data_source_id", data_source_id: dataSourceId }, properties });
  }

  updatePage(pageId: string, properties: Record<string, unknown>) {
    return this.request<NotionPage>("PATCH", `/v1/pages/${encodeURIComponent(pageId)}`, { properties });
  }
}
