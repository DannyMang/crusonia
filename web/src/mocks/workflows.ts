// /api/workflows, /api/workflows/runs/:id and /api/replies mocks ("Dashboard · Workflows", "Workflow run").
// Shapes follow the backend: a workflow is one purpose (research, find_leads, onboarding) with its recent runs;
// a run is one Naive session and its steps are Naive events merged with Crusonia's own audit events.
import { http } from "msw";
import type { Reply, Run, RunApproval, RunLead, RunStatus, RunStep, Workflow, WorkflowRun } from "../api.ts";
import { approvalsData } from "./approvals.ts";
import { sampleLeads } from "./leads.ts";
import { ago, DAY, fail, HOUR, isEmpty, MIN, ok } from "./util.ts";

// ---------- runs ----------

type RunSeed = [id: string, purpose: string, status: RunStatus, stop: string | null, leadId: string | null, startedAgo: number, lastAgo: number, leads: number, cost: number | null, input?: Record<string, unknown>];

const NAMES: Record<string, string> = { research: "Lead research", find_leads: "Find leads", onboarding: "Onboarding profile" };

const runSeeds: RunSeed[] = [
  ["ses_lk7", "research", "running", null, "lead_lumen", 3 * MIN + 20_000, 20_000, 1, 0.12],
  ["ses_ob4", "research", "idle", "awaiting_answer", "lead_orbit", 40 * MIN, 9 * MIN, 1, 0.22],
  ["ses_in3", "research", "idle", "awaiting_approval", "lead_juniper", 22 * MIN, 12 * MIN, 1, 0.09],
  ["ses_8f3k21", "research", "done", "end_turn", "lead_fieldnote", 6 * MIN + 48_000, 6 * MIN, 1, 0.31],
  ["ses_hb2", "research", "done", "end_turn", "lead_harbor", 31 * MIN, 21 * MIN, 1, 0.27],
  ["ses_qs3", "research", "done", "end_turn", "lead_quill", 27 * MIN, 17 * MIN, 1, 0.24],
  ["ses_tz5", "research", "done", "end_turn", "lead_tess", 29 * MIN, 1 * MIN, 1, 0.29],
  ["ses_er9", "research", "error", "max_iterations", "lead_parcel", 2 * DAY + 3 * HOUR, 2 * DAY + 2 * HOUR, 1, 0.84],
  ["ses_fl3", "find_leads", "paused", "budget_paused", null, 5 * HOUR, 4 * HOUR + 40 * MIN, 9, 1.5, { count: 25 }],
  ["ses_fl1", "find_leads", "done", "end_turn", null, 2 * DAY, 2 * DAY - 14 * MIN, 23, 1.12, { count: 25 }],
  ["ses_on1", "onboarding", "done", "end_turn", null, 3 * DAY, 3 * DAY - 3 * MIN, 0, 0.08, { url: "https://acme.com" }],
];

const toRun = ([id, purpose, status, stop, leadId, startedAgo, lastAgo, leads, cost, input]: RunSeed): Run => ({
  id,
  workflow_id: purpose,
  name: NAMES[purpose] ?? purpose,
  purpose,
  status,
  stop_reason: stop,
  lead_id: leadId,
  input: input ?? {},
  started_at: ago(startedAgo),
  updated_at: ago(lastAgo),
  last_event_at: ago(lastAgo),
  leads_processed: leads,
  cost_usd: cost,
  cost_credits: cost === null ? null : Math.ceil(cost * 200),
});

const sampleRuns: Run[] = runSeeds.map(toRun);

/** One row per purpose, like listWorkflows(): status from the runs, totals over every run of that purpose. */
function toWorkflow(purpose: string, extra: { run_count: number; leads: number; cost: number }): Workflow {
  const runs = sampleRuns.filter((r) => r.purpose === purpose);
  const running = runs.filter((r) => r.status === "running").length;
  const idle = runs.filter((r) => r.status === "idle").length;
  const paused = runs.filter((r) => r.status === "paused").length;
  const status: RunStatus = paused ? "paused" : running ? "running" : idle ? "idle" : runs[0]?.status === "error" ? "error" : "done";
  return {
    id: purpose,
    name: NAMES[purpose] ?? purpose,
    purpose,
    status,
    started_at: runs[0]!.started_at,
    first_started_at: ago(12 * DAY),
    last_event_at: runs.map((r) => r.last_event_at).sort().at(-1) ?? null,
    leads_processed: extra.leads,
    cost_usd: extra.cost,
    cost_credits: extra.cost === null || extra.cost === undefined ? null : Math.ceil(extra.cost * 200),
    run_count: extra.run_count,
    active_runs: running + idle + paused,
    runs,
  };
}

export const sampleWorkflows: Workflow[] = [
  toWorkflow("research", { run_count: 46, leads: 46, cost: 11.87 }),
  toWorkflow("find_leads", { run_count: 4, leads: 81, cost: 5.42 }),
  toWorkflow("onboarding", { run_count: 1, leads: 0, cost: 0.08 }),
];

export const workflowsData = () => (isEmpty() ? [] : sampleWorkflows);

// ---------- run detail ----------

/** `at` = milliseconds after the run started. */
function steps(startedAgo: number, rows: [type: string, tool: string | undefined, summary: string, at: number, ms?: number, cost?: number, input?: unknown, output?: unknown, extra?: Partial<RunStep>][]): RunStep[] {
  return rows.map(([type, tool, summary, at, ms, cost, input, output, extra], i) => ({
    seq: i + 1,
    type,
    ...(tool ? { tool } : {}),
    summary,
    started_at: ago(startedAgo - at),
    ...(ms !== undefined ? { duration_ms: ms } : {}),
    ...(cost !== undefined ? { cost_usd: cost, cost_credits: cost * 200 } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    source: type === "crusonia" ? "crusonia" : "naive",
    ...(type === "crusonia" ? {} : { naive_seq: i * 3 + 1 }),
    ...extra,
  }));
}

const MODEL = "claude-sonnet-4-5";

const STEPS: Record<string, () => RunStep[]> = {
  ses_8f3k21: () =>
    steps(6 * MIN + 48_000, [
      ["crusonia", undefined, "Research started", 0],
      ["model", undefined, `${MODEL}: 9,812 tokens`, 400, 3100, 0.04],
      ["tool", "read_website", "read_website: https://fieldnote.io", 3_600, 6800, undefined, { url: "https://fieldnote.io", max_pages: 20 }, { pages: 14, urls: ["https://fieldnote.io/", "https://fieldnote.io/careers", "https://fieldnote.io/blog/series-a"] }],
      ["tool", "search_web", "search_web: Fieldnote hiring AE", 10_600, 1900, undefined, { query: "Fieldnote hiring AE" }, { results: 9 }],
      ["tool", "save_evidence", "save_evidence: Hiring 3 AEs in Austin", 12_700, 120, undefined, { lead_id: "lead_fieldnote", claim: "Hiring 3 AEs in Austin", source_url: "https://fieldnote.io/careers" }, { id: 31 }],
      ["tool", "save_evidence", "save_evidence: $14M Series A, Oct 15", 12_900, 110, undefined, { lead_id: "lead_fieldnote", claim: "$14M Series A, Oct 15", source_url: "https://fieldnote.io/blog/series-a" }, { id: 32 }],
      ["tool", "save_evidence", "save_evidence: Maya Chen, Head of Sales", 13_100, 100, undefined, { lead_id: "lead_fieldnote", claim: "Maya Chen, Head of Sales", source_url: "https://fieldnote.io/team" }, { id: 33 }],
      ["model", undefined, `${MODEL}: 14,230 tokens`, 13_400, 4200, 0.07],
      ["tool", "score_lead", "score_lead: lead_fieldnote", 17_800, 2400, undefined, { lead_id: "lead_fieldnote", score: 92, rationale: "Hiring first SDR · Series A $14M" }, { score: 92, qualified: true }],
      ["model", undefined, `${MODEL}: 18,904 tokens`, 20_400, 9800, 0.2],
      ["tool", "create_draft", "create_draft: lead_fieldnote", 30_400, 8600, undefined, { lead_id: "lead_fieldnote", subject: "Your first SDR at Fieldnote" }, { draft_id: "drf_a7f2", version: 2, approval_code: "A7F2" }],
      ["crusonia", undefined, "Approval A7F2 requested", 39_100],
      ["status", undefined, "Finished", 48_000],
    ]),
  ses_lk7: () =>
    steps(3 * MIN + 20_000, [
      ["crusonia", undefined, "Research started", 0],
      ["model", undefined, `${MODEL}: 8,410 tokens`, 300, 2800, 0.03],
      ["tool", "read_website", "read_website: https://lumenhealth.com", 3_200, 5200, undefined, { url: "https://lumenhealth.com" }, { pages: 9 }],
      ["tool", "search_web", "search_web: Lumen Health RevOps hiring", 9_000, 2100, undefined, { query: "Lumen Health RevOps hiring" }, { results: 6 }],
      ["tool", "save_evidence", "save_evidence: Replacing their outbound tool", 11_500, 130, undefined, { lead_id: "lead_lumen", claim: "Replacing their outbound tool", source_url: "https://lumenhealth.com/careers/revops" }, { id: 41 }],
      ["model", undefined, `${MODEL}: 12,960 tokens`, 12_000, 5100, 0.09],
      ["tool", "score_lead", "score_lead: lead_lumen", 17_500, undefined, undefined, { lead_id: "lead_lumen", score: 78 }],
    ]),
  ses_in3: () =>
    steps(22 * MIN, [
      ["crusonia", undefined, "Research started", 0],
      ["model", undefined, `${MODEL}: 7,220 tokens`, 300, 2600, 0.03],
      ["tool", "search_web", "search_web: Juniper Freight BDR Denver", 3_100, 2300, undefined, { query: "Juniper Freight BDR Denver" }, { results: 6 }],
      ["model", undefined, `${MODEL}: 9,050 tokens`, 5_600, 3300, 0.05],
      ["approval", "read_website", "Needs approval: read_website (https://juniperfreight.com)", 9_100, undefined, undefined, { url: "https://juniperfreight.com", max_pages: 40, include: ["/careers", "/blog", "/about"] }],
      ["status", undefined, "Waiting for the owner to approve a tool call", 9_300],
      ["crusonia", undefined, "Approval T5K2 requested for read_website", 10_000],
    ]),
  ses_ob4: () =>
    steps(40 * MIN, [
      ["crusonia", undefined, "Research started", 0],
      ["tool", "get_lead", "get_lead: lead_orbit", 2_000, 180, undefined, { lead_id: "lead_orbit" }, { company: "Orbit Ledger", domain: "orbitledger.com" }],
      ["tool", "read_website", "read_website: https://orbitledger.com", 2_400, 6100, undefined, { url: "https://orbitledger.com" }, { pages: 11 }],
      ["model", undefined, `${MODEL}: 15,330 tokens`, 8_700, 6200, 0.12],
      ["message", undefined, "Agent: Orbit Ledger lists two people who could own outbound. Asking the owner who should get the first email.", 15_000, undefined, undefined, undefined, "Orbit Ledger lists two people who could own outbound. Asking the owner who should get the first email."],
      ["status", undefined, "Waiting for the owner to answer a question", 15_400],
      ["crusonia", undefined, "Approval Q2C7 requested", 16_000],
    ]),
  ses_er9: () =>
    steps(2 * DAY + 3 * HOUR, [
      ["crusonia", undefined, "Research started", 0],
      ["tool", "read_website", "read_website: https://parcelandpine.com (failed)", 1_000, 30_000, undefined, { url: "https://parcelandpine.com" }, { error: "timeout after 30s" }, { is_error: true }],
      ["warning", undefined, "Retrying a failed turn (attempt 2)", 31_500],
      ["tool", "read_website", "read_website: https://parcelandpine.com (failed)", 32_000, 30_000, undefined, { url: "https://parcelandpine.com" }, { error: "timeout after 30s" }, { is_error: true }],
      ["model", undefined, `${MODEL}: 22,180 tokens`, 63_000, 8900, 0.34],
      ["status", undefined, "Stopped: too many iterations", 74_000, undefined, undefined, undefined, undefined, { is_error: true }],
    ]),
  ses_fl3: () =>
    steps(5 * HOUR, [
      ["crusonia", undefined, "Lead finding started (up to 25 leads)", 0],
      ["tool", "get_profile", "get_profile", 1_000, 150, undefined, {}, { company: "Acme", segments: 2 }],
      ["tool", "search_web", "search_web: Series A devtools hiring first SDR", 2_000, 2600, undefined, { query: "Series A devtools hiring first SDR" }, { results: 40 }],
      ["tool", "add_leads", "add_leads: 9 leads", 9_000, 900, undefined, { leads: 9 }, { counts: { added: 9, updated: 0 } }],
      ["model", undefined, `${MODEL}: 41,020 tokens`, 11_000, 12_000, 1.5],
      ["error", undefined, "Budget: run budget of $1.50 reached", 24_000, undefined, undefined, undefined, undefined, { is_error: true }],
      ["status", undefined, "Paused: budget reached", 24_100],
    ]),
};

function runLead(id: string | null): RunLead | null {
  const l = id ? sampleLeads.find((x) => x.id === id) : undefined;
  if (!l) return null;
  return { id: l.id, email: l.email, name: l.name, title: l.title, company: l.company, domain: l.domain, stage: l.stage, score: l.score, qualified: l.qualified, has_consent: l.has_consent };
}

/** Approvals for the session, plus send approvals for its lead (they carry no session id). */
function runApprovals(run: Run): RunApproval[] {
  return approvalsData()
    .filter((a) => a.naive_session_id === run.id || (run.lead_id && a.lead_id === run.lead_id && a.kind === "send" && a.created_at >= run.started_at))
    .map(({ draft, lead: _l, recipient: _r, answer: _a, ...a }) => ({
      ...a,
      draft: draft ? { id: draft.id, version: draft.version, subject: draft.subject, status: draft.status } : null,
    }));
}

function runDetail(run: Run): WorkflowRun {
  return {
    run,
    steps: STEPS[run.id]?.() ?? [],
    lead: runLead(run.lead_id),
    approvals: runApprovals(run),
    sync: run.id === "ses_er9" ? { ok: false, error: "Naive returned 502 Bad Gateway; showing stored events" } : { ok: true, skipped: "cache is current" },
  };
}

// ---------- replies ----------

type ReplySeed = [id: string, leadId: string, from: string, subject: string, preview: string, label: Reply["label"], receivedAgo: number];

const replySeeds: ReplySeed[] = [
  ["rpl_4", "lead_northwind", "tom@northwindrobotics.com", "Re: 4 SDR openings", "Thursday 2pm works. Send the invite to me and our RevOps lead.", "interested", 1 * DAY],
  ["rpl_3", "lead_kiln", "hana@kilnstudio.co", "Re: your relaunch", "Could you share pricing for a 10-person team?", "interested", 3 * HOUR],
  ["rpl_2", "lead_cobalt", "priya@cobaltfern.com", "Re: rebuilding the SDR team", "Not this quarter. Try me again in January.", "not_interested", 3 * DAY],
  ["rpl_1", "lead_mosaic", "owen@mosaicgrid.io", "unsubscribe", "Please remove me from your list.", "unsubscribe", 4 * DAY + 2 * HOUR],
];

export const sampleReplies: Reply[] = replySeeds
  .map(([id, leadId, from, subject, preview, label, receivedAgo]): Reply => {
    const l = sampleLeads.find((x) => x.id === leadId);
    return {
      id,
      lead_id: leadId,
      lead: l ? { id: l.id, name: l.name, email: l.email, company: l.company, stage: l.stage } : null,
      from,
      subject,
      preview,
      label,
      thread_id: `thr_${id}`,
      received_at: ago(receivedAgo),
    };
  })
  .sort((a, b) => b.received_at.localeCompare(a.received_at));

export const repliesData = () => (isEmpty() ? [] : sampleReplies);

// ---------- handlers ----------

export const workflowHandlers = [
  http.get("/api/workflows", () => ok({ data: workflowsData() })),
  http.get("/api/workflows/runs/:id", ({ params }) => {
    const run = isEmpty() ? undefined : sampleRuns.find((r) => r.id === params.id);
    return run ? ok(runDetail(run)) : fail(404, "not_found", `No workflow run with session id ${String(params.id)}`);
  }),
  http.post("/api/workflows/research", () => fail(503, "not_configured", "NAIVE_AGENT_ID is not set")),
  http.get("/api/replies", ({ request }) => {
    const label = new URL(request.url).searchParams.get("label");
    return ok({ data: repliesData().filter((r) => !label || r.label === label), next_cursor: null });
  }),
];
