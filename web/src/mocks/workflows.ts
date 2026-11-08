// /api/workflows, /api/workflows/runs/:id and /api/replies mocks ("Dashboard · Workflows", "Workflow run").
import { http } from "msw";
import type { Reply, RunStep, Workflow, WorkflowRun } from "../api.ts";
import { sampleApprovals } from "./approvals.ts";
import { sampleLeads } from "./leads.ts";
import { ago, DAY, fail, HOUR, isEmpty, MIN, ok } from "./util.ts";

export const sampleWorkflows: Workflow[] = [
  { id: "ses_8f3k21", name: "Hiring-signal sweep", purpose: "research", status: "running", started_at: ago(4 * DAY), leads_processed: 486, cost_usd: 31.75, last_event_at: ago(6 * MIN) },
  { id: "ses_lk7", name: "Lookalikes of closed-won", purpose: "research", status: "running", started_at: ago(2 * DAY), leads_processed: 1120, cost_usd: 64.1, last_event_at: ago(1 * MIN) },
  { id: "ses_in3", name: "Qualify inbound sign-ups", purpose: "qualify", status: "idle", started_at: ago(6 * DAY), leads_processed: 214, cost_usd: 18.42, last_event_at: ago(2 * MIN) },
  { id: "ses_dv2", name: "DevTools Summit follow-up", purpose: "research", status: "error", started_at: ago(9 * DAY), leads_processed: 318, cost_usd: 50, last_event_at: ago(1 * DAY) },
  { id: "ses_cl2", name: "Re-engage closed-lost (Q3)", purpose: "research", status: "paused", started_at: ago(12 * DAY), leads_processed: 0, cost_usd: 0, last_event_at: ago(3 * DAY) },
  { id: "ses_wb1", name: "Churned-customer win-back", purpose: "research", status: "done", started_at: ago(1 * DAY), leads_processed: 5, cost_usd: 0.4, last_event_at: ago(1 * DAY) },
];

export const workflowsData = () => (isEmpty() ? [] : sampleWorkflows);

const step = (seq: number, tool: string, type: string, summary: string, startedAgo: number, duration_ms: number | null, cost_usd: number | null, input: unknown = null, output: unknown = null): RunStep => ({
  seq,
  type,
  tool,
  summary,
  started_at: ago(startedAgo),
  duration_ms,
  cost_usd,
  input,
  output,
});

const fieldnoteRun = (): WorkflowRun => ({
  run: { ...sampleWorkflows[0]!, status: "idle", started_at: ago(6 * MIN + 48_000), lead_id: "lead_fieldnote", stop_reason: "requires_action", budget_usd: 1 },
  steps: [
    step(1, "read_website", "external", "Crawled fieldnote.io, 14 pages", 6 * MIN + 48_000, 6800, 0.06, { url: "https://fieldnote.io" }, { pages: 14 }),
    step(2, "search_web", "external", "“Fieldnote” hiring AE · 9 results", 6 * MIN + 41_000, 1900, 0.02, { query: "Fieldnote hiring AE" }, { results: 9 }),
    step(3, "save_evidence", "mcp", "Hiring 3 AEs in Austin", 6 * MIN + 39_000, 120, 0, { lead_id: "lead_fieldnote", claim: "Hiring 3 AEs in Austin", source_url: "https://fieldnote.io/careers" }, { id: 31 }),
    step(4, "save_evidence", "mcp", "$14M Series A, Oct 15", 6 * MIN + 38_800, 110, 0, { lead_id: "lead_fieldnote", claim: "$14M Series A, Oct 15", source_url: "https://fieldnote.io/blog" }, { id: 32 }),
    step(5, "save_evidence", "mcp", "Maya Chen, Head of Sales", 6 * MIN + 38_600, 100, 0, { lead_id: "lead_fieldnote", claim: "Maya Chen, Head of Sales", source_url: "https://fieldnote.io/team" }, { id: 33 }),
    step(6, "score_lead", "mcp", "Strong fit, above the 80 threshold", 6 * MIN + 36_000, 2400, 0.05, { lead: "fieldnote.io", icp: "series-a-devtools", evidence: ["ev_31a", "ev_31b", "ev_31c"] }, { score: 92, fit: "strong", reasons: ["hiring AEs", "Series A", "new sales lead"] }),
    step(7, "create_draft", "mcp", "Draft v2, variant B · v1 had an uncited claim", 6 * MIN + 27_000, 8600, 0.18, { lead_id: "lead_fieldnote", variant: "B" }, { draft_id: "drf_fn_2", version: 2 }),
    step(8, "request_approval", "human", "Code A7F2 for maya@fieldnote.io · v2", 6 * MIN, null, null, { code: "A7F2" }, null),
  ],
  lead: sampleLeads[0]!,
  approvals: sampleApprovals.filter((a) => a.code === "A7F2").map(({ draft: _d, lead: _l, ...a }) => a),
});

export const sampleReplies: Reply[] = [
  { id: 1, lead_id: "lead_northwind", from: "tom@northwindrobotics.com", subject: "Re: 4 SDR openings", preview: "Thursday 2pm works. Send the invite to me and our RevOps lead.", label: "meeting", received_at: ago(1 * DAY), lead_name: "Tom Becker", company: "Northwind Robotics" },
  { id: 2, lead_id: "lead_kiln", from: "hana@kilnstudio.co", subject: "Re: your relaunch", preview: "Could you share pricing for a 10-person team?", label: "interested", received_at: ago(3 * HOUR), lead_name: "Hana Sato", company: "Kiln Studio" },
  { id: 3, lead_id: "lead_cobalt", from: "priya@cobaltfern.com", subject: "Re: rebuilding the SDR team", preview: "Not this quarter. Try me again in January.", label: "not_interested", received_at: ago(3 * DAY), lead_name: "Priya Raman", company: "Cobalt Fern" },
  { id: 4, lead_id: "lead_mosaic", from: "owen@mosaicgrid.io", subject: "unsubscribe", preview: "Please remove me from your list.", label: "unsubscribe", received_at: ago(4 * DAY + 2 * HOUR), lead_name: "Owen Hart", company: "Mosaic Grid" },
];

export const repliesData = () => (isEmpty() ? [] : sampleReplies);

export const workflowHandlers = [
  http.get("/api/workflows", () => ok(workflowsData())),
  http.get("/api/workflows/runs/:id", ({ params }) => {
    if (isEmpty()) return fail(404, "not_found", "Run not found");
    if (params.id === "ses_8f3k21") return ok(fieldnoteRun());
    const wf = sampleWorkflows.find((w) => w.id === params.id);
    return wf ? ok({ run: wf, steps: [], lead: null, approvals: [] }) : fail(404, "not_found", "Run not found");
  }),
  http.post("/api/workflows/research", () => fail(503, "not_configured", "NAIVE_AGENT_ID is not set")),
  http.get("/api/replies", () => ok(repliesData())),
];

