// /api/admin: read-only, cross-workspace views for the people who operate this Crusonia instance (debugging and
// quality). Platform admins are the Clerk users in PLATFORM_ADMIN_USER_IDS plus OWNER_CLERK_USER_ID. They can list
// any workspace's agent runs and read a run's trace; nothing here writes to a workspace (no Naive refresh either),
// and every read is recorded in the viewed workspace's audit trail (events kind 'admin_viewed': the admin, what was
// viewed). Admins act on other workspaces through these routes only; everywhere else they are a normal user.
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { logEvent } from "../db.ts";
import type { Env } from "../env.ts";
import { actorOf, parseQuery, sqlFor, type AppEnv } from "../lib/context.ts";
import { ApiError } from "../lib/errors.ts";
import { getRunDetail, toRun, type SessionRow } from "../services/runs.ts";

const list = (raw: string | undefined) =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** PLATFORM_ADMIN_USER_IDS plus the instance owner (OWNER_CLERK_USER_ID). */
export const platformAdminIds = (env: Env) => new Set([...list(env.PLATFORM_ADMIN_USER_IDS), ...list(env.OWNER_CLERK_USER_ID)]);

export const admin = new Hono<AppEnv>();

const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const p = c.get("principal");
  if (p.kind !== "clerk" || !platformAdminIds(c.env).has(p.userId)) {
    throw new ApiError(403, "forbidden", "Platform admins only");
  }
  await next();
};
admin.use("*", requireAdmin);

const RunsQuery = z.object({
  workspace: z.string().trim().min(1).max(64),
  purpose: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// A workspace's agent runs, newest first.
admin.get("/runs", async (c) => {
  const q = parseQuery(c, RunsQuery);
  const sql = sqlFor(c.env);
  const [ws] = await sql`select id, name, paused from workspaces where id = ${q.workspace}`;
  if (!ws) throw new ApiError(404, "not_found", "Workspace not found");
  const rows = (await sql`
    select id, workspace_id, lead_id, purpose, status, stop_reason, input, consumed_micro_usd, leads_processed, events_seq,
           events_synced_at, last_event_at, created_at, updated_at
    from naive_sessions
    where workspace_id = ${q.workspace} and (${q.purpose ?? null}::text is null or purpose = ${q.purpose ?? null})
    order by created_at desc limit ${q.limit}`) as SessionRow[];
  await logEvent(sql, q.workspace, null, "admin_viewed", { admin: actorOf(c.get("principal")), what: "runs", purpose: q.purpose ?? null, count: rows.length });
  return c.json({ workspace: { id: ws.id, name: ws.name }, data: rows.map((r) => toRun(r, ws.paused === true)) });
});

// One run's trace: the stored Naive events and our audit events as steps, the raw stored events, lead and approvals.
admin.get("/runs/:id/trace", async (c) => {
  const sql = sqlFor(c.env);
  const id = c.req.param("id");
  const [session] = await sql`select workspace_id from naive_sessions where id = ${id}`;
  if (!session) throw new ApiError(404, "not_found", `No run with session id ${id}`);
  const ws = session.workspace_id as string;
  const detail = await getRunDetail(sql, c.env, ws, id, undefined, { readOnly: true });
  const events = await sql`select seq, type, data, created_at from naive_session_events
                           where workspace_id = ${ws} and session_id = ${id} order by seq limit 5000`;
  await logEvent(sql, ws, detail.run.lead_id, "admin_viewed", { admin: actorOf(c.get("principal")), what: "trace", session_id: id });
  return c.json({ workspace_id: ws, ...detail, events });
});
