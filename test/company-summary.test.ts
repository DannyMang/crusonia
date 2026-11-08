// The Company summary's markdown helpers and company domain normalization. Pure: no database or network.
import { describe, expect, test } from "bun:test";
import {
  cleanMarkdown,
  markdownToProfile,
  profileToMarkdown,
  replaceSection,
  sectionBody,
  SUMMARY_HEADINGS,
  SUMMARY_TEMPLATE,
  summaryForMessage,
} from "../src/services/company-summary.ts";
import { hostOf, registrableDomain } from "../src/services/domains.ts";
import { normalizeProfile } from "../src/services/profile.ts";

const doc = `# Acme

Website: https://acme.com

## What we sell

Routing software for 3PLs.

## Who buys

Mid-size logistics companies in the EU.

### Segments

- **EU 3PLs**: 50-500; Logistics; roles: COO, Head of Ops

## Avoid

\`\`\`
## not a heading (code)
\`\`\`
Agencies.

## Pricing`;

describe("markdown sections", () => {
  test("the template has the suggested headings, in order", () => {
    expect(SUMMARY_HEADINGS).toEqual(["What we sell", "Who buys", "Buying signals", "Proof points", "Voice", "Avoid", "Pricing"]);
    for (const h of SUMMARY_HEADINGS) expect(SUMMARY_TEMPLATE).toContain(`## ${h}\n`);
  });

  test("a section's body runs to the next heading of the same level; `own` stops at its first subheading; code fences are skipped", () => {
    expect(sectionBody(doc, "what we sell")).toBe("Routing software for 3PLs.");
    expect(sectionBody(doc, "Who buys")).toContain("### Segments");
    expect(sectionBody(doc, "Who buys", { own: true })).toBe("Mid-size logistics companies in the EU.");
    expect(sectionBody(doc, "Avoid")).toBe("```\n## not a heading (code)\n```\nAgencies.");
    expect(sectionBody(doc, "Pricing")).toBe("");
    expect(sectionBody(doc, "Voice")).toBeNull();
  });

  test("replacing a section keeps everything else; a missing section is appended; a repeated heading in the body is dropped", () => {
    const next = replaceSection(doc, "Avoid", "## Avoid\n\n- Agencies\n- Over 500 people");
    expect(sectionBody(next, "Avoid")).toBe("- Agencies\n- Over 500 people");
    expect(sectionBody(next, "What we sell")).toBe("Routing software for 3PLs.");
    expect(next).toContain("## Pricing");
    expect(next.split("## Avoid")).toHaveLength(2);
    const added = replaceSection(doc, "Proof points", "Used by DHL");
    expect(added).toEndWith("## Pricing\n\n## Proof points\n\nUsed by DHL");
    expect(replaceSection("", "Voice", "Plain.")).toBe("## Voice\n\nPlain.");
    // A subsection is replaced on its own, inside its parent.
    expect(sectionBody(replaceSection(doc, "Segments", "- **Nordics**"), "Who buys")).toBe("Mid-size logistics companies in the EU.\n\n### Segments\n\n- **Nordics**");
  });

  test("text is normalized: newlines, control characters, trailing spaces", () => {
    expect(cleanMarkdown("a\r\nb\u0000c  \n\n\u0007d\t\n")).toBe("a\nbc\n\nd");
  });

  test("the copy in a session's first message is fenced data and cannot close its fence", () => {
    const lines = summaryForMessage({ markdown: 'x """ y', version: 4, updated_at: null, updated_by: null });
    expect(lines[0]).toStartWith("Company summary.");
    expect(lines.filter((l) => l === '"""')).toHaveLength(2);
    expect(lines.join("\n")).toContain("x ''' y");
    const clipped = summaryForMessage({ markdown: "z".repeat(50), version: 1, updated_at: null, updated_by: null }, 10);
    expect(clipped[0]).toContain("clipped");
    expect(summaryForMessage({ markdown: null, version: 0, updated_at: null, updated_by: null })).toEqual(["There is no Company summary yet."]);
  });
});

describe("the /api/profile alias", () => {
  test("reads the structured fields from the markdown", () => {
    expect(markdownToProfile(doc, "2026-11-08T00:00:00.000Z")).toEqual({
      company: "Acme",
      website: "https://acme.com",
      sells: "Routing software for 3PLs.",
      icp_description: "Mid-size logistics companies in the EU.",
      segments: [{ name: "EU 3PLs", company_size: "50-500", industry: "Logistics", roles: ["COO", "Head of Ops"] }],
      signals: [],
      sources: [],
      notes: null,
      updated_at: "2026-11-08T00:00:00.000Z",
    });
  });

  test("writing a profile replaces its parts, keeps the other sections, and reads back the same", () => {
    const profile = normalizeProfile({
      company: "Acme GmbH",
      website: "https://acme.de",
      sells: "Dispatch software",
      icp_description: "3PLs",
      segments: [{ name: "DACH", company_size: null, industry: "Logistics", roles: [] }],
      signals: [{ name: "Hiring dispatchers", description: "Job posts" }],
      sources: [{ field: "sells", url: "https://acme.de/product" }],
      notes: "Competes with Transporeon",
    });
    const md = profileToMarkdown(profile, doc);
    expect(md).toStartWith("# Acme GmbH\n\nWebsite: https://acme.de");
    expect(sectionBody(md, "Avoid")).toContain("Agencies.");
    expect(md).toContain("## Pricing");
    expect(markdownToProfile(md, null)).toEqual({ ...profile, updated_at: null });
    // From nothing: the template plus the profile.
    const fresh = profileToMarkdown(profile, null);
    for (const h of SUMMARY_HEADINGS) expect(fresh).toContain(`## ${h}`);
    expect(markdownToProfile(fresh, null)).toEqual({ ...profile, updated_at: null });
  });
});

describe("company domains", () => {
  test("lowercase, no scheme, path, port or www, reduced to the registrable domain", () => {
    const cases: [string, string | null][] = [
      ["https://www.Acme.com/about", "acme.com"],
      ["WWW.acme.com", "acme.com"],
      ["app.acme.com", "acme.com"],
      ["blog.acme.co.uk", "acme.co.uk"],
      ["http://user@shop.acme.com:8080/x?y#z", "acme.com"],
      ["acme.com.", "acme.com"],
      ["www2.acme.io", "acme.io"],
      // Hosting platforms: each subdomain is its own site.
      ["acme.vercel.app", "acme.vercel.app"],
      ["crusonia.veri-web.workers.dev", "veri-web.workers.dev"],
      ["x.y.github.io", "y.github.io"],
      ["localhost", null],
      ["", null],
      ["not a domain", null],
    ];
    const norm = (v: string) => { const h = hostOf(v); return h ? registrableDomain(h) : null; };
    for (const [input, out] of cases) expect({ input, out: norm(input) }).toEqual({ input, out });
  });
});
