// Markdown parsing for the Company summary (GTM.md), pure so `bun test` covers it (test/markdown.test.ts). The
// output is a small tree that lib/markdown.tsx renders as React elements, never as HTML: raw HTML stays literal
// text, and links survive only for absolute http(s) URLs. Covers what the summary uses: headings, paragraphs,
// - and 1. lists, > quotes, **bold**, *italic*, `code` and [text](url).

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] };

export type Block =
  | { t: "h"; level: 1 | 2 | 3; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; start: number; items: Inline[][] }
  | { t: "quote"; c: Inline[] };

/** Only absolute http(s) links survive; anything else (javascript:, data:, relative) renders as plain text. */
export function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

const INLINE = /(\*\*([^*]+?)\*\*|__([^_]+?)__|`([^`]+?)`|\[([^\]]+?)\]\(([^)\s]+?)\)|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_)/;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let rest = src;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push({ t: "text", v: rest });
      break;
    }
    if (m.index > 0) out.push({ t: "text", v: rest.slice(0, m.index) });
    const [whole, , strongA, strongB, code, linkText, linkHref, emA, emB] = m;
    if (strongA !== undefined || strongB !== undefined) out.push({ t: "strong", c: parseInline(strongA ?? strongB ?? "") });
    else if (code !== undefined) out.push({ t: "code", v: code });
    else if (linkText !== undefined && linkHref !== undefined) {
      const href = safeHref(linkHref);
      out.push(href ? { t: "link", href, c: parseInline(linkText) } : { t: "text", v: whole });
    } else out.push({ t: "em", c: parseInline(emA ?? emB ?? "") });
    rest = rest.slice(m.index + whole.length);
  }
  return out;
}

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { t: "ul" | "ol"; start: number; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length) blocks.push({ t: "p", c: parseInline(para.join(" ")) });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list.t === "ul" ? { t: "ul", items: list.items.map(parseInline) } : { t: "ol", start: list.start, items: list.items.map(parseInline) });
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      flushList();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) {
      flushPara();
      flushList();
      blocks.push({ t: "h", level: Math.min(h[1]!.length, 3) as 1 | 2 | 3, c: parseInline(h[2]!.replace(/\s+#+$/, "")) });
      continue;
    }
    const ul = /^[-*+]\s+(.*)$/.exec(trimmed);
    const ol = /^(\d{1,4})[.)]\s+(.*)$/.exec(trimmed);
    if (ul || ol) {
      flushPara();
      const kind = ul ? "ul" : "ol";
      if (!list || list.t !== kind) {
        flushList();
        list = { t: kind, start: ol ? Number(ol[1]) : 1, items: [] };
      }
      list.items.push(ul ? ul[1]! : ol![2]!);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // An indented continuation of the last list item.
      list.items[list.items.length - 1] += ` ${trimmed}`;
      continue;
    }
    const q = /^>\s?(.*)$/.exec(trimmed);
    if (q) {
      flushPara();
      flushList();
      blocks.push({ t: "quote", c: parseInline(q[1]!) });
      continue;
    }
    flushList();
    para.push(trimmed);
  }
  flushPara();
  flushList();
  return blocks;
}
