// Web app reads: /api/me, /api/summary (Home), /api/status (Integrations), /api/replies.
import { Hono } from "hono";
import { z } from "zod";
import { billingConfig } from "../billing/overview.ts";
import type { Env } from "../env.ts";
import { parseQuery, sqlFor, wsOf, type AppEnv, type Principal } from "../lib/context.ts";
import { REPLY_LABELS } from "../services/classify.ts";
import { crmStatusSummary } from "../services/crm-sync.ts";
import { listReplies } from "../services/replies.ts";
import { getStatus } from "../services/status.ts";
import { getSummary } from "../services/summary.ts";
import { workspaceMcpUrl } from "../services/naive-agents.ts";
import { getWorkspace, type Workspace } from "../services/workspaces.ts";

export const dashboard = new Hono<AppEnv>();

type Me = {
  user: { id: string; email?: string; name?: string };
  auth: "clerk" | "token";
  key?: { id: string; name: string };
  workspace?: { id: string; name: string; owner: boolean };
};

/** Email and name of a Clerk user from the Backend API (best effort: missing fields stay missing). */
async function clerkProfile(env: Env, userId: string): Promise<{ email?: string; name?: string }> {
  if (!env.CLERK_SECRET_KEY) return {};
  try {
    const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return {};
    const u = (await res.json()) as {
      primary_email_address_id?: string | null;
      email_addresses?: { id: string; email_address: string }[];
      first_name?: string | null;
      last_name?: string | null;
      username?: string | null;
    };
    const emails = u.email_addresses ?? [];
    const email = (emails.find((e) => e.id === u.primary_email_address_id) ?? emails[0])?.email_address;
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || undefined;
    return { ...(email ? { email } : {}), ...(name ? { name } : {}) };
  } catch {
    return {};
  }
}

export async function describePrincipal(env: Env, p: Principal): Promise<Me> {
  if (p.kind === "clerk") {
    const known = { ...(p.email ? { email: p.email } : {}), ...(p.name ? { name: p.name } : {}) };
    const fetched = p.email && p.name ? {} : await clerkProfile(env, p.userId);
    return { user: { id: p.userId, ...fetched, ...known }, auth: "clerk" };
  }
  if (p.kind === "api_key") return { user: { id: `api_key:${p.keyId}`, name: p.name }, auth: "token", key: { id: p.keyId, name: p.name } };
  return { user: { id: "owner", name: "Owner (MCP_TOKEN)" }, auth: "token" };
}

/** The caller's workspace for /api/me (name from the database when it answers; the id alone otherwise). */
async function describeWorkspace(env: AppEnv["Bindings"], ws: Workspace) {
  if (!env.DATABASE_URL) return { id: ws.id, name: ws.owner ? "Owner" : ws.id, owner: ws.owner };
  const row = await getWorkspace(sqlFor(env), ws.id).catch(() => null);
  return { id: ws.id, name: row?.name ?? ws.id, owner: ws.owner };
}

dashboard.get("/me", async (c) =>
  c.json({ ...(await describePrincipal(c.env, c.get("principal"))), workspace: await describeWorkspace(c.env, c.get("workspace")) }),
);

dashboard.get("/summary", async (c) => c.json(await getSummary(sqlFor(c.env), c.env, wsOf(c))));

// Same data as the MCP get_status tool, plus what the Integrations and "Connect your agent" screens show.
dashboard.get("/status", async (c) => {
  const ws = c.get("workspace");
  const status = await getStatus(c.env, ws.id);
  const inbox = c.env.AGENTMAIL_INBOX_ID;
  const sql = status.database.reachable ? sqlFor(c.env) : null;
  return c.json({
    ...status,
    workspace_id: ws.id,
    inbox_address: c.env.AGENTMAIL_API_KEY && inbox && inbox.includes("@") ? inbox : null,
    naive_agent_configured: Boolean(c.env.NAIVE_API_KEY && c.env.NAIVE_AGENT_ID),
    // Workspace API keys work on the plain /mcp URL; the workspace's own Naive agent uses /mcp?ws=<id>.
    mcp_url: `${c.env.PUBLIC_URL.replace(/\/+$/, "")}/mcp`,
    agent_mcp_url: ws.owner ? `${c.env.PUBLIC_URL.replace(/\/+$/, "")}/mcp` : workspaceMcpUrl(c.env, ws.id),
    billing: billingConfig(c.env),
    // Per target: enabled, configured, active, queue_depth, failed, last_sync_at, last_error. Details: GET /api/integrations/crm.
    // CRM sync is the instance's own HubSpot / Notion: the owner workspace only.
    crm_sync: ws.owner ? await crmStatusSummary(sql, c.env) : crmUnavailable(),
  });
});

/** The CRM status for a workspace other than the owner's: present, but switched off. */
function crmUnavailable() {
  const off = { enabled: false, configured: false, active: false, queue_depth: null, failed: null, last_sync_at: null, last_error: null };
  return { hubspot: off, notion: off, available: false };
}

const RepliesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(20).optional(),
  label: z.enum(REPLY_LABELS).optional(),
  lead_id: z.string().max(64).optional(),
});

dashboard.get("/replies", async (c) => {
  const q = parseQuery(c, RepliesQuery);
  return c.json(await listReplies(sqlFor(c.env), wsOf(c), q));
});
