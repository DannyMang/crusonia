// Evidence citations in agent text: why_summary and rationale cite a lead's evidence as [1], [2]... (1 = the
// oldest evidence item). Pure, so `bun test` covers it.

export type CitedPart = { t: "text"; v: string } | { t: "cite"; n: number };

/** "Hiring an SDR [1], 24 people [2][3]." -> text and citation parts, in order. */
export function citedParts(text: string): CitedPart[] {
  const parts: CitedPart[] = [];
  const re = /\[(\d{1,3})\]/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push({ t: "text", v: text.slice(last, m.index) });
    parts.push({ t: "cite", n: Number(m[1]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ t: "text", v: text.slice(last) });
  return parts;
}

/**
 * One entry per source URL with every evidence number it backs, so two claims from one page read "1 2 seam.co", not two
 * identical lines. `n` is the number the text cites; without one, the position in the list.
 */
export function uniqueSources<E extends { source_url: string; created_at: string; n?: number | null }>(evidence: E[]): { url: string; numbers: number[]; read_at: string }[] {
  const byUrl = new Map<string, { url: string; numbers: number[]; read_at: string }>();
  evidence.forEach((e, i) => {
    const n = e.n ?? i + 1;
    const seen = byUrl.get(e.source_url);
    if (seen) {
      seen.numbers.push(n);
      if (e.created_at > seen.read_at) seen.read_at = e.created_at;
    } else byUrl.set(e.source_url, { url: e.source_url, numbers: [n], read_at: e.created_at });
  });
  return [...byUrl.values()];
}

/** "https://www.techcrunch.com/2026/x/" -> "techcrunch.com/2026/x". */
export function sourceLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = (u.pathname + u.search).replace(/\/+$/, "");
    return u.hostname.replace(/^www\./, "") + (path === "/" ? "" : path);
  } catch {
    return url;
  }
}

/** "https://www.lever.co/x" -> "lever.co". */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export type BodyPart = { t: "text"; v: string } | { t: "cite"; n: number; url: string };

/**
 * A draft body with its citations ([{text, source_url}]) marked: each cited phrase gets "[n]" after its first
 * occurrence, n being the number of the lead's evidence item with that source (numbered by `sources` order, oldest
 * first); a source that is not among the evidence gets the next free number.
 */
export function citeBody(body: string, citations: { text: string; source_url: string }[], sources: string[] = []): BodyPart[] {
  const numbers = new Map(sources.map((url, i) => [url, i + 1] as const));
  let next = sources.length + 1;
  const marks: { at: number; n: number; url: string }[] = [];
  for (const c of citations) {
    const i = c.text ? body.indexOf(c.text) : -1;
    if (i < 0) continue;
    let n = numbers.get(c.source_url);
    if (n === undefined) {
      n = next++;
      numbers.set(c.source_url, n);
    }
    marks.push({ at: i + c.text.length, n, url: c.source_url });
  }
  marks.sort((a, b) => a.at - b.at);
  const parts: BodyPart[] = [];
  let last = 0;
  for (const m of marks) {
    if (m.at > last) parts.push({ t: "text", v: body.slice(last, m.at) });
    parts.push({ t: "cite", n: m.n, url: m.url });
    last = Math.max(last, m.at);
  }
  if (last < body.length) parts.push({ t: "text", v: body.slice(last) });
  return parts;
}
