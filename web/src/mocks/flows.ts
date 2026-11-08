// Mocks for workflow definitions, their run history, run traces and CSV import preview/commit (fe-flows).
// Sample data mirrors the Paper finals "Final · Workflows · List / Builder / Run history" and
// "Final · Import · Map and preview". State lives in memory, so create / new version / turn on work in a session.
import { http } from "msw";
import type { FlowDef, FlowInput, FlowPatch, FlowRun, FlowRunHistory, FlowStep, FlowVersion, FlowVersionInput, RunTrace, TraceEvent } from "../api/workflows.ts";
import type { ImportBody, ImportPreview, ImportPreviewRow } from "../api/import.ts";
import { parseCsv } from "../lib/csv.ts";
import { sampleLeads } from "./leads.ts";
import { ago, body, DAY, fail, HOUR, isEmpty, MIN, ok, scenario } from "./util.ts";

// ---------- time helpers ----------

/** The most recent Monday at `hour`:`minute` local time, `weeksBack` weeks earlier. */
function monday(weeksBack = 0, hour = 9, minute = 0): Date {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back - weeksBack * 7);
  if (d.getTime() > Date.now()) d.setDate(d.getDate() - 7);
  return d;
}
const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * MIN).toISOString();
function today(hour: number, minute: number): string {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.getTime() > Date.now() ? ago(3 * HOUR) : d.toISOString();
}

// ---------- steps ----------

const s = (id: string, kind: FlowStep["kind"], title: string, provider: string | null, next: string[] = [], branch: string | null = null): FlowStep => ({
  id,
  kind,
  title,
  provider,
  branch,
  next,
});

const sweepSteps = (v: number): FlowStep[] => [
  s("t1", "trigger", "Mondays 9:00", null, ["f1"]),
  s("f1", "find", "Find SDR job posts", "Apify · $0.40 cap", ["r1"]),
  s("r1", "research", "Research, score", "Researcher", ["c1"]),
  s("c1", "condition", v >= 2 ? "Fit 70+, opted in?" : "Fit 70+?", "Condition", ["k1", "d1"]),
  s("k1", "tasks", "LinkedIn note", "Tasks", [], "no"),
  s("d1", "draft", "Draft email", "Drafter", ["a1"], "yes"),
  s("a1", "approval", "Wait for Daniel", "Approval · 48h", ["m1", "e1", "n1"]),
  s("m1", "send", "Send draft", "AgentMail", [], "approved"),
  s("e1", "end", "Stop", "End", [], "rejected"),
  s("n1", "notify", "Text Daniel", "Photon iMessage", [], "timed out"),
];

const SWEEP_Q = {
  icp: { source: "company_summary" as const },
  research_questions: ["Is the founder still running sales?", "Did they post a sales role in the last 90 days?", "Which CRM do they use?"],
  evidence_required: ["Dated hiring signal with source URL", "Headcount from a company page"],
  done_when: "Scored, and every must-have has a source",
};

function version(v: number, steps: FlowStep[], q: Omit<FlowVersion, "version" | "label" | "created_at" | "steps">, label: string | null, created: string): FlowVersion {
  return { version: v, label, created_at: created, steps, ...q };
}

// ---------- definitions ----------

type Store = { defs: FlowDef[]; versions: Record<string, FlowVersion[]>; runs: Record<string, FlowRunHistory> };

function seed(): Store {
  const lastMon = monday();
  const defs: FlowDef[] = [
    {
      id: "wf_signal_sweep",
      name: "Weekly signal sweep",
      source: "claude_code",
      enabled: true,
      trigger: { kind: "schedule", label: "Mondays 9:00" },
      latest_version: 3,
      spend: { usd: 0.84, cap_usd: 5, period: "week" },
      status: "waiting",
      waiting: { drafts: 2 },
      last_run: { id: "ses_ws_3", started_at: lastMon.toISOString(), status: "waiting", summary: "10 found, 6 fit", detail: "4 tasks · 2 email drafts" },
    },
    {
      id: "wf_research",
      name: "Research new leads",
      source: "user",
      agent: "Researcher",
      enabled: true,
      trigger: { kind: "csv_import", label: "On CSV import" },
      latest_version: 1,
      spend: { usd: 1, cap_usd: 1, period: "run" },
      status: "budget_paused",
      remaining: 17,
      last_run: { id: "ses_rn_1", started_at: today(8, 12), status: "budget_paused", summary: "31 of 48 done" },
    },
    {
      id: "wf_reply_triage",
      name: "Reply triage",
      source: "user",
      agent: "Reply handler",
      enabled: true,
      trigger: { kind: "reply", label: "On new reply" },
      latest_version: 2,
      spend: { usd: 0.57, cap_usd: 3, period: "week" },
      status: "done",
      last_run: { id: "ses_rt_9", started_at: ago(12 * MIN), status: "done", summary: "Hana Sato", detail: "Interested, reply drafted" },
    },
  ];

  const researchSteps = [
    s("t1", "trigger", "On CSV import", null, ["r1"]),
    s("r1", "research", "Research, score", "Researcher", ["d1"]),
    s("d1", "draft", "Draft email", "Drafter", ["a1"]),
    s("a1", "approval", "Wait for Daniel", "Approval · 48h", ["m1", "e1"]),
    s("m1", "send", "Send draft", "AgentMail", [], "approved"),
    s("e1", "end", "Stop", "End", [], "rejected"),
  ];
  const triageSteps = [
    s("t1", "trigger", "On new reply", null, ["r1"]),
    s("r1", "research", "Classify reply", "Reply handler", ["d1"]),
    s("d1", "draft", "Draft reply", "Drafter", ["x1"]),
    s("x1", "sync_crm", "Update HubSpot", "Sync CRM", []),
  ];
  const plainQ = { icp: { source: "company_summary" as const }, research_questions: ["Who owns outbound today?"], evidence_required: ["Source URL for every claim"], done_when: "Scored with a source for each claim" };

  const versions: Store["versions"] = {
    wf_signal_sweep: [
      version(1, sweepSteps(1), { ...SWEEP_Q, research_questions: SWEEP_Q.research_questions.slice(0, 1), evidence_required: SWEEP_Q.evidence_required.slice(0, 1) }, "First draft", ago(30 * DAY)),
      version(2, sweepSteps(2), { ...SWEEP_Q, evidence_required: SWEEP_Q.evidence_required.slice(0, 1) }, "Opted-in only", ago(20 * DAY)),
      version(3, sweepSteps(3), SWEEP_Q, "Headcount evidence", ago(12 * DAY)),
    ],
    wf_research: [version(1, researchSteps, plainQ, null, ago(9 * DAY))],
    wf_reply_triage: [version(1, triageSteps, plainQ, null, ago(14 * DAY)), version(2, triageSteps, { ...plainQ, done_when: "Labelled, and a reply drafted for interested leads" }, "Draft replies", ago(6 * DAY))],
  };

  const runs: Store["runs"] = {
    wf_signal_sweep: {
      runs: [
        {
          id: "ses_ws_3",
          version: 3,
          started_at: lastMon.toISOString(),
          status: "waiting",
          cost_usd: 0.84,
          counts: { found: 38, researched: 10, qualified: 6, drafted: 6, sent: 0 },
          timeline: [
            { at: at(lastMon, 0), text: "Found 38 companies with an SDR job post" },
            { at: at(lastMon, 6), text: "Finder handed 10 to Researcher" },
            { at: at(lastMon, 19), text: "Researched 10 · 6 qualified · 1 paused for review" },
            { at: at(lastMon, 24), text: "Drafted 2 emails and 4 LinkedIn notes" },
            { at: at(lastMon, 41), text: "Waiting on you · 2 drafts" },
          ],
          trace_steps: 41,
        },
        histRun("ses_ws_2", 3, monday(1), 0.79, { found: 38, researched: 10, qualified: 6, drafted: 6, sent: 3 }, 37),
        histRun("ses_ws_1", 2, monday(2), 0.92, { found: 41, researched: 10, qualified: 4, drafted: 4, sent: 2 }, 39),
      ],
      variants: {
        version: 3,
        runs: 4,
        arms: [
          { key: "A", label: "funding", counts: { leads: 76, researched: 20, qualified: 11, drafted: 11, approved: 5, sent: 5, replied: 1 } },
          { key: "B", label: "hiring", counts: { leads: 76, researched: 20, qualified: 12, drafted: 12, approved: 6, sent: 5, replied: 2 } },
        ],
      },
      needs_review: [
        { lead_id: "lead_kiln", company: "Kiln Payroll", question: "No dated hiring signal found. Is the Series A from Oct 3 enough to qualify?", paused_at: at(lastMon, 17) },
      ],
    },
    wf_research: {
      runs: [
        {
          id: "ses_rn_1",
          version: 1,
          started_at: today(8, 12),
          status: "budget_paused",
          cost_usd: 1,
          counts: { found: 48, researched: 31, qualified: 14, drafted: 9, sent: 0 },
          timeline: [
            { at: today(8, 12), text: "Imported 48 leads from a CSV" },
            { at: today(8, 13), text: "Researcher started on 48 leads" },
            { at: today(8, 51), text: "Researched 31 · 14 qualified" },
            { at: today(8, 52), text: "Paused at the $1.00 cap · 17 leads left" },
          ],
          trace_steps: 64,
        },
      ],
      variants: null,
      needs_review: [],
    },
    wf_reply_triage: {
      runs: [histRun("ses_rt_9", 2, new Date(Date.now() - 12 * MIN), 0.03, { found: 1, researched: 1, qualified: 1, drafted: 1, sent: 0 }, 6)],
      variants: null,
      needs_review: [],
    },
  };
  return { defs, versions, runs };
}

function histRun(id: string, v: number, start: Date, cost: number, counts: FlowRun["counts"], steps: number): FlowRun {
  return {
    id,
    version: v,
    started_at: start.toISOString(),
    status: "done",
    cost_usd: cost,
    counts,
    timeline: [
      { at: at(start, 0), text: `Found ${counts.found} companies` },
      { at: at(start, 18), text: `Researched ${counts.researched} · ${counts.qualified} qualified` },
      { at: at(start, 26), text: `Drafted ${counts.drafted} emails` },
      { at: at(start, 60 * 26), text: `Sent ${counts.sent}` },
    ],
    trace_steps: steps,
  };
}

let store: Store | null = null;
const db = () => (store ??= seed());

const findDef = (id: unknown) => (isEmpty() ? undefined : db().defs.find((d) => d.id === id));
const notFound = (id: unknown) => fail(404, "not_found", `No workflow with id ${String(id)}`);

function triggerOf(steps: FlowStep[]): FlowDef["trigger"] {
  const t = steps.find((x) => x.kind === "trigger");
  const label = t?.title ?? "Manual";
  const kind = /import|csv/i.test(label) ? "csv_import" : /reply/i.test(label) ? "reply" : /day|week|month|\d:\d/i.test(label) ? "schedule" : "manual";
  return { kind, label };
}

// ---------- traces ----------

function traceFor(id: string): RunTrace | null {
  const all = Object.values(db().runs).flatMap((h) => h.runs);
  const run = all.find((r) => r.id === id);
  if (!run) return null;
  const start = new Date(run.started_at).getTime();
  const tools = ["read_website", "search_web", "save_evidence", "score_lead", "create_draft"];
  const n = run.trace_steps ?? 12;
  const events: TraceEvent[] = Array.from({ length: n }, (_, i) => {
    const created = new Date(start + i * 47_000).toISOString();
    const k = i % 4;
    if (i === 0) return { seq: 1, type: "session.status", data: { status: "running" }, created_at: created };
    if (k === 1) return { seq: i + 1, type: "model.request", data: { model: "claude-sonnet-4-5", tokens: 8_000 + i * 310, cost_usd: 0.01 }, created_at: created };
    if (k === 2) {
      const tool = tools[i % tools.length]!;
      return { seq: i + 1, type: "tool.call", data: { name: tool, input: { lead_id: "lead_fieldnote" } }, created_at: created };
    }
    if (k === 3) return { seq: i + 1, type: "tool.result", data: { name: tools[(i - 1) % tools.length], ok: true }, created_at: created };
    return { seq: i + 1, type: "agent.message", data: { text: "Checked the careers page and the funding announcement." }, created_at: created };
  });
  return {
    run: {
      id: run.id,
      workflow_id: "research",
      name: "Lead research",
      purpose: "research",
      status: run.status === "waiting" ? "idle" : run.status === "budget_paused" ? "paused" : "done",
      stop_reason: null,
      lead_id: null,
      input: {},
      started_at: run.started_at,
      updated_at: run.started_at,
      last_event_at: run.started_at,
      leads_processed: run.counts.researched,
      cost_usd: run.cost_usd,
    },
    events,
    has_more: false,
    next_after_seq: null,
    audit: [],
    approvals: [],
    spend: { naive_usd: run.cost_usd, credits_debited: Math.round((run.cost_usd ?? 0) * 200), apify_runs: [{ usage_usd: 0.31 }] },
    retention_days: 180,
    sync: { ok: true, complete: true, skipped: "trace is complete" },
  };
}

// ---------- import ----------

const TRUE = /^(y|yes|true|1|opted[ -]?in|subscribed|x)$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const existing = new Map<string, string>([...sampleLeads.filter((l) => l.email).map((l) => [l.email!.toLowerCase(), l.id] as [string, string]), ["sofia@quillstack.io", "lead_quill"]]);

function previewOf(b: ImportBody): ImportPreview {
  const rows = parseCsv(b.csv ?? "");
  const header = (rows[0] ?? []).map((c) => c.trim());
  const col = (field: keyof ImportBody["mapping"]) => {
    const name = b.mapping?.[field];
    return name ? header.indexOf(name) : -1;
  };
  const get = (r: string[], field: keyof ImportBody["mapping"]) => {
    const i = col(field);
    const v = i >= 0 ? (r[i] ?? "").trim() : "";
    return v || null;
  };
  const seen = new Set<string>();
  const out: ImportPreviewRow[] = rows.slice(1).map((r, i) => {
    const email = get(r, "email");
    const at = get(r, "consent_at");
    const parsed = at ? new Date(at) : null;
    const base = {
      row: i + 2,
      name: get(r, "name"),
      email,
      company: get(r, "company"),
      domain: get(r, "domain"),
      title: get(r, "title"),
      consent: TRUE.test(get(r, "consent") ?? ""),
      consent_at: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
      source: get(r, "source") ?? (b.source?.trim() || null),
    };
    if (!email || !EMAIL.test(email)) return { ...base, status: "invalid" as const, reason: email ? "email not valid" : "no email" };
    const key = email.toLowerCase();
    const leadId = existing.get(key);
    if (leadId || seen.has(key)) return { ...base, status: "duplicate" as const, lead_id: leadId ?? null, existing_since: leadId ? ago(26 * DAY) : null };
    seen.add(key);
    return { ...base, status: "new" as const };
  });
  const count = (st: ImportPreviewRow["status"]) => out.filter((r) => r.status === st).length;
  return { columns: header, rows: out, counts: { new: count("new"), duplicate: count("duplicate"), invalid: count("invalid") } };
}

// ---------- handlers ----------

export const flowHandlers = [
  http.get("/api/workflow-definitions", () => ok({ data: isEmpty() ? [] : db().defs })),
  http.post("/api/workflow-definitions", async ({ request }) => {
    const input = await body<FlowInput>(request);
    if (!input.name?.trim()) return fail(400, "invalid_request", "name is required");
    const d = db();
    const id = `wf_${Math.random().toString(36).slice(2, 8)}`;
    const v = version(1, input.steps ?? [], { icp: input.icp, research_questions: input.research_questions ?? [], evidence_required: input.evidence_required ?? [], done_when: input.done_when ?? "" }, null, new Date().toISOString());
    const def: FlowDef = {
      id,
      name: input.name.trim(),
      source: input.source ?? "user",
      enabled: false,
      trigger: input.trigger ?? triggerOf(v.steps),
      latest_version: 1,
      spend: { usd: 0, cap_usd: 5, period: "week" },
      status: "off",
      last_run: null,
    };
    d.defs.push(def);
    d.versions[id] = [v];
    d.runs[id] = { runs: [], variants: null, needs_review: [] };
    return ok({ workflow: def, version: v }, 201);
  }),
  http.get("/api/workflow-definitions/:id", ({ params }) => {
    const def = findDef(params.id);
    return def ? ok({ workflow: def, versions: db().versions[def.id] ?? [] }) : notFound(params.id);
  }),
  http.patch("/api/workflow-definitions/:id", async ({ params, request }) => {
    const def = findDef(params.id);
    if (!def) return notFound(params.id);
    const p = await body<FlowPatch>(request);
    if (p.name !== undefined) def.name = p.name;
    if (p.enabled !== undefined) {
      def.enabled = p.enabled;
      if (!p.enabled) def.status = "off";
      else if (def.status === "off") def.status = "done";
    }
    if (p.cap_usd !== undefined) def.spend = { ...def.spend, cap_usd: p.cap_usd };
    if (p.resume) {
      def.status = "running";
      def.enabled = true;
    }
    return ok({ workflow: def });
  }),
  http.post("/api/workflow-definitions/:id/versions", async ({ params, request }) => {
    const def = findDef(params.id);
    if (!def) return notFound(params.id);
    const input = await body<FlowVersionInput>(request);
    const list = (db().versions[def.id] ??= []);
    const v = version(def.latest_version + 1, input.steps, { icp: input.icp, research_questions: input.research_questions, evidence_required: input.evidence_required, done_when: input.done_when }, input.label?.trim() || null, new Date().toISOString());
    list.push(v);
    def.latest_version = v.version;
    def.trigger = triggerOf(v.steps);
    return ok({ version: v, workflow: def }, 201);
  }),
  http.post("/api/workflow-definitions/:id/run", async ({ params, request }) => {
    const def = findDef(params.id);
    if (!def) return notFound(params.id);
    if (scenario() === "unconfigured") return fail(503, "not_configured", "NAIVE_AGENT_ID is not set");
    const b = await body<{ version?: number; test_leads?: number }>(request);
    const id = `ses_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const hist = (db().runs[def.id] ??= { runs: [], variants: null, needs_review: [] });
    hist.runs.unshift({
      id,
      version: b.version ?? def.latest_version,
      started_at: now,
      status: "running",
      cost_usd: 0,
      counts: { found: 0, researched: 0, qualified: 0, drafted: 0, sent: 0 },
      timeline: [{ at: now, text: b.test_leads ? `Started on ${b.test_leads} test leads` : "Started" }],
      trace_steps: 1,
    });
    def.status = "running";
    def.last_run = { id, started_at: now, status: "running", summary: b.test_leads ? `Test on ${b.test_leads} leads` : "Started" };
    return ok({ run: { id } }, 202);
  }),
  http.get("/api/workflow-definitions/:id/runs", ({ params }) => {
    const def = findDef(params.id);
    return def ? ok(db().runs[def.id] ?? { runs: [], variants: null, needs_review: [] }) : notFound(params.id);
  }),
  http.get("/api/workflows/runs/:id/trace", ({ params }) => {
    const t = isEmpty() ? null : traceFor(String(params.id));
    return t ? ok(t) : fail(404, "not_found", `No workflow run with session id ${String(params.id)}`);
  }),
  http.post("/api/import/preview", async ({ request }) => {
    const b = await body<ImportBody>(request);
    if (!b.csv?.trim()) return fail(400, "invalid_request", "csv is required");
    return ok(previewOf(b));
  }),
  http.post("/api/import/commit", async ({ request }) => {
    const p = previewOf(await body<ImportBody>(request));
    return ok({ created: p.counts.new, updated: p.counts.duplicate, skipped: p.counts.invalid });
  }),
];
