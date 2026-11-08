// Agent loop v2 mocks for the core pages, in the backend's shapes (origin/agent-loop-v2: src/api/notes.ts,
// src/api/tasks.ts, src/services/traces.ts; the find-run endpoint and notes_count / rating are the shapes asked of
// the backend). Sample data follows "Final · Finding leads", "Final · Research · Review queue / Lead detail" and
// "Final · Outreach · Tasks". leads.ts merges these leads and fields into its own sample data.
import { http } from "msw";
import type { Evidence, FindRun, Lead, LeadContact, LeadLink, LeadNote, NoteKind, RunStep, Task, Trace, WorkflowRun } from "../api.ts";
import { ago, body, DAY, fail, HOUR, isEmpty, MIN, noContent, ok, scenario } from "./util.ts";

// ---------- leads the find sample returns ----------

const base = (id: string, company: string, domain: string, extra: Partial<Lead>): Lead => ({
  id,
  email: null,
  name: null,
  title: null,
  company,
  domain,
  website: `https://${domain}`,
  linkedin_url: null,
  sells: null,
  best_customers: null,
  source: "apify",
  source_url: `https://${domain}`,
  consent_text: null,
  consent_at: null,
  has_consent: false,
  variant: "A",
  stage: "qualified",
  score: 80,
  qualified: true,
  rationale: null,
  review_question: null,
  reply_label: null,
  hubspot_id: null,
  contacts: [],
  links: [],
  created_at: ago(40 * MIN),
  updated_at: ago(30 * MIN),
  ...extra,
});

const li = (slug: string) => `https://www.linkedin.com/in/${slug}`;
const person = (name: string, title: string, src: string, more: Partial<LeadContact> = {}): LeadContact => ({
  name,
  title,
  linkedin_url: li(name.toLowerCase().replace(/[^a-z]+/g, "-")),
  x_url: null,
  github_url: null,
  source_url: src,
  ...more,
});
const links = (domain: string, kinds: ("linkedin" | "github" | "x")[]): LeadLink[] => [
  ...kinds.map((k) => ({
    kind: k,
    url: k === "linkedin" ? `https://www.linkedin.com/company/${domain.split(".")[0]}` : k === "github" ? `https://github.com/${domain.split(".")[0]}` : `https://x.com/${domain.split(".")[0]}`,
    source_url: `https://${domain}`,
  })),
  { kind: "website", url: `https://${domain}`, source_url: `https://${domain}` },
];

export const findSampleLeads: Lead[] = [
  base("lead_tandem", "Tandem Labs", "tandemlabs.dev", {
    name: "Priya Nair",
    title: "CEO",
    score: 88,
    why_summary:
      "Tandem Labs posted its first SDR role on Oct 28 [1], reporting to the CEO, Priya Nair, who is still the sales contact on their site [2]. A 24-person devtools team [2] that raised a $6M seed in August [3]. That matches your Founder-led devtools segment on size, industry and signal. Not a customer, competitor or existing lead.",
    contacts: [person("Priya Nair", "CEO, co-founder", "https://tandemlabs.dev/about", { x_url: "https://x.com/priyanair" })],
    links: links("tandemlabs.dev", ["linkedin", "github"]),
  }),
  base("lead_ledgerline", "Ledgerline", "ledgerline.com", {
    score: 84,
    why_summary:
      "Raised a $4M seed on Oct 12 [1] and is hiring a founding AE to take deals over from the two founders [2]. 31-person fintech team selling to finance teams, with no sales leader yet [3].",
    links: links("ledgerline.com", ["linkedin"]),
    created_at: ago(38 * MIN),
  }),
  base("lead_brightpath", "Brightpath Studio", "brightpath.studio", {
    score: 62,
    why_summary: "Posted a first SDR role on Oct 30 [1]. 18 people. Builds websites and apps for clients, so the agent wasn't sure it sells its own software [2].",
    created_at: ago(36 * MIN),
  }),
  base("lead_patchwork", "Patchwork", "patchwork.sh", {
    name: "Sam Ortiz",
    title: "Founder",
    score: 66,
    why_summary:
      "Founder Sam Ortiz wrote on Nov 2 that he does all outbound himself [1]. 12-person devtools company with an open-source core and no sales hires yet [2], so it may be early.",
    contacts: [person("Sam Ortiz", "Founder", "https://patchwork.sh/team", { x_url: "https://x.com/samortiz", github_url: "https://github.com/samortiz" })],
    links: links("patchwork.sh", ["github", "x"]),
    created_at: ago(35 * MIN),
  }),
  base("lead_kilnpay", "Kiln Payroll", "kilnpayroll.com", {
    name: "Mei Tanaka",
    title: "Head of Sales",
    score: 79,
    why_summary: "Hiring two AEs in Austin [1] after a $9M Series A [2].",
    contacts: [person("Mei Tanaka", "Head of Sales", "https://kilnpayroll.com/team")],
    created_at: ago(3 * DAY),
  }),
];

/** find_status of each lead in the sample run. */
const findStatus: Record<string, "created" | "known"> = { lead_kilnpay: "known" };

// ---------- extra fields for leads.ts's own sample (review queue, lead detail) ----------

export const leadPatches: Record<string, Partial<Lead>> = {
  lead_harbor: {
    score: 87,
    rationale:
      "Harbor Labs sells a billing API to usage-based SaaS companies [1], so it's B2B software. It's 34 people [2] and raised a $9M Series A in September [3], inside your seed to Series A range. On Oct 30 it posted a founding Account Executive role that takes deals over from the CEO [4]: the founder still runs sales and is hiring the first rep. Not a customer, competitor or HubSpot contact.",
    why_summary: "Hiring a founding AE to take deals over from the CEO [4], right after a $9M Series A [3]. 34 people selling a billing API to SaaS teams [1][2].",
    contacts: [
      person("Arjun Patel", "VP Revenue", "https://harborlabs.dev/team", { x_url: "https://x.com/arjunpatel" }),
      person("Lena Vogt", "CEO, co-founder", "https://harborlabs.dev/team", { x_url: "https://x.com/lenavogt" }),
      person("Tomás Rivera", "CTO, co-founder", "https://harborlabs.dev/team", { github_url: "https://github.com/trivera" }),
    ],
    links: links("harborlabs.dev", ["linkedin", "github", "x"]),
  },
  lead_tess: {
    stage: "needs_review",
    review_question: "unclear: stage",
    rationale:
      "Tessellate AI sells AI analytics to retail teams [1], so it's B2B software. It's 64 people [2] and is hiring two SDRs under its Head of Growth [4]. But it raised a $22M Series B on Nov 5 [3], past your seed to Series A range. Everything else fits.",
    contacts: [
      person("Dana Okafor", "Head of Growth", "https://tessellate.ai/about", { x_url: "https://x.com/danaokafor" }),
      person("Ravi Menon", "CEO, co-founder", "https://tessellate.ai/about", { x_url: "https://x.com/ravimenon" }),
    ],
    links: links("tessellate.ai", ["linkedin", "github", "x"]),
  },
  lead_juniper: { stage: "needs_review", review_question: "sources disagree: 40 vs 120 people" },
  lead_orbit: { stage: "needs_review", review_question: "stale: signal 94 days old" },
};

const ev = (leadId: string, i: number, claim: string, url: string, savedAgo: number): Evidence => ({ id: 1000 + i, lead_id: leadId, claim, source_url: url, created_at: ago(savedAgo), n: i });

export const evidenceFor: Record<string, Evidence[]> = {
  lead_tandem: [
    ev("lead_tandem", 1, "First SDR role, reporting to the CEO (job post Oct 28)", "https://jobs.lever.co/tandemlabs", 40 * MIN),
    ev("lead_tandem", 2, "24-person devtools team; the CEO is the sales contact", "https://tandemlabs.dev/about", 40 * MIN),
    ev("lead_tandem", 3, "Raised a $6M seed in August", "https://techcrunch.com/2026/08/19/tandem-labs-seed", 40 * MIN),
  ],
  lead_ledgerline: [
    ev("lead_ledgerline", 1, "Raised a $4M seed on Oct 12", "https://techcrunch.com/2026/10/12/ledgerline", 38 * MIN),
    ev("lead_ledgerline", 2, "Founding AE job post", "https://jobs.ashbyhq.com/ledgerline", 38 * MIN),
    ev("lead_ledgerline", 3, "31 people, no sales leader on the team page", "https://ledgerline.com/team", 38 * MIN),
  ],
  lead_brightpath: [
    ev("lead_brightpath", 1, "First SDR role posted Oct 30", "https://brightpath.studio/careers", 36 * MIN),
    ev("lead_brightpath", 2, "Builds websites and apps for clients", "https://brightpath.studio", 36 * MIN),
  ],
  lead_patchwork: [
    ev("lead_patchwork", 1, "Founder post: does all outbound himself (Nov 2)", "https://x.com/samortiz/status/1", 35 * MIN),
    ev("lead_patchwork", 2, "12 people, open-source core, no sales hires", "https://patchwork.sh/team", 35 * MIN),
  ],
  lead_kilnpay: [
    ev("lead_kilnpay", 1, "Two AE roles in Austin", "https://jobs.lever.co/kilnpayroll", 3 * DAY),
    ev("lead_kilnpay", 2, "$9M Series A", "https://techcrunch.com/2026/10/01/kiln-payroll", 3 * DAY),
  ],
  lead_harbor: [
    ev("lead_harbor", 1, "Product page", "https://harborlabs.dev", 1 * DAY),
    ev("lead_harbor", 2, "About page", "https://harborlabs.dev/about", 1 * DAY),
    ev("lead_harbor", 3, "Series A announcement", "https://techcrunch.com/2026/09/18/harbor-labs-series-a", 1 * DAY),
    ev("lead_harbor", 4, "Founding AE job post", "https://jobs.lever.co/harborlabs", 1 * DAY),
  ],
  lead_tess: [
    ev("lead_tess", 1, "Product page", "https://tessellate.ai", 1 * DAY),
    ev("lead_tess", 2, "About page", "https://tessellate.ai/about", 1 * DAY),
    ev("lead_tess", 3, "Series B announcement", "https://techcrunch.com/2026/11/05/tessellate-series-b", 1 * DAY),
    ev("lead_tess", 4, "SDR job posts", "https://jobs.ashbyhq.com/tessellate", 1 * DAY),
  ],
};

// ---------- notes (in memory) ----------

let noteSeq = 100;
const note = (leadId: string, author: string, kind: NoteKind, text: string, at: number): LeadNote => ({
  id: String(noteSeq++),
  lead_id: leadId,
  author,
  kind,
  body: text,
  created_at: ago(at),
  updated_at: ago(at),
});

let notesStore: Map<string, LeadNote[]> | null = null;
const notes = () =>
  (notesStore ??= new Map(
    isEmpty()
      ? []
      : [
          [
            "lead_tandem",
            [
              note("lead_tandem", "user:owner", "thumbs_up", "Good fit", 20 * MIN),
              note("lead_tandem", "agent:ses_tz9", "note", "Checked again: the SDR post is still open and there's no sales hire yet. Priya wrote on Nov 3 that she does every demo herself.", 1 * DAY),
              note("lead_tandem", "user:owner", "note", "Met Priya at the SF devtools meetup in October. Mention it in the opener.", 1 * DAY + HOUR),
            ],
          ],
          ["lead_ledgerline", [note("lead_ledgerline", "user:owner", "thumbs_up", "Good fit", 18 * MIN)]],
          ["lead_brightpath", [note("lead_brightpath", "user:owner", "thumbs_down", "Agency, not software.", 16 * MIN)]],
          ["lead_harbor", [note("lead_harbor", "user:owner", "note", "Met Arjun at the billing meetup in Austin. Mention it.", 1 * DAY)]],
          ["lead_tess", [note("lead_tess", "user:owner", "note", "Dana ran growth at a seed company before. Worth a note even if Out.", 1 * DAY)]],
        ],
  ));

export const notesFor = (leadId: string) => notes().get(leadId) ?? [];

/** notes_count and rating, as asked of GET /api/leads. */
export function listExtras(leadId: string): Pick<Lead, "notes_count" | "rating"> {
  const list = notesFor(leadId);
  const rated = list.find((n) => n.kind === "thumbs_up" || n.kind === "thumbs_down");
  return { notes_count: list.length, rating: rated ? (rated.kind === "thumbs_up" ? "up" : "down") : null };
}

// ---------- stage changes and exclusions (in memory, applied by leads.ts) ----------

export const leadOverrides = new Map<string, Partial<Lead>>();

// ---------- find runs ----------

const findRuns = new Map<string, { started_at: string; like?: string }>();

function findRun(sessionId: string): FindRun {
  const started = findRuns.get(sessionId)?.started_at ?? ago(45 * MIN);
  const fresh = findRuns.has(sessionId);
  return {
    run: {
      id: sessionId,
      workflow_id: "find_leads",
      name: "Find leads",
      purpose: "find_leads",
      status: fresh ? "running" : "done",
      stop_reason: fresh ? null : "end_turn",
      lead_id: null,
      input: { count: 5 },
      started_at: started,
      updated_at: ago(2 * MIN),
      last_event_at: ago(2 * MIN),
      leads_processed: findSampleLeads.length,
      cost_usd: 0.38,
      cost_credits: 76,
    },
    leads: findSampleLeads.map((l) => ({ ...l, ...leadOverrides.get(l.id), ...listExtras(l.id), find_status: findStatus[l.id] ?? "created" })),
  };
}

// ---------- manual tasks ----------

const taskLead = (l: Partial<Task["lead"]> & { id: string }): Task["lead"] => ({
  name: null,
  title: null,
  company: null,
  domain: null,
  website: null,
  linkedin_url: null,
  email: null,
  stage: "qualified",
  score: 80,
  has_consent: false,
  ...l,
});

let taskStore: Task[] | null = null;
const seedTasks = (): Task[] => [
  {
    id: "drf_task_harbor",
    lead_id: "lead_harbor",
    version: 1,
    channel: "linkedin",
    status: "open",
    subject: "LinkedIn note to Arjun Patel (Harbor Labs)",
    body: "Hi Arjun, saw Harbor Labs moved to usage-based pricing this month. Pricing changes usually mean a lot of founder-led calls. I'm building Fieldnote, which writes those calls up into HubSpot. Happy to share what we see across early teams.",
    target_url: li("arjun-patel"),
    open_url: li("arjun-patel"),
    citations: [{ text: "moved to usage-based pricing this month", source_url: "https://harborlabs.dev/pricing" }],
    created_at: ago(50 * MIN),
    closed_at: null,
    lead: taskLead({ id: "lead_harbor", name: "Arjun Patel", title: "VP Revenue", company: "Harbor Labs", domain: "harborlabs.dev", linkedin_url: li("arjun-patel"), score: 87 }),
  },
  {
    id: "drf_task_tandem",
    lead_id: "lead_tandem",
    version: 1,
    channel: "intro",
    status: "open",
    subject: "Warm intro to Priya Nair (Tandem Labs)",
    body: "Priya runs sales herself at Tandem Labs (24 people, hiring a first SDR). Fieldnote writes up founder calls into the CRM; worth 15 minutes?",
    target_url: null,
    open_url: null,
    citations: [{ text: "hiring a first SDR", source_url: "https://jobs.lever.co/tandemlabs" }],
    created_at: ago(45 * MIN),
    closed_at: null,
    lead: taskLead({ id: "lead_tandem", name: "Priya Nair", title: "CEO", company: "Tandem Labs", domain: "tandemlabs.dev", score: 88 }),
  },
  {
    id: "drf_task_patch",
    lead_id: "lead_patchwork",
    version: 1,
    channel: "x",
    status: "open",
    subject: "X message to Sam Ortiz (Patchwork)",
    body: "Saw your post about doing all of Patchwork's outbound yourself. Fieldnote turns those calls into CRM notes so you don't have to.",
    target_url: "https://x.com/samortiz",
    open_url: "https://x.com/samortiz",
    citations: [{ text: "doing all of Patchwork's outbound yourself", source_url: "https://x.com/samortiz/status/1" }],
    created_at: ago(40 * MIN),
    closed_at: null,
    lead: taskLead({ id: "lead_patchwork", name: "Sam Ortiz", title: "Founder", company: "Patchwork", domain: "patchwork.sh", score: 66 }),
  },
  {
    id: "drf_task_kiln",
    lead_id: "lead_kilnpay",
    version: 2,
    channel: "linkedin",
    status: "open",
    subject: "LinkedIn note to Mei Tanaka (Kiln Payroll)",
    body: "Hi Mei, congrats on the Series A and the two new AE roles in Austin. When new reps take over calls, notes are the first thing to slip; Fieldnote writes them up for you.",
    target_url: li("mei-tanaka"),
    open_url: li("mei-tanaka"),
    citations: [
      { text: "the Series A", source_url: "https://techcrunch.com/2026/10/01/kiln-payroll" },
      { text: "the two new AE roles in Austin", source_url: "https://jobs.lever.co/kilnpayroll" },
    ],
    created_at: ago(35 * MIN),
    closed_at: null,
    lead: taskLead({ id: "lead_kilnpay", name: "Mei Tanaka", title: "Head of Sales", company: "Kiln Payroll", domain: "kilnpayroll.com", score: 79 }),
  },
  {
    id: "drf_task_ledger",
    lead_id: "lead_ledgerline",
    version: 1,
    channel: "email_manual",
    status: "open",
    subject: "Your founding AE",
    body: "Hi there, saw Ledgerline is hiring a founding AE after the seed. Fieldnote keeps founder call notes in the CRM so the new AE starts with context. Worth a look?",
    target_url: null,
    open_url: null,
    citations: [{ text: "hiring a founding AE", source_url: "https://jobs.ashbyhq.com/ledgerline" }],
    created_at: ago(30 * MIN),
    closed_at: null,
    lead: taskLead({ id: "lead_ledgerline", company: "Ledgerline", domain: "ledgerline.com", score: 84 }),
  },
  {
    id: "drf_task_parcel",
    lead_id: "lead_parcel",
    version: 1,
    channel: "linkedin",
    status: "sent",
    subject: "LinkedIn note to Leo Martins (Parcel & Pine)",
    body: "Hi Leo, congrats on the EU fulfillment expansion.",
    target_url: li("leo-martins"),
    open_url: li("leo-martins"),
    citations: [],
    created_at: ago(3 * DAY),
    closed_at: ago(2 * DAY + 5 * HOUR),
    lead: taskLead({ id: "lead_parcel", name: "Leo Martins", title: "COO", company: "Parcel & Pine", domain: "parcelandpine.com", stage: "sent", score: 75 }),
  },
];
const tasks = () => (taskStore ??= isEmpty() ? [] : seedTasks());

// ---------- trace ----------

function trace(sessionId: string): Trace {
  const t0 = Date.now() - 30 * MIN;
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  const events = [
    { seq: 1, type: "user.message", data: { text: "Research lead lead_tess against the Company summary. Save evidence with sources, then score it." }, created_at: at(0) },
    { seq: 2, type: "agent.tool_use", data: { name: "read_website", args: { url: "https://tessellate.ai", max_pages: 2 } }, created_at: at(4) },
    { seq: 3, type: "agent.tool_result", data: { name: "read_website", output: "2 pages: AI analytics for retail teams; About: 64 people" }, created_at: at(9) },
    { seq: 4, type: "agent.tool_use", data: { name: "search_web", args: { query: "Tessellate AI funding" } }, created_at: at(12) },
    { seq: 5, type: "agent.tool_result", data: { name: "search_web", output: "2 results" }, created_at: at(15) },
    { seq: 6, type: "agent.tool_use", data: { name: "save_research", args: { lead_id: "lead_tess", evidence: 4, score: 81, qualified: null } }, created_at: at(44) },
    { seq: 7, type: "agent.message", data: { text: "Scored 81 with stage unclear (Series B), so I sent it for review instead of drafting." }, created_at: at(52) },
    { seq: 8, type: "session.status_idle", data: { stop_reason: "end_turn" }, created_at: at(52) },
  ];
  return {
    run: {
      id: sessionId,
      workflow_id: "research",
      name: "Lead research",
      purpose: "research",
      status: "done",
      stop_reason: "end_turn",
      lead_id: "lead_tess",
      input: {},
      started_at: at(0),
      updated_at: at(52),
      last_event_at: at(52),
      leads_processed: 1,
      cost_usd: 0.31,
      cost_credits: 62,
    },
    events,
    has_more: false,
    next_after_seq: null,
    audit: [{ id: "9001", lead_id: "lead_tess", kind: "lead_scored", data: { score: 81, session_id: sessionId }, created_at: at(44) }],
    approvals: [],
    spend: { naive_usd: 0.31, credits_debited: 62, credits: 62, apify_runs: [{ run_id: "apr_1", actor: "apify/web-search", status: "SUCCEEDED", usage_usd: 0.005 }] },
    retention_days: 180,
    sync: { ok: true, complete: true },
  };
}

// ---------- research runs on the review queue and lead detail ("What the agent did") ----------

const researchRuns: Record<string, { lead: string; cost: number; lines: [string, string | undefined, string][] }> = {
  ses_tz5: {
    lead: "lead_tess",
    cost: 0.31,
    lines: [
      ["tool", "read_website", "Read tessellate.ai and /about: AI analytics, 64 people"],
      ["tool", "search_web", 'Searched "Tessellate AI funding": 2 results, 1 read'],
      ["tool", "save_research", "Saved 4 facts, each with a quote and source"],
      ["crusonia", undefined, "Scored 81 with stage unclear, so it sent the lead here instead of drafting"],
    ],
  },
  ses_hb2: {
    lead: "lead_harbor",
    cost: 0.27,
    lines: [
      ["tool", "read_website", "Read harborlabs.dev and /about: billing API, 34 people"],
      ["tool", "search_web", 'Searched "Harbor Labs Series A": 3 results, 1 read'],
      ["tool", "save_research", "Saved 4 facts, each with a quote and source"],
      ["crusonia", undefined, "Scored 87: fits on size, stage and signal"],
      ["tool", "create_draft", "Drafted a LinkedIn note for Arjun Patel, citing 2 sources"],
    ],
  },
};

function researchRun(id: string): WorkflowRun | undefined {
  const r = researchRuns[id];
  if (!r) return undefined;
  const start = Date.now() - 30 * MIN;
  const at = (s: number) => new Date(start + s * 1000).toISOString();
  const lead = findSampleLeads.find((l) => l.id === r.lead);
  return {
    run: {
      id,
      workflow_id: "research",
      name: "Lead research",
      purpose: "research",
      status: "done",
      stop_reason: "end_turn",
      lead_id: r.lead,
      input: {},
      started_at: at(0),
      updated_at: at(52),
      last_event_at: at(52),
      leads_processed: 1,
      cost_usd: r.cost,
      cost_credits: r.cost === null || r.cost === undefined ? null : Math.ceil(r.cost * 200),
    },
    steps: r.lines.map(([type, tool, summary], i): RunStep => ({ seq: i + 1, type, ...(tool ? { tool } : {}), summary, started_at: at(i * 14), source: type === "crusonia" ? "crusonia" : "naive" })),
    lead: lead ? { id: lead.id, email: null, name: lead.name, title: lead.title, company: lead.company, domain: lead.domain, stage: lead.stage, score: lead.score, qualified: lead.qualified, has_consent: false } : null,
    approvals: [],
    sync: { ok: true, skipped: "cache is current" },
  };
}

// ---------- handlers ----------

const unshipped = () => scenario() === "unconfigured";
const missing = (method: string, path: string) => fail(404, "not_found", `No route for ${method} ${path}`);
const allLeadIds = () => new Set([...findSampleLeads.map((l) => l.id), ...Object.keys(leadPatches), "lead_fieldnote", "lead_quill", "lead_lumen", "lead_northwind", "lead_kiln", "lead_parcel", "lead_cobalt", "lead_mosaic", "lead_bright", "lead_cinder"]);

export const coreLeadHandlers = [
  // Find runs (shape asked of the backend). Registered before leads.ts so these win.
  http.post("/api/leads/find", async ({ request }) => {
    if (scenario() !== "sample") return fail(503, "not_configured", "The Naive agent is not configured: NAIVE_AGENT_ID is not set");
    const b = await body<{ count?: number; like_lead_id?: string }>(request);
    const id = `ses_find_${Date.now()}`;
    findRuns.set(id, { started_at: new Date().toISOString(), like: b.like_lead_id });
    return ok({ session_id: id }, 202);
  }),
  http.get("/api/leads/find/:id", ({ params }) => (unshipped() ? missing("GET", "/api/leads/find/:id") : isEmpty() ? fail(404, "not_found", "No find run") : ok(findRun(String(params.id))))),

  // Notes
  http.get("/api/leads/:id/notes", ({ params }) => ok({ data: notesFor(String(params.id)) })),
  http.post("/api/leads/:id/notes", async ({ params, request }) => {
    const id = String(params.id);
    if (!allLeadIds().has(id)) return fail(404, "not_found", `No lead with id ${id}.`);
    const b = await body<{ body?: string; kind?: NoteKind }>(request);
    if (!b.body?.trim()) return fail(400, "invalid_request", "body: Too small: expected string to have >=1 characters");
    const n = note(id, "user:owner", b.kind ?? "note", b.body.trim(), 0);
    notes().set(id, [n, ...notesFor(id)]);
    return ok({ note: n }, 201);
  }),
  http.patch("/api/leads/:id/notes/:noteId", async ({ params, request }) => {
    const list = notesFor(String(params.id));
    const n = list.find((x) => x.id === params.noteId);
    if (!n) return fail(404, "not_found", `No note ${String(params.noteId)}`);
    if (!n.author.startsWith("user:")) return fail(400, "invalid", "Only the note's author can edit or delete it.");
    n.body = (await body<{ body: string }>(request)).body;
    n.updated_at = new Date().toISOString();
    return ok({ note: n });
  }),
  http.delete("/api/leads/:id/notes/:noteId", ({ params }) => {
    const id = String(params.id);
    notes().set(
      id,
      notesFor(id).filter((x) => x.id !== params.noteId),
    );
    return noContent();
  }),
  http.post("/api/leads/:id/exclude", async ({ params, request }) => {
    const id = String(params.id);
    const { reason } = await body<{ reason?: string }>(request);
    leadOverrides.set(id, { ...leadOverrides.get(id), excluded_at: new Date().toISOString(), excluded_reason: reason ?? null });
    return ok({ lead: { id, excluded_at: new Date().toISOString() } });
  }),
  http.delete("/api/leads/:id/exclude", ({ params }) => {
    const id = String(params.id);
    leadOverrides.set(id, { ...leadOverrides.get(id), excluded_at: null, excluded_reason: null });
    return ok({ lead: { id, excluded_at: null } });
  }),

  // Stage changes stick (Confirm fit / Not a fit in the review queue, task outcomes).
  http.patch("/api/leads/:id", async ({ params, request }) => {
    const id = String(params.id);
    const patch = await body<Partial<Lead>>(request);
    leadOverrides.set(id, { ...leadOverrides.get(id), ...patch, ...(patch.stage && patch.stage !== "needs_review" ? { review_question: null } : {}) });
    return undefined; // leads.ts answers with the merged lead
  }),

  http.post("/api/workflows/research", async ({ request }) => {
    if (scenario() !== "sample") return fail(503, "not_configured", "NAIVE_AGENT_ID is not set");
    const { lead_ids = [] } = await body<{ lead_ids?: string[] }>(request);
    for (const id of lead_ids) leadOverrides.set(id, { ...leadOverrides.get(id), stage: "researching" });
    return ok({ started: lead_ids.map((lead_id) => ({ lead_id, session_id: `ses_rr_${Date.now()}` })), skipped: [] }, 202);
  }),

  // Manual tasks
  http.get("/api/tasks", ({ request }) => {
    if (unshipped()) return missing("GET", "/api/tasks");
    const status = new URL(request.url).searchParams.get("status") ?? "open";
    const data = tasks().filter((t) => status === "all" || t.status === status);
    return ok({ data, open_total: tasks().filter((t) => t.status === "open").length });
  }),
  http.post("/api/tasks/:id/sent", async ({ params }) => {
    const t = tasks().find((x) => x.id === params.id);
    if (!t) return fail(404, "not_found", `No manual task with id ${String(params.id)}.`);
    if (t.status !== "open") return fail(409, "conflict", `Task ${t.id} is ${t.status}, not open.`);
    Object.assign(t, { status: "sent", closed_at: new Date().toISOString() });
    t.lead.stage = "sent";
    leadOverrides.set(t.lead_id, { ...leadOverrides.get(t.lead_id), stage: "sent" });
    return ok({ task: t, lead_stage: "sent", message_id: String(Date.now()) });
  }),
  http.post("/api/tasks/:id/skip", ({ params }) => {
    const t = tasks().find((x) => x.id === params.id);
    if (!t) return fail(404, "not_found", `No manual task with id ${String(params.id)}.`);
    if (t.status !== "open") return fail(409, "conflict", `Task ${t.id} is ${t.status}, not open.`);
    Object.assign(t, { status: "skipped", closed_at: new Date().toISOString() });
    return ok({ task: t });
  }),

  // Run detail for the research runs above; any other run falls through to workflows.ts.
  http.get("/api/workflows/runs/:id", ({ params }) => {
    const run = isEmpty() ? undefined : researchRun(String(params.id));
    return run ? ok(run) : undefined;
  }),

  // Full trace
  http.get("/api/workflows/runs/:id/trace", ({ params }) => (unshipped() ? missing("GET", "/api/workflows/runs/:id/trace") : ok(trace(String(params.id))))),
  http.get("/api/workflows/runs/:id/trace/export", ({ params }) => ok(trace(String(params.id)))),
];

export const openTasksFor = (leadId: string) => tasks().filter((t) => t.lead_id === leadId && t.status === "open");
