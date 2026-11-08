// /api/experiments mocks ("Dashboard · Experiments").
import { http } from "msw";
import type { Experiment } from "../api.ts";
import { ago, body, DAY, fail, isEmpty, ok } from "./util.ts";

const daily = (a: number[], b: number[]) => a.map((v, i) => ({ date: new Date(Date.now() - (a.length - 1 - i) * DAY).toISOString().slice(0, 10), A: v, B: b[i]! }));

export const sampleExperiments: Experiment[] = [
  {
    id: "exp_hiring_vs_funding",
    name: "Hiring angle vs funding angle",
    hypothesis: "Hiring-signal angle beats funding angle for Series A dev-tools",
    segment: "Series A dev-tools",
    signal: "Hiring first SDR",
    workflow_id: "ses_8f3k21",
    status: "running",
    stop_rule: "80 sends per arm or 14 days",
    target_per_arm: 80,
    variants: { A: { label: "Funding angle", description: "“Congrats on the Series A...”" }, B: { label: "Hiring angle", description: "“Saw Fieldnote is hiring its first SDR...”" } },
    stats: { A: { sent: 52, replies: 5, positive: 2, cost_usd: 19.25 }, B: { sent: 52, replies: 8, positive: 4, cost_usd: 19.23 } },
    daily: daily([1, 2, 3, 4, 5, 5], [1, 2, 4, 5, 7, 8]),
    started_at: ago(5 * DAY),
    created_at: ago(5 * DAY),
  },
  {
    id: "exp_citations",
    name: "Three citations vs one",
    hypothesis: "Three cited facts beat one for lookalikes of closed-won",
    segment: "Lookalikes of closed-won",
    status: "running",
    stop_rule: "80 sends per arm or 14 days",
    target_per_arm: 80,
    variants: { A: { label: "Three citations" }, B: { label: "One citation" } },
    stats: { A: { sent: 71, replies: 6, positive: 3, cost_usd: 22.1 }, B: { sent: 70, replies: 5, positive: 2, cost_usd: 21.8 } },
    daily: daily([1, 2, 2, 3, 4, 5, 5, 6, 6], [1, 1, 2, 3, 3, 4, 4, 5, 5]),
    started_at: ago(8 * DAY),
    created_at: ago(8 * DAY),
  },
  {
    id: "exp_short_long",
    name: "Short first email vs long",
    hypothesis: "A three-sentence first email gets more positive replies than a long one",
    segment: "Inbound sign-ups",
    status: "finished",
    stop_rule: "80 sends per arm",
    target_per_arm: 80,
    variants: { A: { label: "Short" }, B: { label: "Long" } },
    stats: { A: { sent: 80, replies: 14, positive: 9, cost_usd: 30.4 }, B: { sent: 80, replies: 10, positive: 5.5, cost_usd: 31.2 } },
    daily: [],
    winner: "A",
    started_at: ago(30 * DAY),
    ended_at: ago(17 * DAY),
    created_at: ago(30 * DAY),
  },
];

export const experimentsData = () => (isEmpty() ? [] : sampleExperiments);

export const experimentHandlers = [
  http.get("/api/experiments", () => ok(experimentsData())),
  http.post("/api/experiments", async ({ request }) => {
    const b = await body<Partial<Experiment>>(request);
    return ok({ ...sampleExperiments[0]!, ...b, id: `exp_${Date.now()}`, status: "draft", stats: {}, daily: [] }, 201);
  }),
  http.get("/api/experiments/:id", ({ params }) => {
    const e = experimentsData().find((x) => x.id === params.id);
    return e ? ok(e) : fail(404, "not_found", "Experiment not found");
  }),
  http.patch("/api/experiments/:id", async ({ params, request }) => {
    const e = experimentsData().find((x) => x.id === params.id);
    return e ? ok({ ...e, ...(await body<Partial<Experiment>>(request)) }) : fail(404, "not_found", "Experiment not found");
  }),
];
