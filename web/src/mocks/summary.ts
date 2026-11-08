// /api/company-summary mocks in the backend's shapes (src/api/onboarding.ts companySummary on the workspaces
// branch): GET {markdown, version, updated_at, updated_by, change_note, template?, max_chars}, PUT and POST /revert
// {...view, unchanged}, GET /versions {data: [{version, author, change_note, created_at, chars}]}.
// Sample text follows "Settings · Company summary"; `?mock=empty` starts with no summary (version 0).
import { http } from "msw";
import type { CompanySummary, SummaryVersion } from "../api.ts";
import { ago, body, DAY, fail, HOUR, isEmpty, ok, scenario } from "./util.ts";

const MAX_CHARS = 20_000;
const HEADINGS = ["What we sell", "Who buys", "Buying signals", "Proof points", "Voice", "Avoid", "Pricing"];
const TEMPLATE = `# Company summary\n\n${HEADINGS.map((h) => `## ${h}\n`).join("\n")}`;

const v7 = `# Fieldnote

## What we sell
Call notes for founder-led sales. Fieldnote records sales calls,
writes the summary and next steps, and updates the CRM. From $29 a seat.

## Who buys
- Founders and first sales hires at seed to Series A software companies
- 10 to 80 people, mostly devtools and fintech, US and UK

## Buying signals
- Hiring a first AE or a founding sales role
- A founder posting about running sales calls themselves
- Raised a seed or Series A in the last 6 months

## Proof points
- 38 customers, including Harbor Labs and Quillstack
- "Saved me five hours a week of CRM updates." Head of Sales, Tessellate

## Voice
Short and plain, founder to founder. No buzzwords. Sign off as Daniel.

## Avoid
- Companies with 10 or more AEs
- Existing customers (synced from HubSpot)
`;

const v6 = v7.replace("- Raised a seed or Series A in the last 6 months\n", "");
const v5 = v6.replace("- 10 to 80 people, mostly devtools and fintech, US and UK", "- 10 to 80 people, mostly devtools, fintech and healthcare, US and UK");
const v1 = `# Fieldnote

## What we sell
Call notes for founder-led sales. Fieldnote records sales calls and writes the summary.

## Who buys
- Founders at seed to Series A software companies
`;

type Row = { version: number; markdown: string; author: string; change_note: string | null; created_at: string };

let rows: Row[] | null = null;
const seed = (): Row[] =>
  isEmpty()
    ? []
    : [
        { version: 1, markdown: v1, author: "onboarding", change_note: "First draft from fieldnote.io", created_at: ago(3 * DAY) },
        { version: 5, markdown: v5, author: "agent:api_key:key_1", change_note: "Added two customer quotes to Proof points", created_at: ago(2 * DAY) },
        { version: 6, markdown: v6, author: "user:owner", change_note: "Removed healthcare from Who buys", created_at: ago(1 * DAY + 3 * HOUR) },
        { version: 7, markdown: v7, author: "agent:ses_hiring_sweep", change_note: 'Added "Raised a seed or Series A in the last 6 months" to Buying signals', created_at: ago(2 * HOUR) },
      ];
const all = () => (rows ??= seed());

function view(r: Row | undefined): CompanySummary {
  return r
    ? { markdown: r.markdown, version: r.version, updated_at: r.created_at, updated_by: r.author, change_note: r.change_note }
    : { markdown: null, version: 0, updated_at: null, updated_by: null, change_note: null };
}
const current = () => all().at(-1);

function write(markdown: string, note: string | null): CompanySummary & { unchanged: boolean } {
  const cur = current();
  if (cur?.markdown === markdown) return { ...view(cur), unchanged: true };
  const row: Row = { version: (cur?.version ?? 0) + 1, markdown, author: "user:owner", change_note: note, created_at: new Date().toISOString() };
  all().push(row);
  return { ...view(row), unchanged: false };
}

const unshipped = () => scenario() === "unconfigured";
const missing = (method: string, path: string) => fail(404, "not_found", `No route for ${method} ${path}`);

export const summaryHandlers = [
  http.get("/api/company-summary", () => {
    if (unshipped()) return missing("GET", "/api/company-summary");
    const v = view(current());
    return ok({ ...v, ...(v.version === 0 ? { template: TEMPLATE } : {}), max_chars: MAX_CHARS });
  }),
  http.put("/api/company-summary", async ({ request }) => {
    const b = await body<{ markdown?: string; note?: string | null; base_version?: number | null }>(request);
    const cur = current()?.version ?? 0;
    if (typeof b.base_version === "number" && b.base_version !== cur) {
      return fail(409, "version_conflict", `The Company summary changed (now v${cur}); reload it and apply your edit again.`);
    }
    return ok(write((b.markdown ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, ""), b.note?.trim() || null));
  }),
  http.get("/api/company-summary/versions", () =>
    unshipped()
      ? missing("GET", "/api/company-summary/versions")
      : ok({
          data: [...all()].reverse().map((r): SummaryVersion => ({ version: r.version, author: r.author, change_note: r.change_note, created_at: r.created_at, chars: r.markdown.length })),
        }),
  ),
  http.get("/api/company-summary/versions/:version", ({ params }) => {
    const r = all().find((x) => x.version === Number(params.version));
    return r ? ok(view(r)) : fail(404, "not_found", `No Company summary version ${String(params.version)}`);
  }),
  http.post("/api/company-summary/revert", async ({ request }) => {
    const { version } = await body<{ version?: number }>(request);
    const r = all().find((x) => x.version === version);
    if (!r) return fail(404, "not_found", `No Company summary version ${String(version)}`);
    return ok(write(r.markdown, `Reverted to v${r.version}`));
  }),
];
