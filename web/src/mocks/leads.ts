// /api/leads mocks. Sample rows follow "Dashboard · Leads" and "Dashboard · Lead detail".
import { http } from "msw";
import type { Draft, Evidence, Lead, LeadFull, TimelineEvent } from "../api.ts";
import { ago, body, DAY, fail, HOUR, isEmpty, MIN, noContent, ok } from "./util.ts";

type Seed = [id: string, company: string, domain: string, name: string | null, title: string | null, stage: string, score: number, source: string, updatedAgo: number, extra?: Partial<Lead>];

const seeds: Seed[] = [
  ["lead_fieldnote", "Fieldnote", "fieldnote.io", "Maya Chen", "Head of Sales", "awaiting_approval", 92, "apify", 2 * HOUR, { variant: "B", rationale: "Hiring their first SDR · Series A $14M · job post Oct 28" }],
  ["lead_harbor", "Harbor Labs", "harborlabs.dev", "Arjun Patel", "VP Revenue", "awaiting_approval", 87, "hubspot", 1 * HOUR, { rationale: "Launched usage-based pricing · pricing page changed Nov 3" }],
  ["lead_quill", "Quillstack", "quillstack.com", "Sofia Reyes", "Founder & CEO", "awaiting_approval", 84, "agent", 58 * MIN, { rationale: "Opened an Austin office · 3 AE roles posted Nov 4" }],
  ["lead_tess", "Tessellate AI", "tessellate.ai", "Dana Okafor", "Head of Growth", "awaiting_approval", 81, "apify", 12 * MIN, { rationale: "Raised a $22M Series B · announced Nov 5" }],
  ["lead_lumen", "Lumen Health", "lumenhealth.com", "Grace Lin", "Dir. Sales Ops", "researching", 78, "csv", 2 * MIN, { rationale: "Replacing their outbound tool · RevOps job post Nov 2" }],
  ["lead_juniper", "Juniper Freight", "juniperfreight.com", "Ana Ruiz", "VP Sales", "qualified", 74, "apify", 8 * MIN, { rationale: "Hiring 2 BDRs in Denver · new hub opened Oct 30" }],
  ["lead_orbit", "Orbit Ledger", "orbitledger.com", null, null, "researching", 71, "agent", 20 * 1000, { rationale: "New CFO joined from Ramp · LinkedIn post Nov 6" }],
  ["lead_northwind", "Northwind Robotics", "northwindrobotics.com", "Tom Becker", "CRO", "interested", 88, "hubspot", 1 * DAY, { reply_label: "meeting", rationale: "4 SDR openings in Boston · posted Oct 24" }],
  ["lead_kiln", "Kiln Studio", "kilnstudio.co", "Hana Sato", "Head of Partnerships", "interested", 79, "apify", 3 * HOUR, { reply_label: "interested", rationale: "Relaunched site and pricing · changelog Oct 30" }],
  ["lead_parcel", "Parcel & Pine", "parcelandpine.com", "Leo Martins", "COO", "sent", 75, "csv", 2 * DAY, { rationale: "Expanding to EU fulfillment · press release Oct 29" }],
  ["lead_cobalt", "Cobalt Fern", "cobaltfern.com", "Priya Raman", "VP Marketing", "not_interested", 73, "hubspot", 3 * DAY, { reply_label: "not_interested", rationale: "Rebuilding the SDR team · follow up Jan 12" }],
  ["lead_mosaic", "Mosaic Grid", "mosaicgrid.io", "Owen Hart", "Head of Sales", "unsubscribed", 72, "agent", 4 * DAY, { reply_label: "unsubscribe", rationale: "Hired a first RevOps lead · suppressed · never re-contact" }],
  ["lead_bright", "Brightloop", "brightloop.io", "Sam Ortiz", "Founder", "awaiting_approval", 79, "apify", 3 * HOUR, {}],
  ["lead_cinder", "Cinder Analytics", "cinderanalytics.com", "Rae Kim", "VP Sales", "awaiting_approval", 77, "apify", 4 * HOUR, {}],
];

export const sampleLeads: Lead[] = seeds.map(([id, company, domain, name, title, stage, score, source, updatedAgo, extra], i) => ({
  id,
  email: name ? `${name.split(" ")[0]!.toLowerCase()}@${domain}` : null,
  name,
  title,
  company,
  domain,
  website: `https://${domain}`,
  linkedin_url: null,
  sells: null,
  best_customers: null,
  source,
  source_url: `https://${domain}/careers`,
  consent_text: stage === "no_consent" ? null : "Opted in via crusonia.com form",
  consent_at: ago(1 * DAY + i * HOUR),
  has_consent: true,
  variant: i % 2 ? "A" : "B",
  stage,
  score,
  qualified: score >= 70,
  rationale: null,
  review_question: null,
  reply_label: null,
  hubspot_id: source === "hubspot" ? `${18402291 + i}` : null,
  created_at: ago(2 * DAY + i * HOUR),
  updated_at: ago(updatedAgo),
  ...extra,
}));

export const leadsData = () => (isEmpty() ? [] : sampleLeads);

const fieldnoteEvidence: Evidence[] = [
  { id: 1, lead_id: "lead_fieldnote", claim: "Hiring a founding SDR who reports to the Head of Sales", source_url: "https://fieldnote.io/careers/founding-sdr", created_at: ago(2 * HOUR) },
  { id: 2, lead_id: "lead_fieldnote", claim: "Raised a $14M Series A led by Northzone", source_url: "https://techcrunch.com/2026/09/16/fieldnote-series-a", created_at: ago(2 * HOUR) },
  { id: 3, lead_id: "lead_fieldnote", claim: "Sales team is 3 AEs and no SDRs", source_url: "https://linkedin.com/company/fieldnote/people", created_at: ago(2 * HOUR) },
  { id: 4, lead_id: "lead_fieldnote", claim: "Maya Chen joined as Head of Sales in March 2025", source_url: "https://fieldnote.io/team", created_at: ago(2 * HOUR) },
];

const fieldnoteDrafts: Draft[] = [
  {
    id: "drf_fn_2",
    lead_id: "lead_fieldnote",
    version: 2,
    variant: "B",
    subject: "Your first SDR at Fieldnote",
    body: "Hi Maya,\n\nSaw you're hiring a founding SDR [1] and congrats on the Series A [2]. When a team of three AEs [3] adds its first SDR, the first months usually go to building lists by hand.\n\nAcme hands a new SDR a researched list of field-service companies on day one, with a source behind every line.\n\nWorth 15 minutes next week?\n\nDaniel",
    status: "pending_approval",
    provider_message_id: null,
    provider_thread_id: null,
    error: null,
    created_at: ago(2 * HOUR + 14 * MIN),
  },
  {
    id: "drf_fn_1",
    lead_id: "lead_fieldnote",
    version: 1,
    variant: "B",
    subject: "Fieldnote's first SDR",
    body: "Hi Maya, ...",
    status: "superseded",
    provider_message_id: null,
    provider_thread_id: null,
    error: "blocked by fact check: a claim had no source",
    created_at: ago(2 * HOUR + 20 * MIN),
  },
];

const fieldnoteTimeline: TimelineEvent[] = [
  { id: 6, kind: "approval_requested", data: { code: "A7F2", draft_version: 2 }, created_at: ago(2 * HOUR + 10 * MIN) },
  { id: 5, kind: "draft_created", data: { version: 2, variant: "B", words: 96, citations: 3, cost_usd: 0.45 }, created_at: ago(2 * HOUR + 14 * MIN) },
  { id: 4, kind: "lead_scored", data: { score: 92, qualified: true }, created_at: ago(2 * HOUR + 16 * MIN) },
  { id: 3, kind: "research_done", data: { sources: 7, cost_usd: 0.42 }, created_at: ago(2 * HOUR + 18 * MIN) },
  { id: 2, kind: "consent_checked", data: { consent: true }, created_at: ago(2 * HOUR + 20 * MIN) },
  { id: 1, kind: "lead_added", data: { via: "mcp", source: "apify" }, created_at: ago(1 * DAY) },
];

export function leadFull(id: string): LeadFull | null {
  const lead = leadsData().find((l) => l.id === id);
  if (!lead) return null;
  const isFn = id === "lead_fieldnote";
  return {
    lead,
    evidence: isFn ? fieldnoteEvidence : [],
    drafts: isFn ? fieldnoteDrafts : [],
    approvals: isFn
      ? [
          {
            code: "A7F2",
            kind: "send",
            lead_id: id,
            draft_id: "drf_fn_2",
            naive_session_id: "ses_8f3k21",
            tool_call_id: null,
            summary: "Send v2 to maya@fieldnote.io",
            status: "pending",
            answer: null,
            decided_via: null,
            recipient: lead.email,
            expires_at: ago(-24 * MIN),
            decided_at: null,
            created_at: ago(2 * HOUR + 10 * MIN),
          },
        ]
      : [],
    lookalikes: [],
    messages: [],
    sessions: isFn ? [{ id: "ses_8f3k21", purpose: "research", status: "idle", stop_reason: "requires_action", created_at: ago(2 * HOUR + 20 * MIN), updated_at: ago(2 * HOUR + 10 * MIN) }] : [],
    timeline: isFn ? fieldnoteTimeline : [],
  };
}

export const leadHandlers = [
  http.get("/api/leads", ({ request }) => {
    const u = new URL(request.url);
    const stage = u.searchParams.get("stage");
    const q = u.searchParams.get("q")?.toLowerCase();
    const min = Number(u.searchParams.get("min_score") ?? 0);
    const source = u.searchParams.get("source");
    const data = leadsData().filter(
      (l) =>
        (!stage || l.stage === stage) &&
        (!source || l.source === source) &&
        (l.score ?? 0) >= min &&
        (!q || [l.company, l.domain, l.name, l.email].some((v) => v?.toLowerCase().includes(q))),
    );
    return ok({ data, next_cursor: null });
  }),
  http.post("/api/leads/find", () => fail(503, "not_configured", "NAIVE_AGENT_ID is not set")),
  http.post("/api/leads/import", async ({ request }) => {
    const b = await body<{ csv?: string; dry_run?: boolean }>(request);
    const rows = (b.csv ?? "").trim().split(/\r?\n/).slice(1).filter(Boolean);
    return ok({ dry_run: Boolean(b.dry_run), created: rows.length, updated: 0, skipped: 0, rows: rows.map((_, i) => ({ row: i + 2, status: "created", key: `row${i}` })) });
  }),
  http.post("/api/leads", async ({ request }) => {
    const b = await body<Partial<Lead>>(request);
    if (!b.email) return fail(400, "invalid_request", "email: Required");
    return ok({ lead: { ...sampleLeads[0]!, ...b, id: `lead_${Date.now()}`, stage: "new" } }, 201);
  }),
  http.get("/api/leads/:id", ({ params }) => {
    const full = leadFull(String(params.id));
    return full ? ok(full) : fail(404, "not_found", `No lead with id ${String(params.id)}`);
  }),
  http.patch("/api/leads/:id", async ({ params, request }) => {
    const lead = leadsData().find((l) => l.id === params.id);
    if (!lead) return fail(404, "not_found", "Lead not found");
    return ok({ lead: { ...lead, ...(await body<Partial<Lead>>(request)) } });
  }),
  http.delete("/api/leads/:id", () => noContent()),
  http.post("/api/leads/:id/drafts", async ({ params, request }) => {
    const b = await body<{ subject: string; body: string }>(request);
    return ok({ draft: { ...fieldnoteDrafts[0]!, lead_id: String(params.id), ...b, version: 3 } }, 201);
  }),
];
