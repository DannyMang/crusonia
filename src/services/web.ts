// Reading a company's website (onboarding: propose an ICP from what the site says; research: read a prospect).
// With APIFY_TOKEN: apify/website-content-crawler, cheerio first, and a JavaScript-rendering retry
// (playwright:adaptive) when the plain crawl finds no text (client-rendered SPAs). Without it (or if Apify fails):
// a plain fetch of the homepage plus a few same-site pages that usually describe the business (about, product,
// pricing, ...). Sign-in and sign-up pages are never returned. Crusonia's own host is answered from its landing
// copy (src/services/site-copy.ts): a Worker cannot fetch its own workers.dev hostname.
import { z } from "zod";
import type { Env } from "../env.ts";
import { defaultFetch, type FetchFn } from "../providers/http.ts";
import { AUTH_PATH, crawlWebsite, maxChargeUsd, trimText, type ApifyMeter, type PageText } from "./apify.ts";
import { ServiceError, describeError } from "./errors.ts";
import { siteCopy } from "./site-copy.ts";

const MAX_CHARS_PER_PAGE = 6000;
const MAX_HTML_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "Mozilla/5.0 (compatible; CrusoniaBot/0.1; +https://github.com/DannyMang/crusonia)";
/** Less visible text than this across all pages counts as an empty read (an SPA shell, a blocked page). */
export const MIN_TEXT_CHARS = 200;

export const readWebsiteInputSchema = z.object({
  url: z.string().trim().min(3).max(2048).describe("Company website, e.g. 'https://acme.com' or 'acme.com'."),
  max_pages: z.number().int().min(1).max(10).default(5).describe("Pages to read, homepage first (1-10, default 5)."),
  render_js: z
    .boolean()
    .default(false)
    .describe(
      "Render JavaScript in a browser from the start (slower, needs APIFY_TOKEN). Not needed in general: a read that finds no text is retried with rendering automatically.",
    ),
});
export type ReadWebsiteInput = z.infer<typeof readWebsiteInputSchema>;

export type ReadWebsiteResult = {
  mode: "apify" | "direct_fetch" | "own_site";
  pages: PageText[];
  /** True when the pages were rendered in a browser (asked for, or the automatic retry). */
  rendered?: boolean;
  note?: string;
};

/** Metering (Apify runs) and a fetch double for tests. */
export type ReadWebsiteDeps = { meter?: ApifyMeter; fetchFn?: FetchFn };

export function normalizeUrl(raw: string): URL {
  const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ServiceError("invalid", `Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ServiceError("invalid", `Only http(s) URLs can be read: ${raw}`);
  // "dan@gmail.com" parses as user "dan" at gmail.com; never crawl the email provider for an email address.
  if (url.username || url.password) throw new ServiceError("invalid", `That is an email address or a login, not a website: ${raw}`);
  if (!url.hostname.includes(".")) throw new ServiceError("invalid", `Not a public website: ${raw}`);
  url.hash = "";
  return url;
}

/** PUBLIC_URL's host, or one of its preview hosts (<alias or version>-<host>, e.g. app-crusonia.x.workers.dev). */
export function isOwnHost(env: Pick<Env, "PUBLIC_URL">, url: URL): boolean {
  let own: string;
  try {
    own = new URL(env.PUBLIC_URL).hostname.toLowerCase();
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return host === own || host.endsWith(`-${own}`);
}

export const isEmptyRead = (pages: PageText[]) => pages.reduce((n, p) => n + p.text.trim().length, 0) < MIN_TEXT_CHARS;

function ownSite(url: URL, maxPages: number): ReadWebsiteResult {
  const pages = siteCopy();
  // The page asked for first (e.g. /pricing), then the rest in site order.
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const ordered = [...pages.filter((p) => p.path === path), ...pages.filter((p) => p.path !== path)].slice(0, maxPages);
  return {
    mode: "own_site",
    pages: ordered.map((p) => ({ url: new URL(p.path, url.origin).href, title: p.title, description: p.description, ...trimText(p.text, MAX_CHARS_PER_PAGE) })),
    note: "This is Crusonia's own site: read from its landing copy (a Worker cannot fetch its own hostname).",
  };
}

export async function readWebsite(env: Env, input: ReadWebsiteInput, deps: ReadWebsiteDeps = {}): Promise<ReadWebsiteResult> {
  const url = normalizeUrl(input.url);
  if (isOwnHost(env, url)) return ownSite(url, input.max_pages);
  let note: string | undefined;

  if (env.APIFY_TOKEN) {
    const ctx = { token: env.APIFY_TOKEN, maxChargeUsd: maxChargeUsd(env), meter: deps.meter, fetchFn: deps.fetchFn };
    const crawl = (renderJs: boolean) =>
      crawlWebsite(ctx, { url: url.href, maxPages: input.max_pages, renderJs, maxCharsPerPage: MAX_CHARS_PER_PAGE });
    try {
      const pages = await crawl(input.render_js);
      if (!isEmptyRead(pages)) return { mode: "apify", pages, ...(input.render_js ? { rendered: true } : {}) };
      if (input.render_js) {
        note = "Apify found no readable text even with JavaScript rendering; fell back to a plain fetch.";
      } else {
        // Client-rendered sites (SPAs) have no text until JavaScript runs: read them again in a browser.
        const rendered = await crawl(true);
        if (!isEmptyRead(rendered)) {
          return { mode: "apify", pages: rendered, rendered: true, note: "The plain crawl found no text, so the site was read again with JavaScript rendering." };
        }
        note = "Apify found no readable text, even with JavaScript rendering; fell back to a plain fetch.";
      }
    } catch (err) {
      note = `Apify crawl failed (${describeError(err)}); fell back to a plain fetch.`;
    }
  } else {
    note = "APIFY_TOKEN is not set: read the site with a plain fetch (no JavaScript rendering).";
    if (input.render_js) note += " render_js was ignored.";
  }

  let pages: PageText[];
  try {
    pages = await fetchSite(url, input.max_pages, deps.fetchFn ?? defaultFetch);
  } catch (err) {
    // Say what was tried before the fetch failed, so the agent (or owner) knows which provider to blame.
    throw new ServiceError("upstream", `${describeError(err)}${note ? ` ${note.replace(/; fell back to a plain fetch\.$/, ".")}` : ""}`);
  }
  if (isEmptyRead(pages)) {
    const empty = "The page has almost no text without JavaScript.";
    note = note ? `${note} ${empty}` : empty;
  }
  return { mode: "direct_fetch", pages, note };
}

// ---------- plain fetch ----------

type Extracted = PageText & { links: string[] };

// Pages that tend to say what a company sells and to whom.
const PRIORITY = /(about|company|product|platform|solution|feature|pricing|customer|case-stud|use-case|industr|who-we|why|how-it-works|services)/i;
const SKIP = /(privacy|terms|legal|cookie|careers|jobs|status|cdn-cgi|\/cart|checkout|\.(pdf|png|jpe?g|gif|svg|webp|zip|mp4|xml|json)$)/i;

async function fetchSite(start: URL, maxPages: number, fetchFn: FetchFn): Promise<PageText[]> {
  const home = await fetchPage(start, fetchFn);
  if (home instanceof ServiceError) throw home;
  const pages: PageText[] = [strip(home)];
  if (maxPages <= 1) return pages;

  const origin = new URL(home.url).origin;
  const seen = new Set([canonical(start), canonical(new URL(home.url))]);
  const candidates: { url: URL; rank: number }[] = [];
  for (const href of home.links) {
    let link: URL;
    try {
      link = new URL(href, home.url);
    } catch {
      continue;
    }
    link.hash = "";
    link.search = "";
    const key = canonical(link);
    if (link.origin !== origin || seen.has(key) || SKIP.test(link.pathname) || AUTH_PATH.test(link.pathname)) continue;
    seen.add(key);
    const depth = link.pathname.split("/").filter(Boolean).length;
    candidates.push({ url: link, rank: (PRIORITY.test(link.pathname) ? 0 : 10) + depth });
  }
  candidates.sort((a, b) => a.rank - b.rank);

  const extra = await Promise.all(candidates.slice(0, maxPages - 1).map((c) => fetchPage(c.url, fetchFn)));
  for (const page of extra) if (!(page instanceof ServiceError) && page.text) pages.push(strip(page));
  return pages;
}

function canonical(url: URL): string {
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
}

function strip({ links: _links, ...page }: Extracted): PageText {
  return page;
}

async function fetchPage(url: URL, fetchFn: FetchFn): Promise<Extracted | ServiceError> {
  let res: Response;
  try {
    res = await fetchFn(url.href, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return new ServiceError("upstream", `Could not fetch ${url.href}: ${describeError(err)}`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    return new ServiceError("upstream", `Fetching ${url.href} returned HTTP ${res.status}.`);
  }
  const type = res.headers.get("content-type") ?? "";
  const body = await readCapped(res, MAX_HTML_BYTES);
  if (type.includes("text/plain")) {
    return { url: res.url || url.href, title: null, description: null, links: [], ...trimText(body, MAX_CHARS_PER_PAGE) };
  }
  if (!type.includes("html")) {
    return new ServiceError("upstream", `${url.href} is not a web page (content-type: ${type || "unknown"}).`);
  }
  // Menus and footers repeat on every page, so skip them; if that leaves almost nothing, keep them.
  let page = await extractHtml(body, true);
  if (page.text.length < 300) {
    const full = await extractHtml(body, false);
    if (full.text.length > page.text.length) page = full;
  }
  return { url: res.url || url.href, ...page };
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  if (size >= maxBytes) await reader.cancel();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes.subarray(0, Math.min(size, maxBytes)));
}

// Elements whose text is never visible.
const HIDDEN = 'script, style, noscript, template, svg, iframe, object, [hidden], [aria-hidden="true"]';
// Site chrome (menus, footers, cookie banners) that repeats on every page.
const CHROME = 'nav, footer, [role="navigation"], [role="contentinfo"], [role="dialog"], [role="alertdialog"]';
// Inline elements that are often placed side by side without whitespace ("Get startedLog in").
const INLINE_GAPS = "a, button, label";
// Start a new line before these so words from adjacent blocks don't run together.
const BLOCKS = "p, div, li, br, tr, td, th, h1, h2, h3, h4, h5, h6, section, article, header, footer, main, nav, aside, dt, dd, blockquote, pre, figcaption";

async function extractHtml(html: string, skipChrome: boolean): Promise<Omit<Extracted, "url">> {
  let title = "";
  let description: string | null = null;
  let hiddenDepth = 0;
  let inHead = false; // <head> holds no visible text; its end tag is often implied, so <body> also ends it
  const parts: string[] = [];
  const links: string[] = [];

  const rewriter = new HTMLRewriter()
    .on("title", {
      text(t) {
        title += t.text;
      },
    })
    .on('meta[name="description"], meta[property="og:description"]', {
      element(el) {
        description ??= el.getAttribute("content");
      },
    })
    .on("a[href]", {
      element(el) {
        const href = el.getAttribute("href");
        if (href && !/^(mailto:|tel:|javascript:|#)/i.test(href)) links.push(href);
      },
    })
    .on(skipChrome ? `${HIDDEN}, ${CHROME}` : HIDDEN, {
      element(el) {
        try {
          el.onEndTag(() => {
            hiddenDepth--;
          });
          hiddenDepth++;
        } catch {
          // Self-closing (e.g. <svg/>): no content to hide.
        }
      },
    })
    .on(BLOCKS, {
      element() {
        if (hiddenDepth === 0) parts.push("\n");
      },
    })
    .on(INLINE_GAPS, {
      element() {
        if (hiddenDepth === 0) parts.push(" ");
      },
    })
    .on("head", {
      element(el) {
        inHead = true;
        try {
          el.onEndTag(() => {
            inHead = false;
          });
        } catch {
          // no end tag
        }
      },
    })
    .on("body", {
      element() {
        inHead = false;
      },
    })
    .onDocument({
      text(t) {
        if (!inHead && hiddenDepth === 0) parts.push(t.text);
      },
    });

  await rewriter.transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })).arrayBuffer();

  const { text, truncated } = trimText(decodeEntities(parts.join("")), MAX_CHARS_PER_PAGE);
  return {
    title: decodeEntities(title).trim() || null,
    description: description ? decodeEntities(description).trim() : null,
    text,
    truncated,
    links,
  };
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED[code.toLowerCase()] ?? m;
  });
}
