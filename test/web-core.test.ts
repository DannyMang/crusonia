// Pure helpers behind the core web pages: the Company summary markdown parser (web/src/lib/markdown-parse.ts),
// author names (web/src/lib/authors.ts) and citation splitting (web/src/lib/citations.ts).
import { describe, expect, test } from "bun:test";
import { describeAuthor } from "../web/src/lib/authors.ts";
import { citeBody, citedParts, sourceLabel } from "../web/src/lib/citations.ts";
import { sourceLabel as leadSource } from "../web/src/pages/leads/shared.ts";
import { parseInline, parseMarkdown, safeHref } from "../web/src/lib/markdown-parse.ts";

describe("parseMarkdown", () => {
  test("headings, paragraphs joined across lines, and lists", () => {
    const blocks = parseMarkdown("# Fieldnote\n\n## What we sell\nCall notes for\nfounder-led sales.\n\n## Who buys\n- Founders\n- 10 to 80 people\n\n1. First\n2. Second");
    expect(blocks.map((b) => b.t)).toEqual(["h", "h", "p", "h", "ul", "ol"]);
    expect(blocks[0]).toEqual({ t: "h", level: 1, c: [{ t: "text", v: "Fieldnote" }] });
    expect(blocks[2]).toEqual({ t: "p", c: [{ t: "text", v: "Call notes for founder-led sales." }] });
    expect(blocks[4]).toEqual({ t: "ul", items: [[{ t: "text", v: "Founders" }], [{ t: "text", v: "10 to 80 people" }]] });
  });

  test("raw HTML stays text", () => {
    const blocks = parseMarkdown('<img src=x onerror="alert(1)"> <script>alert(1)</script>');
    expect(blocks).toEqual([{ t: "p", c: [{ t: "text", v: '<img src=x onerror="alert(1)"> <script>alert(1)</script>' }] }]);
  });

  test("links survive only for http(s)", () => {
    expect(parseInline("[site](https://fieldnote.io)")).toEqual([{ t: "link", href: "https://fieldnote.io/", c: [{ t: "text", v: "site" }] }]);
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ t: "text", v: "[x](javascript:alert(1)" }, { t: "text", v: ")" }]);
    expect(safeHref("data:text/html,hi")).toBeNull();
    expect(safeHref("/relative")).toBeNull();
  });

  test("bold, italic and code", () => {
    expect(parseInline("a **b** *c* `d`")).toEqual([
      { t: "text", v: "a " },
      { t: "strong", c: [{ t: "text", v: "b" }] },
      { t: "text", v: " " },
      { t: "em", c: [{ t: "text", v: "c" }] },
      { t: "text", v: " " },
      { t: "code", v: "d" },
    ]);
  });
});

describe("describeAuthor", () => {
  const ctx = { userId: "user_1", userName: "Daniel Ung", keyNames: new Map([["key_1", "Claude Code"]]) };
  test("people", () => {
    expect(describeAuthor("user:user_1", ctx)).toEqual({ name: "Daniel Ung", agent: false, you: true });
    expect(describeAuthor("user:owner", ctx).you).toBe(true);
    expect(describeAuthor("user:user_2", ctx)).toEqual({ name: "Teammate", agent: false, you: false });
  });
  test("agents", () => {
    expect(describeAuthor("agent:api_key:key_1", ctx).name).toBe("Claude Code, over MCP");
    expect(describeAuthor("agent:mcp_token", ctx).name).toBe("Your agent, over MCP");
    expect(describeAuthor("agent:ses_123", ctx)).toEqual({ name: "Research agent", agent: true, you: false });
    expect(describeAuthor("onboarding", ctx).name).toBe("Onboarding");
  });
});

describe("citedParts", () => {
  test("splits [n] markers out of the text", () => {
    expect(citedParts("Hiring an SDR [1], and 24 people [2][3].")).toEqual([
      { t: "text", v: "Hiring an SDR " },
      { t: "cite", n: 1 },
      { t: "text", v: ", and 24 people " },
      { t: "cite", n: 2 },
      { t: "cite", n: 3 },
      { t: "text", v: "." },
    ]);
  });
  test("leaves text without markers alone", () => {
    expect(citedParts("No sources here.")).toEqual([{ t: "text", v: "No sources here." }]);
  });
  test("source labels drop the scheme and www", () => {
    expect(sourceLabel("https://www.techcrunch.com/2026/09/16/x")).toBe("techcrunch.com/2026/09/16/x");
    expect(sourceLabel("https://jobs.lever.co/")).toBe("jobs.lever.co");
  });
});

describe("citeBody", () => {
  test("marks each cited phrase with its evidence number", () => {
    const body = "Saw Harbor Labs is hiring a founding AE, right after the Series A. Congrats.";
    const parts = citeBody(
      body,
      [
        { text: "hiring a founding AE", source_url: "https://jobs.lever.co/harborlabs" },
        { text: "the Series A", source_url: "https://techcrunch.com/a" },
      ],
      ["https://harborlabs.dev", "https://harborlabs.dev/about", "https://techcrunch.com/a", "https://jobs.lever.co/harborlabs"],
    );
    expect(parts).toEqual([
      { t: "text", v: "Saw Harbor Labs is hiring a founding AE" },
      { t: "cite", n: 4, url: "https://jobs.lever.co/harborlabs" },
      { t: "text", v: ", right after the Series A" },
      { t: "cite", n: 3, url: "https://techcrunch.com/a" },
      { t: "text", v: ". Congrats." },
    ]);
  });
  test("a source outside the evidence gets the next number; missing phrases are ignored", () => {
    expect(citeBody("Hi there.", [{ text: "there", source_url: "https://x.com/a" }, { text: "nope", source_url: "https://y.com" }], ["https://a.com"])).toEqual([
      { t: "text", v: "Hi there" },
      { t: "cite", n: 2, url: "https://x.com/a" },
      { t: "text", v: "." },
    ]);
  });
});

describe("a lead's source label", () => {
  test("known sources get their name", () => {
    expect(leadSource("google_search")).toBe("Google");
    expect(leadSource("hubspot")).toBe("HubSpot");
  });
  test("a cohort someone named stays as typed", () => {
    expect(leadSource("Launch sign-ups Nov 8")).toBe("Launch sign-ups Nov 8");
  });
  test("a slug is tidied", () => {
    expect(leadSource("event_list")).toBe("Event list");
  });
});
