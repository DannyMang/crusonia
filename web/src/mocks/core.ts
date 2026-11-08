// /api/me, /api/summary, /api/status, /api/settings/pause and /api/suppressions mocks.
import { http } from "msw";
import type { Status, Summary } from "../api.ts";
import { approvalsData } from "./approvals.ts";
import { leadsData } from "./leads.ts";
import { body, isEmpty, noContent, ok, scenario } from "./util.ts";
import { repliesData, workflowsData } from "./workflows.ts";

let paused = false;

function summary(): Summary {
  const leads = leadsData();
  const by = (...stages: string[]) => leads.filter((l) => stages.includes(l.stage)).length;
  const empty = isEmpty();
  return {
    pipeline: empty
      ? { found: 0, researched: 0, drafted: 0, awaiting_approval: 0, sent: 0, replied: 0, meetings: 0 }
      : { found: 248, researched: 131, drafted: 42, awaiting_approval: approvalsData().length || by("awaiting_approval"), sent: 37, replied: 9, meetings: 3 },
    pending_approvals: approvalsData(),
    active_workflows: workflowsData().filter((w) => w.status === "running" || w.status === "idle" || w.status === "paused"),
    recent_replies: repliesData(),
    spend: empty ? null : { week_usd: 86.4, budget_usd: 150 },
    paused,
  };
}

function status(): Status {
  const unconfigured = scenario() === "unconfigured";
  const p = (configured: boolean, used_for: string, missing?: string[]) => (configured ? { configured, used_for } : { configured, used_for, missing });
  return {
    providers: {
      database: p(true, "Neon Postgres: leads, drafts, approvals, events"),
      apify: p(!unconfigured, "web crawling (read_website) and Google search (search_web)", ["APIFY_TOKEN"]),
      agentmail: p(true, "sending approved emails to opted-in leads and receiving replies"),
      naive: p(!unconfigured, "managed agent sessions (research and drafting)", ["NAIVE_API_KEY"]),
      hubspot: p(true, "CRM sync"),
      notion: p(!unconfigured, "CRM sync (Notion database)", ["NOTION_API_TOKEN"]),
    },
    database: { configured: true, reachable: true, total_leads: leadsData().length, pending_approvals: approvalsData().length, profile_saved: !isEmpty(), paused },
    inbox_address: "crusonia@agentmail.to",
    next_steps: [],
  };
}

export const coreHandlers = [
  http.get("/api/me", () => ok({ kind: "clerk", user_id: "user_mock", email: "daniel@acme.com", name: "Daniel Ung", workspace: { name: "Acme" }, onboarded: !isEmpty() })),
  http.get("/api/summary", () => ok(summary())),
  http.get("/api/status", () => ok(status())),
  http.get("/api/settings/pause", () => ok({ paused })),
  http.put("/api/settings/pause", async ({ request }) => {
    paused = Boolean((await body<{ paused?: boolean }>(request)).paused);
    return ok({ paused });
  }),
  http.get("/api/suppressions", () =>
    ok({ data: isEmpty() ? [] : [{ email: "owen@mosaicgrid.io", reason: "unsubscribe", created_at: new Date(Date.now() - 4 * 86_400_000).toISOString() }], next_cursor: null }),
  ),
  http.post("/api/suppressions", () => ok({ created: true }, 201)),
  http.delete("/api/suppressions/:email", () => noContent()),
];
