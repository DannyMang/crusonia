// /api/experiments mocks ("Dashboard · Experiments"), in the backend's shapes (src/api/experiments.ts,
// src/services/experiments.ts). Stateful per page load: POST adds, PATCH {status:"stopped"} stops.
// `?mock=unconfigured` answers like a deployment where the route has not shipped yet (404 "No route for").
import { http } from "msw";
import type { CreateExperimentInput, DailyPoint, Experiment } from "../api.ts";
import { body, DAY, fail, isEmpty, ok, scenario } from "./util.ts";

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const dayStart = (daysAgo: number) => new Date(`${utcDay(Date.now() - daysAgo * DAY)}T09:00:00Z`).toISOString();

/** Per-day (not cumulative) counts, oldest first, ending on `endDaysAgo` (0 = today), like dailySeries(). */
function series(replies: { A: number[]; B: number[] }, sent: { A: number[]; B: number[] }, endDaysAgo = 0): DailyPoint[] {
  const n = replies.A.length;
  return replies.A.map((_, i) => ({
    date: utcDay(Date.now() - (endDaysAgo + n - 1 - i) * DAY),
    A_replies: replies.A[i]!,
    B_replies: replies.B[i]!,
    A_sent: sent.A[i]!,
    B_sent: sent.B[i]!,
  }));
}

type Sample = { experiment: Experiment; daily: DailyPoint[] };

const samples = (): Sample[] => [
  {
    experiment: {
      id: "exp_hiring_vs_funding",
      name: "Hiring angle vs funding angle",
      hypothesis: "Hiring-signal angle beats funding angle for founder-led devtools",
      segment: "Founder-led devtools",
      metric: "positive_reply_rate",
      stop_rule_sends_per_arm: 80,
      stop_rule_days: 14,
      status: "running",
      variants: {
        A: { name: "Funding angle", description: "Congrats on the Series A…" },
        B: { name: "Hiring angle", description: "Saw Fieldnote is hiring its first SDR…" },
      },
      enrolled: { A: 61, B: 60 },
      stats: { A: { sent: 52, replies: 5, positive: 2, cost_usd: 19.25 }, B: { sent: 52, replies: 8, positive: 4, cost_usd: 19.23 } },
      stop_rule_met: false,
      stop_rule_reason: null,
      created_at: dayStart(5),
      stopped_at: null,
    },
    daily: series({ A: [0, 1, 1, 1, 1, 1], B: [1, 1, 2, 1, 2, 1] }, { A: [8, 9, 9, 9, 9, 8], B: [8, 9, 9, 9, 9, 8] }),
  },
  {
    experiment: {
      id: "exp_citations",
      name: "Three citations vs one",
      hypothesis: "Three cited facts beat one for vertical SaaS teams going outbound",
      segment: "Vertical SaaS going outbound",
      metric: "positive_reply_rate",
      stop_rule_sends_per_arm: 80,
      stop_rule_days: 14,
      status: "running",
      variants: { A: { name: "Three citations", description: "Three facts, each with its source" }, B: { name: "One citation", description: "The single strongest fact" } },
      enrolled: { A: 84, B: 83 },
      stats: { A: { sent: 71, replies: 6, positive: 3, cost_usd: 22.1 }, B: { sent: 70, replies: 5, positive: 2, cost_usd: 21.8 } },
      stop_rule_met: false,
      stop_rule_reason: null,
      created_at: dayStart(8),
      stopped_at: null,
    },
    daily: series(
      { A: [1, 0, 1, 1, 0, 1, 1, 1, 0], B: [0, 1, 1, 0, 1, 1, 0, 1, 0] },
      { A: [8, 8, 8, 8, 8, 8, 8, 8, 7], B: [8, 8, 8, 8, 8, 8, 8, 8, 6] },
    ),
  },
  {
    experiment: {
      id: "exp_question_subject",
      name: "Question subject vs statement",
      hypothesis: "A question in the subject line gets more positive replies than a statement",
      segment: "Fintech hiring a first sales team",
      metric: "positive_reply_rate",
      stop_rule_sends_per_arm: 80,
      stop_rule_days: null,
      status: "running",
      variants: { A: { name: "Question subject", description: "Still running sales yourself?" }, B: { name: "Statement subject", description: "Notes for founder-led sales" } },
      enrolled: { A: 40, B: 41 },
      stats: { A: { sent: 29, replies: 2, positive: 1, cost_usd: null }, B: { sent: 29, replies: 1, positive: 0, cost_usd: null } },
      stop_rule_met: false,
      stop_rule_reason: null,
      created_at: dayStart(2),
      stopped_at: null,
    },
    daily: series({ A: [0, 1, 1], B: [0, 0, 1] }, { A: [10, 10, 9], B: [10, 10, 9] }),
  },
  {
    experiment: {
      id: "exp_short_long",
      name: "Short first email vs long",
      hypothesis: "A three-sentence first email gets more positive replies than a long one",
      segment: "Founder-led devtools",
      metric: "positive_reply_rate",
      stop_rule_sends_per_arm: 80,
      stop_rule_days: null,
      status: "stopped",
      variants: { A: { name: "Short", description: "Three sentences, one ask" }, B: { name: "Long", description: "Context, proof and a case study" } },
      enrolled: { A: 80, B: 80 },
      stats: { A: { sent: 80, replies: 14, positive: 9, cost_usd: 30.4 }, B: { sent: 80, replies: 10, positive: 5, cost_usd: 31.2 } },
      stop_rule_met: false,
      stop_rule_reason: null,
      created_at: dayStart(30),
      stopped_at: dayStart(17),
    },
    daily: series(
      { A: [1, 1, 2, 1, 2, 1, 1, 1, 1, 1, 1, 1, 0, 0], B: [0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0] },
      { A: [7, 7, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 0], B: [7, 7, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 0] },
      17,
    ),
  },
  {
    experiment: {
      id: "exp_founder_ae",
      name: "Founder as sender vs AE",
      hypothesis: "Emails signed by the founder get more positive replies than emails from an AE",
      segment: "Fintech hiring a first sales team",
      metric: "positive_reply_rate",
      stop_rule_sends_per_arm: 80,
      stop_rule_days: 21,
      status: "stopped",
      variants: { A: { name: "Founder", description: "Signed by the CEO" }, B: { name: "AE", description: "Signed by the first AE" } },
      enrolled: { A: 82, B: 80 },
      stats: { A: { sent: 80, replies: 9, positive: 4, cost_usd: 29.9 }, B: { sent: 80, replies: 8, positive: 4, cost_usd: 30.1 } },
      stop_rule_met: false,
      stop_rule_reason: null,
      created_at: dayStart(48),
      stopped_at: dayStart(35),
    },
    daily: [],
  },
];

let store: Sample[] | null = null;
const all = () => (store ??= isEmpty() ? [] : samples());
export const experimentsData = () => all().map((s) => s.experiment);

const missing = (method: string, path: string) => fail(404, "not_found", `No route for ${method} ${path}`);
const unshipped = () => scenario() === "unconfigured";
const find = (id: unknown) => all().find((s) => s.experiment.id === id);

export const experimentHandlers = [
  http.get("/api/experiments", () => (unshipped() ? missing("GET", "/api/experiments") : ok({ data: experimentsData() }))),
  http.post("/api/experiments", async ({ request }) => {
    if (unshipped()) return missing("POST", "/api/experiments");
    const b = await body<CreateExperimentInput>(request);
    if (!b.name?.trim()) return fail(400, "invalid_request", "name: Required");
    const enrolledIds = [...new Set(b.lead_ids ?? [])];
    // Leads keep their stable variant; split them roughly in half for the mock.
    const a = Math.ceil(enrolledIds.length / 2);
    const experiment: Experiment = {
      id: `exp_${Date.now().toString(36)}`,
      name: b.name.trim(),
      hypothesis: b.hypothesis ?? null,
      segment: b.segment ?? null,
      metric: b.metric ?? "positive_reply_rate",
      stop_rule_sends_per_arm: b.stop_rule_sends_per_arm ?? null,
      stop_rule_days: b.stop_rule_days ?? null,
      status: "running",
      variants: { A: b.variants?.A ?? {}, B: b.variants?.B ?? {} },
      enrolled: { A: a, B: enrolledIds.length - a },
      stats: { A: { sent: 0, replies: 0, positive: 0, cost_usd: null }, B: { sent: 0, replies: 0, positive: 0, cost_usd: null } },
      stop_rule_met: false,
      stop_rule_reason: null,
      created_at: new Date().toISOString(),
      stopped_at: null,
    };
    all().unshift({ experiment, daily: series({ A: [0], B: [0] }, { A: [0], B: [0] }) });
    return ok({ experiment, enrollment: { enrolled: enrolledIds.length, skipped: [] } }, 201);
  }),
  http.get("/api/experiments/:id", ({ params }) => {
    if (unshipped()) return missing("GET", `/api/experiments/${String(params.id)}`);
    const s = find(params.id);
    return s ? ok(s) : fail(404, "not_found", `No experiment with id ${String(params.id)}`);
  }),
  http.patch("/api/experiments/:id", async ({ params, request }) => {
    if (unshipped()) return missing("PATCH", `/api/experiments/${String(params.id)}`);
    const s = find(params.id);
    if (!s) return fail(404, "not_found", `No experiment with id ${String(params.id)}`);
    const patch = await body<{ status?: string }>(request);
    if (patch.status !== "stopped") return fail(400, "invalid_request", 'status: Invalid literal value, expected "stopped"');
    if (s.experiment.status === "running") Object.assign(s.experiment, { status: "stopped", stopped_at: new Date().toISOString(), stop_rule_met: false, stop_rule_reason: null });
    return ok({ experiment: s.experiment });
  }),
  http.post("/api/experiments/:id/leads", async ({ params, request }) => {
    if (unshipped()) return missing("POST", `/api/experiments/${String(params.id)}/leads`);
    const s = find(params.id);
    if (!s) return fail(404, "not_found", `No experiment with id ${String(params.id)}`);
    if (s.experiment.status !== "running") return fail(409, "conflict", `Experiment ${s.experiment.id} is stopped; only running experiments take new leads`);
    const ids = [...new Set((await body<{ lead_ids?: string[] }>(request)).lead_ids ?? [])];
    s.experiment.enrolled.A += Math.ceil(ids.length / 2);
    s.experiment.enrolled.B += Math.floor(ids.length / 2);
    return ok({ enrolled: ids.length, skipped: [] });
  }),
];
