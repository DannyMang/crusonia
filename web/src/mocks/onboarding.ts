// /api/profile and /api/onboarding/* mocks ("Onboarding · 1-4"). Proposals finish after a few polls.
import { http } from "msw";
import type { Profile } from "../api.ts";
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
    { field: "icp_description", url: "https://fieldnote.io/customers" },
    { field: "segments.0", url: "https://fieldnote.io/customers" },
    { field: "segments.1", url: "https://fieldnote.io/customers" },
    { field: "segments.2", url: "https://fieldnote.io/blog/founder-led-sales" },
    { field: "signals.0", url: "https://fieldnote.io/blog/founder-led-sales" },
    { field: "signals.1", url: "https://fieldnote.io/customers" },
    { field: "signals.2", url: "https://fieldnote.io/" },
  ],
};

let saved: Profile | null = null;
const polls = new Map<string, number>();

export const onboardingHandlers = [
  http.get("/api/profile", () => ok(saved ?? (isEmpty() ? null : sampleProfile))),
  http.put("/api/profile", async ({ request }) => {
    saved = await body<Profile>(request);
    return ok(saved);
  }),
  http.post("/api/onboarding/read-website", async ({ request }) => {
    if (scenario() === "unconfigured") return fail(503, "not_configured", "APIFY_TOKEN is not set");
    const { url } = await body<{ url?: string }>(request);
    const host = (url ?? "fieldnote.io").replace(/^https?:\/\//, "").replace(/\/$/, "");
    const pages = [
      ["", "Product and headline"],
      ["/pricing", "3 plans, from $29 a seat"],
      ["/customers", "38 logos, 6 case studies"],
      ["/about", "Team of 14, seed-funded"],
      ["/blog/founder-led-sales", "Who you write for"],
      ["/careers", "Hiring a founding AE"],
      ["/changelog", "Weekly releases"],
    ].map(([path, title]) => ({ url: `https://${host}${path}`, title: title!, text: `${title}. Sample page text for ${host}${path}.` }));
    return ok({ pages });
  }),
  http.post("/api/onboarding/propose", () => {
    if (scenario() === "unconfigured") return fail(503, "not_configured", "NAIVE_AGENT_ID is not set");
    const id = `ses_prop_${Date.now()}`;
    polls.set(id, 0);
    return ok({ session_id: id }, 202);
  }),
  http.get("/api/onboarding/propose/:id", ({ params }) => {
    const n = (polls.get(String(params.id)) ?? 0) + 1;
    polls.set(String(params.id), n);
    return n < 4 ? ok({ status: "running" }) : ok({ status: "done", profile: sampleProfile });
  }),
];
