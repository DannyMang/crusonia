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
