// /api/me, /api/summary, /api/status, /api/settings/pause and /api/suppressions mocks, in the backend's shapes
// (src/api/dashboard.ts, src/services/summary.ts).
import { http } from "msw";
import type { Me, Status, Summary, Workflow } from "../api.ts";
import { approvalsData } from "./approvals.ts";
import { leadsData } from "./leads.ts";
import { body, isEmpty, noContent, ok, scenario } from "./util.ts";
import { repliesData, workflowsData } from "./workflows.ts";

let paused = false;

/** The backend's cumulative funnel (src/services/summary.ts cumulativePipeline), from stages, plus `qualified`. */
function pipeline(byStage: Record<string, number>, awaitingOpen: number) {
  const n = (...stages: string[]) => stages.reduce((sum, s) => sum + (byStage[s] ?? 0), 0);
  const meetings = n("meeting_booked");
  const replied = meetings + n("replied", "interested", "not_interested");
  const sent = replied + n("sent");
  const drafted = sent + n("awaiting_approval");
  const qualified = drafted + n("qualified");
  const researched = qualified + n("disqualified", "needs_review");
  const found = researched + n("new", "no_consent", "researching");
  return { found, researched, qualified, drafted, awaiting_approval: Math.min(awaitingOpen, n("awaiting_approval")), sent, replied, meetings };
}

function summary(): Summary {
  const leads = leadsData();
  const byStage: Record<string, number> = {};
  for (const l of leads) byStage[l.stage] = (byStage[l.stage] ?? 0) + 1;
  const approvals = approvalsData();
  const openLeads = new Set(approvals.filter((a) => a.kind === "send").map((a) => a.lead_id));
  const awaitingOpen = leads.filter((l) => l.stage === "awaiting_approval" && openLeads.has(l.id)).length;
  const workflows = (workflowsData() as Workflow[]).filter((w) => w.active_runs > 0);
  return {
    pipeline: pipeline(byStage, awaitingOpen),
    pipeline_by_stage: byStage,
    total_leads: leads.length,
    pending_approvals: approvals.slice(0, 5).map((a) => ({ ...a, lead_name: a.lead?.name ?? null, company: a.lead?.company ?? null, subject: a.draft?.subject ?? null })),
    pending_approvals_total: approvals.length,
    pending_sends_total: approvals.filter((a) => a.kind === "send").length,
    active_workflows: workflows,
    recent_replies: repliesData().slice(0, 5),
    spend: isEmpty() ? { week_usd: null, budget_usd: null } : { week_usd: 86.4, budget_usd: 150 },
    paused,
  };
}

function status(): Status {
  const unconfigured = scenario() === "unconfigured";
  const p = (configured: boolean, used_for: string, missing: string[]) => (configured ? { configured, used_for } : { configured, used_for, missing });
  return {
    providers: {
      database: p(true, "Neon Postgres: leads, drafts, approvals, events", ["DATABASE_URL"]),
      apify: p(!unconfigured, "web crawling (read_website) and Google search (search_web)", ["APIFY_TOKEN"]),
      agentmail: p(true, "sending approved emails to opted-in leads and receiving replies", ["AGENTMAIL_API_KEY", "AGENTMAIL_INBOX_ID"]),
      naive: p(!unconfigured, "managed agent sessions (research and drafting)", ["NAIVE_API_KEY"]),
      hubspot: p(true, "CRM sync", ["HUBSPOT_ACCESS_TOKEN"]),
      notion: p(!unconfigured, "CRM sync (Notion database)", ["NOTION_API_TOKEN"]),
    },
    database: {
      configured: true,
      reachable: true,
      leads_by_stage: {},
      total_leads: leadsData().length,
      pending_approvals: approvalsData().length,
      profile_saved: !isEmpty(),
      paused,
    },
    next_steps: [],
    inbox_address: "crusonia@agentmail.to",
    naive_agent_configured: !unconfigured,
    mcp_url: "https://crusonia.veri-web.workers.dev/mcp",
    imessage:
      scenario() === "sample"
        ? { enabled: true, configured: true, active: true, owner_phone_set: true, owner_phone_hint: "+1 ··· 0142", bridge: { online: true } }
        : { enabled: false, configured: false, active: false, owner_phone_set: false, bridge: null },
    crm_sync: {
      hubspot: { enabled: !unconfigured, configured: true, active: !unconfigured, queue_depth: isEmpty() ? 0 : 3, failed: 0, last_sync_at: isEmpty() ? null : new Date(Date.now() - 4 * 60_000).toISOString(), last_error: null },
      notion: { enabled: false, configured: !unconfigured, active: false, queue_depth: 0, failed: 0, last_sync_at: null, last_error: null },
    },
  };
}

const me: Me = { user: { id: "user_mock", email: "daniel@acme.com", name: "Daniel Ung" }, auth: "clerk", workspace: { id: "ws_acme", name: "Acme", owner: false, role: "owner" } };

export const coreHandlers = [
  http.get("/api/me", () => ok(me)),
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
