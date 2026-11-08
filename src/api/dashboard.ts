// Web app reads: /api/me, /api/summary (Home), /api/status (Integrations), /api/replies.
import { Hono } from "hono";
import { z } from "zod";
import { billingConfig } from "../billing/overview.ts";
import type { Env } from "../env.ts";
import { parseQuery, sqlFor, type AppEnv, type Principal } from "../lib/context.ts";
import { REPLY_LABELS } from "../services/classify.ts";
import { crmStatusSummary } from "../services/crm-sync.ts";
import { listReplies } from "../services/replies.ts";
import { getStatus } from "../services/status.ts";
import { getSummary } from "../services/summary.ts";

export const dashboard = new Hono<AppEnv>();

type Me = { user: { id: string; email?: string; name?: string }; auth: "clerk" | "token"; key?: { id: string; name: string } };

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

dashboard.get("/me", async (c) => c.json(await describePrincipal(c.env, c.get("principal"))));

dashboard.get("/summary", async (c) => c.json(await getSummary(sqlFor(c.env), c.env)));

// Same data as the MCP get_status tool, plus what the Integrations and "Connect your agent" screens show.
dashboard.get("/status", async (c) => {
  const status = await getStatus(c.env);
  const inbox = c.env.AGENTMAIL_INBOX_ID;
  const sql = status.database.reachable ? sqlFor(c.env) : null;
  return c.json({
    ...status,
    inbox_address: c.env.AGENTMAIL_API_KEY && inbox && inbox.includes("@") ? inbox : null,
    naive_agent_configured: Boolean(c.env.NAIVE_API_KEY && c.env.NAIVE_AGENT_ID),
    mcp_url: `${c.env.PUBLIC_URL.replace(/\/+$/, "")}/mcp`,
    billing: billingConfig(c.env),
    // Per target: enabled, configured, active, queue_depth, failed, last_sync_at, last_error. Details: GET /api/integrations/crm.
    crm_sync: await crmStatusSummary(sql, c.env),
  });
});

const RepliesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(20).optional(),
  label: z.enum(REPLY_LABELS).optional(),
  lead_id: z.string().max(64).optional(),
});

dashboard.get("/replies", async (c) => {
  const q = parseQuery(c, RepliesQuery);
  return c.json(await listReplies(sqlFor(c.env), q));
});
