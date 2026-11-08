// Apify REST API: run a public Actor synchronously and return its dataset items.
// Docs: https://docs.apify.com/api/v2/act-run-sync-get-dataset-items-post (POST /v2/actors/{user~name}/run-sync-get-dataset-items)
// Input fields below were checked against each Actor's published input schema
// (GET https://api.apify.com/v2/acts/apify~<actor>/builds/default).
import { z } from "zod";
import { ServiceError } from "./errors.ts";

const APIFY_API = "https://api.apify.com/v2";

type RunOptions = {
  /** Actor run timeout in seconds. The sync endpoint itself gives up after 300 s (HTTP 408). */
  timeoutSecs: number;
  /** Top-level dataset fields to return (smaller responses). */
  fields?: string[];
};

export async function runActorSync<T>(token: string, actor: string, input: unknown, opts: RunOptions): Promise<T[]> {
  const url = new URL(`${APIFY_API}/actors/${actor.replace("/", "~")}/run-sync-get-dataset-items`);
  url.searchParams.set("timeout", String(opts.timeoutSecs));
  url.searchParams.set("format", "json");
  url.searchParams.set("clean", "true");
  if (opts.fields?.length) url.searchParams.set("fields", opts.fields.join(","));

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      // Token in the header, never in the URL (URLs end up in logs).
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout((opts.timeoutSecs + 30) * 1000),
    });
  } catch (err) {
    throw new ServiceError("upstream", `Apify ${actor} did not answer: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { type?: string; message?: string } };
      detail = [body.error?.type, body.error?.message].filter(Boolean).join(": ");
    } catch {
      detail = res.statusText;
    }
    const hint =
      res.status === 401 || res.status === 403
        ? " Check APIFY_TOKEN (console.apify.com > Settings > API & Integrations)."
        : res.status === 402
          ? " The Apify account is out of credit or over its usage limit."
          : res.status === 408
            ? " The run took too long; try fewer pages."
            : "";
    throw new ServiceError("upstream", `Apify ${actor} failed (HTTP ${res.status}${detail ? `, ${detail}` : ""}).${hint}`);
  }
  return (await res.json()) as T[];
}

// ---------- apify/website-content-crawler ----------

type CrawledPage = {
  url?: string;
  text?: string;
  metadata?: { title?: string | null; description?: string | null };
};

export type PageText = { url: string; title: string | null; description: string | null; text: string; truncated: boolean };

export function trimText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const clean = text.replace(/[ \t\f\v ]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return clean.length > maxChars ? { text: `${clean.slice(0, maxChars).trimEnd()} …`, truncated: true } : { text: clean, truncated: false };
}

export async function crawlWebsite(
  token: string,
  opts: { url: string; maxPages: number; renderJs: boolean; maxCharsPerPage: number },
): Promise<PageText[]> {
  const items = await runActorSync<CrawledPage>(
    token,
    "apify/website-content-crawler",
    {
      startUrls: [{ url: opts.url }],
      // cheerio = plain HTTP (fast, cheap); playwright:adaptive renders JavaScript when a page needs it.
      crawlerType: opts.renderJs ? "playwright:adaptive" : "cheerio",
      maxCrawlPages: opts.maxPages,
      maxResults: opts.maxPages,
      maxCrawlDepth: 1,
      saveMarkdown: false,
      removeCookieWarnings: true,
      requestTimeoutSecs: 30,
      maxRequestRetries: 1,
      proxyConfiguration: { useApifyProxy: true },
    },
    { timeoutSecs: opts.renderJs ? 150 : 90, fields: ["url", "metadata", "text"] },
  );
  return items
    .filter((item) => item.url && item.text)
    .map((item) => ({
      url: item.url!,
      title: item.metadata?.title ?? null,
      description: item.metadata?.description ?? null,
      ...trimText(item.text!, opts.maxCharsPerPage),
    }));
}

// ---------- apify/google-search-scraper ----------

export const searchInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(2)
    .max(500)
    .describe(
      "Google query. Operators work, e.g. 'site:linkedin.com/in \"head of sales\" fintech London' or '\"series A\" B2B SaaS 2026'.",
    ),
  max_results: z.number().int().min(1).max(30).default(10).describe("Organic results to return (1-30, default 10; ~10 per Google page)."),
  country_code: z
    .string()
    .regex(/^[a-z]{2}$/, "two lowercase letters, e.g. 'us'")
    .nullish()
    .describe("Search from this country (Google's gl parameter), e.g. 'us', 'gb', 'de'. Default: Apify's (US)."),
});
export type SearchInput = z.infer<typeof searchInputSchema>;

type SerpPage = {
  organicResults?: { title?: string; url?: string; description?: string; position?: number }[];
  relatedQueries?: { title?: string }[];
};

export type SearchResult = { position: number; title: string; url: string; description: string | null };

export async function searchGoogle(token: string, input: SearchInput): Promise<{ results: SearchResult[]; related_queries: string[] }> {
  const pages = await runActorSync<SerpPage>(
    token,
    "apify/google-search-scraper",
    {
      queries: input.query,
      maxPagesPerQuery: Math.ceil(input.max_results / 10),
      ...(input.country_code ? { countryCode: input.country_code } : {}),
      mobileResults: false,
      saveHtml: false,
      saveHtmlToKeyValueStore: false,
      includeIcons: false,
    },
    { timeoutSecs: 60, fields: ["organicResults", "relatedQueries"] },
  );
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const page of pages) {
    for (const r of page.organicResults ?? []) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      results.push({ position: results.length + 1, title: r.title ?? "", url: r.url, description: r.description ?? null });
    }
  }
  const related = pages.flatMap((p) => p.relatedQueries ?? []).map((q) => q.title).filter((t): t is string => Boolean(t));
  return { results: results.slice(0, input.max_results), related_queries: [...new Set(related)].slice(0, 10) };
}
