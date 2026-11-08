// Apify REST API: start a public Actor run, wait for it, and read its dataset.
// Docs: https://docs.apify.com/api/v2/act-runs-post (POST /v2/acts/{user~name}/runs?waitForFinish=60),
// GET /v2/actor-runs/{id}?waitForFinish=60, GET /v2/datasets/{id}/items. An async run (not run-sync) gives us the
// run object: its id and usageTotalUsd, which src/billing/usage.ts records and debits as credits.
// Every run carries maxTotalChargeUsd (APIFY_MAX_CHARGE_USD, default $0.25): Apify never charges a run above it.
// Input fields below were checked against each Actor's published input schema
// (GET https://api.apify.com/v2/acts/apify~<actor>/builds/default).
import { z } from "zod";
import type { Env } from "../env.ts";
import { defaultFetch, type FetchFn } from "../providers/http.ts";
import { ServiceError } from "./errors.ts";

const APIFY_API = "https://api.apify.com/v2";

/** Default cap per Actor run in USD. A 5-page crawl or one search page costs well under a cent. */
export const DEFAULT_MAX_CHARGE_USD = 0.25;
/** Apify refuses a Google search run capped below this (max-total-charge-usd-below-minimum), whatever it would cost. */
export const GOOGLE_SEARCH_MIN_CHARGE_USD = 0.5;

/** APIFY_MAX_CHARGE_USD as a positive number of USD, else the default. */
export function maxChargeUsd(env: Pick<Env, "APIFY_MAX_CHARGE_USD">): number {
  const n = Number(env.APIFY_MAX_CHARGE_USD?.trim());
  return env.APIFY_MAX_CHARGE_USD?.trim() && Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_CHARGE_USD;
}

/** The fields of an Apify run object we use (https://docs.apify.com/api/v2/actor-run-get). */
export type ApifyRun = {
  id: string;
  actId?: string;
  status: string; // READY | RUNNING | SUCCEEDED | FAILED | TIMING-OUT | TIMED-OUT | ABORTING | ABORTED
  statusMessage?: string | null;
  defaultDatasetId?: string;
  usageTotalUsd?: number | null;
  finishedAt?: string | null;
};

export const TERMINAL_RUN_STATUSES = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"]);

/** Told about every run we start: when it starts and when it ends (src/billing/usage.ts records and debits it). */
export type ApifyMeter = { onRun(actor: string, run: ApifyRun, maxChargeUsd: number): Promise<void> };

export type RunOptions = {
  /** Actor run timeout in seconds: Apify stops the run after it (TIMED-OUT). */
  timeoutSecs: number;
  /** Hard cap on what the run may cost (maxTotalChargeUsd). */
  maxChargeUsd: number;
  /** Top-level dataset fields to return (smaller responses). */
  fields?: string[];
  /** Dataset items to read back. */
  limit?: number;
  meter?: ApifyMeter;
  fetchFn?: FetchFn;
  /** Extra seconds to wait past timeoutSecs before aborting (default 30; tests use 0). */
  graceSecs?: number;
};

function hintFor(status: number): string {
  if (status === 401 || status === 403) return " Check APIFY_TOKEN (console.apify.com > Settings > API & Integrations).";
  if (status === 402) return " The Apify account is out of credit or over its usage limit.";
  if (status === 429) return " Apify is rate limiting; try again in a minute.";
  return "";
}

async function apifyJson<T>(fetchFn: FetchFn, token: string, method: "GET" | "POST", path: string, label: string, body?: unknown, timeoutSecs = 30): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(`${APIFY_API}${path}`, {
      method,
      // Token in the header, never in the URL (URLs end up in logs).
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutSecs * 1000),
    });
  } catch (err) {
    throw new ServiceError("upstream", `Apify ${label} did not answer: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    let detail = "";
    try {
      const parsed = (await res.json()) as { error?: { type?: string; message?: string } };
      detail = [parsed.error?.type, parsed.error?.message].filter(Boolean).join(": ");
    } catch {
      detail = res.statusText;
    }
    throw new ServiceError("upstream", `Apify ${label} failed (HTTP ${res.status}${detail ? `, ${detail}` : ""}).${hintFor(res.status)}`);
  }
  return (await res.json()) as T;
}

async function report(meter: ApifyMeter | undefined, actor: string, run: ApifyRun, cap: number) {
  if (!meter) return;
  try {
    await meter.onRun(actor, run, cap);
  } catch (err) {
    // Metering must not fail the read; the run is still capped by maxTotalChargeUsd.
    console.error(`apify meter ${run.id}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Starts `actor` with `input`, waits up to `timeoutSecs` (+30 s grace) for it to finish, and returns its dataset
 * items. A run that is still going at the deadline is aborted so it stops spending. The meter sees the run when it
 * starts and when it ends. SUCCEEDED and TIMED-OUT runs return what they stored; FAILED and ABORTED runs throw.
 */
export async function runActor<T>(token: string, actor: string, input: unknown, opts: RunOptions): Promise<T[]> {
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const actorPath = actor.replace("/", "~");
  const deadline = Date.now() + (opts.timeoutSecs + (opts.graceSecs ?? 30)) * 1000;
  const firstWait = Math.min(60, opts.timeoutSecs);
  const qs = new URLSearchParams({ timeout: String(opts.timeoutSecs), maxTotalChargeUsd: String(opts.maxChargeUsd), waitForFinish: String(firstWait) });

  let run = (await apifyJson<{ data: ApifyRun }>(fetchFn, token, "POST", `/acts/${actorPath}/runs?${qs}`, actor, input, firstWait + 15)).data;
  await report(opts.meter, actor, run, opts.maxChargeUsd);
  while (!TERMINAL_RUN_STATUSES.has(run.status) && Date.now() < deadline) {
    const wait = Math.max(1, Math.min(60, Math.ceil((deadline - Date.now()) / 1000)));
    run = (await apifyJson<{ data: ApifyRun }>(fetchFn, token, "GET", `/actor-runs/${run.id}?waitForFinish=${wait}`, actor, undefined, wait + 15)).data;
  }
  if (!TERMINAL_RUN_STATUSES.has(run.status)) {
    try {
      run = (await apifyJson<{ data: ApifyRun }>(fetchFn, token, "POST", `/actor-runs/${run.id}/abort`, actor)).data;
    } catch (err) {
      console.error(`apify abort ${run.id}:`, err instanceof Error ? err.message : err);
    }
    await report(opts.meter, actor, run, opts.maxChargeUsd);
    throw new ServiceError("upstream", `Apify ${actor} did not finish within ${opts.timeoutSecs}s, so the run was aborted; try fewer pages.`);
  }
  await report(opts.meter, actor, run, opts.maxChargeUsd);
  if (run.status !== "SUCCEEDED" && run.status !== "TIMED-OUT") {
    throw new ServiceError("upstream", `Apify ${actor} run ${run.status.toLowerCase()}${run.statusMessage ? `: ${run.statusMessage}` : ""}.`);
  }
  if (!run.defaultDatasetId) return [];
  const items = new URLSearchParams({ format: "json", clean: "true" });
  if (opts.fields?.length) items.set("fields", opts.fields.join(","));
  if (opts.limit) items.set("limit", String(opts.limit));
  const data = await apifyJson<T[]>(fetchFn, token, "GET", `/datasets/${run.defaultDatasetId}/items?${items}`, actor);
  if (run.status === "TIMED-OUT" && !data.length) {
    throw new ServiceError("upstream", `Apify ${actor} timed out after ${opts.timeoutSecs}s without results; try fewer pages.`);
  }
  return data;
}

/** One run object (free read). The cron uses it to pick up a run's final usageTotalUsd. */
export async function getActorRun(token: string, runId: string, fetchFn: FetchFn = defaultFetch): Promise<ApifyRun> {
  return (await apifyJson<{ data: ApifyRun }>(fetchFn, token, "GET", `/actor-runs/${encodeURIComponent(runId)}`, "run lookup")).data;
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

/** Token, cost cap, meter (and a fetch double in tests) for one tool call that may start Actor runs. */
export type ApifyContext = { token: string; maxChargeUsd: number; meter?: ApifyMeter; fetchFn?: FetchFn };

// Sign-in, sign-up and similar pages say nothing about a business (and on our own site they are the auth screens).
const AUTH_SLUGS = ["sign-in", "signin", "sign-up", "signup", "login", "log-in", "register"];
export const AUTH_PATH = new RegExp(`/(${AUTH_SLUGS.join("|")})(/|$)`, "i");
const EXCLUDE_GLOBS = AUTH_SLUGS.flatMap((slug) => [{ glob: `**/${slug}` }, { glob: `**/${slug}/**` }, { glob: `**/${slug}?*` }]);

function isAuthPage(url: string): boolean {
  try {
    return AUTH_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export async function crawlWebsite(
  ctx: ApifyContext,
  opts: { url: string; maxPages: number; renderJs: boolean; maxCharsPerPage: number },
): Promise<PageText[]> {
  const items = await runActor<CrawledPage>(
    ctx.token,
    "apify/website-content-crawler",
    {
      startUrls: [{ url: opts.url }],
      // cheerio = plain HTTP (fast, cheap); playwright:adaptive renders JavaScript when a page needs it.
      crawlerType: opts.renderJs ? "playwright:adaptive" : "cheerio",
      maxCrawlPages: opts.maxPages,
      maxResults: opts.maxPages,
      maxCrawlDepth: 1,
      excludeUrlGlobs: EXCLUDE_GLOBS,
      saveMarkdown: false,
      removeCookieWarnings: true,
      requestTimeoutSecs: 30,
      maxRequestRetries: 1,
      proxyConfiguration: { useApifyProxy: true },
    },
    {
      timeoutSecs: opts.renderJs ? 150 : 90,
      maxChargeUsd: ctx.maxChargeUsd,
      fields: ["url", "metadata", "text"],
      limit: opts.maxPages,
      meter: ctx.meter,
      fetchFn: ctx.fetchFn,
    },
  );
  return items
    .filter((item) => item.url && item.text && !isAuthPage(item.url))
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

export async function searchGoogle(ctx: ApifyContext, input: SearchInput): Promise<{ results: SearchResult[]; related_queries: string[] }> {
  const pages = await runActor<SerpPage>(
    ctx.token,
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
    {
      timeoutSecs: 60,
      maxChargeUsd: Math.max(ctx.maxChargeUsd, GOOGLE_SEARCH_MIN_CHARGE_USD),
      fields: ["organicResults", "relatedQueries"],
      limit: Math.ceil(input.max_results / 10),
      meter: ctx.meter,
      fetchFn: ctx.fetchFn,
    },
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
