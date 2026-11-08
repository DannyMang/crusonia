// /api/profile and /api/onboarding/* mocks ("Onboarding · 1-4"), in the backend's real shapes:
// GET/PUT /api/profile -> { profile }, propose -> 202 { session_id }, propose/:id -> ProposeStatus.
// - sample: the crawl takes ~1.5s; the proposal fills in over a few polls (partial profile while running).
// - empty: no saved profile, the crawl finds no pages and the agent proposes nothing.
// - unconfigured: read-website and propose answer 503 not_configured.
import { delay, http } from "msw";
import type { Profile, ProfileInput, ProposeStatus } from "../api.ts";
import { body, fail, isEmpty, ok, scenario } from "./util.ts";

export const sampleProfile: Profile = {
  company: "Acme",
  website: "https://fieldnote.io",
  sells: "Call notes for founder-led sales. Fieldnote records sales calls, writes the summary and next steps, and updates the CRM.",
  icp_description:
    "Seed to Series A B2B software companies, 10 to 80 people, where the founder still runs sales and is about to hire, or just hired, the first sales rep. Strongest in devtools and fintech.",
  segments: [
    { name: "Founder-led devtools", company_size: "10–50", industry: "Developer tools", roles: ["Founder / CEO", "Head of Growth"] },
    { name: "Fintech hiring a first sales team", company_size: "20–80", industry: "Fintech, Payments", roles: ["VP Sales", "First AE"] },
    { name: "Vertical SaaS going outbound", company_size: "30–150", industry: "Vertical SaaS", roles: ["Head of Sales", "RevOps lead"] },
  ],
  signals: [
    { name: "Hiring first SDR", description: "SDR or BDR job post at a company with no sales team yet" },
    { name: "Raised seed or Series A in the last 90 days", description: "Funding news, so budget and a hiring plan just appeared" },
    { name: "Posting about outbound", description: "Founder posts about cold email, pipeline or doing sales alone" },
  ],
  sources: [
    { field: "sells", url: "https://fieldnote.io/" },
    { field: "sells", url: "https://fieldnote.io/pricing" },
    { field: "icp_description", url: "https://fieldnote.io/" },
    { field: "icp_description", url: "https://fieldnote.io/customers" },
    { field: "segments.0", url: "https://fieldnote.io/customers" },
    { field: "segments.1", url: "https://fieldnote.io/customers" },
    { field: "segments.2", url: "https://fieldnote.io/blog/founder-led-sales" },
    { field: "signals.0", url: "https://fieldnote.io/blog/founder-led-sales" },
    { field: "signals.1", url: "https://fieldnote.io/customers" },
    { field: "signals.2", url: "https://fieldnote.io/" },
  ],
  notes: null,
  updated_at: new Date(Date.now() - 2 * 24 * 3600_000).toISOString(),
};

/** What the agent has filled in after `n` polls: what you sell, then who buys, then everything. */
function partialProfile(n: number): Profile | undefined {
  if (n < 2) return undefined;
  const p = sampleProfile;
  const sells = p.sources.filter((s) => s.field === "sells");
  if (n === 2) return { ...p, icp_description: "", segments: [], signals: [], sources: sells };
  return { ...p, segments: [], signals: [], sources: p.sources.filter((s) => s.field === "sells" || s.field === "icp_description") };
}

let saved: Profile | null = null;
const polls = new Map<string, number>();

const status = (session_id: string, rest: Partial<ProposeStatus> & Pick<ProposeStatus, "status">): ProposeStatus => ({
  session_id,
  stop_reason: null,
  waiting_on: null,
  pending_approvals: [],
  ...rest,
});

export const onboardingHandlers = [
  http.get("/api/profile", () => ok({ profile: saved ?? (isEmpty() ? null : sampleProfile) })),
  http.put("/api/profile", async ({ request }) => {
    const input = await body<ProfileInput & { updated_at?: unknown }>(request);
    if ("updated_at" in input) return fail(400, "invalid_request", "updated_at: Unrecognized key");
    const orNull = (v: string | null | undefined) => (v ? v : null);
    saved = {
      company: orNull(input.company),
      website: input.website ? (input.website.includes("://") ? input.website : `https://${input.website}`) : null,
      sells: orNull(input.sells),
      icp_description: orNull(input.icp_description),
      segments: (input.segments ?? []).map((x) => ({ name: x.name, company_size: x.company_size ?? null, industry: x.industry ?? null, roles: x.roles ?? [] })),
      signals: (input.signals ?? []).map((x) => ({ name: x.name, description: x.description ?? null })),
      sources: input.sources ?? [],
      notes: orNull(input.notes),
      updated_at: new Date().toISOString(),
    };
    return ok({ profile: saved });
  }),
  http.post("/api/onboarding/read-website", async ({ request }) => {
    if (scenario() === "unconfigured") return fail(503, "not_configured", "APIFY_TOKEN is not set");
    const { url } = await body<{ url?: string }>(request);
    await delay(1500);
    if (isEmpty()) return ok({ pages: [] });
    const host = (url ?? "fieldnote.io").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const pages = [
      ["/", "Product and headline"],
      ["/pricing", "3 plans, from $29 a seat"],
      ["/customers", "38 logos, 6 case studies"],
      ["/about", "Team of 14, seed-funded"],
      ["/blog/founder-led-sales", "Who you write for"],
      ["/careers", "Hiring a founding AE"],
      ["/changelog", "Weekly releases"],
    ].map(([path, title]) => ({ url: `https://${host}${path}`, title: title!, text: `${title}. Sample page text for ${host}${path}.` }));
    return ok({ pages, mode: "apify" });
  }),
  http.post("/api/onboarding/propose", () => {
    if (scenario() === "unconfigured") return fail(503, "not_configured", "NAIVE_AGENT_ID is not set");
    const id = `ses_prop_${Date.now()}`;
    polls.set(id, 0);
    return ok({ session_id: id }, 202);
  }),
  http.get("/api/onboarding/propose/:id", ({ params }) => {
    if (scenario() === "unconfigured") return fail(503, "not_configured", "NAIVE_AGENT_ID is not set");
    const n = (polls.get(String(params.id)) ?? 0) + 1;
    polls.set(String(params.id), n);
    const id = String(params.id);
    if (isEmpty()) return ok(n < 3 ? status(id, { status: "running" }) : status(id, { status: "done", stop_reason: "end_turn" }));
    return ok(n < 5 ? status(id, { status: "running", profile: partialProfile(n) }) : status(id, { status: "done", profile: sampleProfile, stop_reason: "end_turn" }));
  }),
];
