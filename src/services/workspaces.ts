// Workspaces: every /api and /mcp call acts on exactly one. How each caller resolves to its workspace:
//   Clerk session   the user's workspace (workspace_members), created on first sign-in with the free credits;
//                   OWNER_CLERK_USER_ID always maps to the owner workspace
//   crs_live_ key   the key's workspace (api_keys.workspace_id)
//   MCP_TOKEN       the owner workspace
// Webhooks map back through the row they are about (a Naive session, an email thread, a Stripe customer).
// One user per workspace for now (unique workspace_members.clerk_user_id).
import { logEvent, type Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { newId } from "../ids.ts";
import { ApiError } from "../lib/errors.ts";

/** The instance owner's workspace: MCP_TOKEN, OWNER_CLERK_USER_ID and every row from before workspaces. */
export const OWNER_WORKSPACE_ID = "ws_owner";

export type Workspace = { id: string; owner: boolean };

export const workspaceRef = (id: string): Workspace => ({ id, owner: id === OWNER_WORKSPACE_ID });
export const OWNER_WORKSPACE: Workspace = workspaceRef(OWNER_WORKSPACE_ID);
export const isOwnerWorkspace = (id: string) => id === OWNER_WORKSPACE_ID;

const list = (raw: string | undefined) =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** SIGNUPS_OPEN: anyone who signs up gets a workspace (default). "false" lets only existing members in. */
export const signupsOpen = (env: Env) => !/^(0|false|no|off)$/i.test(env.SIGNUPS_OPEN?.trim() ?? "");
export const isBlockedUser = (env: Env, userId: string) => list(env.BLOCKED_USER_IDS).includes(userId);
/** SIGNUP_ALLOWED_USER_IDS: Clerk users the owner has approved; they may create a workspace while sign-ups are closed. */
export const isInvitedUser = (env: Env, userId: string) => Boolean(userId) && list(env.SIGNUP_ALLOWED_USER_IDS).includes(userId);
export const isOwnerUser = (env: Env, userId: string) => Boolean(userId) && env.OWNER_CLERK_USER_ID?.trim() === userId;
/**
 * Every workspace sends from this instance's one AgentMail inbox (AGENTMAIL_INBOX_ID: the owner's address and domain),
 * so only the owner workspace and the ones listed in SEND_WORKSPACE_IDS may send email. Otherwise anyone who signs up
 * could type a consent note on a lead, approve their own draft and email anyone from the owner's address.
 */
export const canSendEmail = (env: Env, workspaceId: string) => isOwnerWorkspace(workspaceId) || list(env.SEND_WORKSPACE_IDS).includes(workspaceId);

// Per-isolate cache of user -> workspace (memberships never move, so a short TTL is only about memory).
const CACHE_TTL_MS = 5 * 60_000;
const memberCache = new Map<string, { id: string; at: number }>();
export const resetWorkspaceCache = () => memberCache.clear();

export type ClerkUser = { userId: string; email?: string; name?: string };

/**
 * The workspace of a signed-in Clerk user, created on their first sign-in (plus the free sample credits, once).
 * 403 account_blocked for BLOCKED_USER_IDS, 403 signups_closed for a new user while SIGNUPS_OPEN is false.
 * `onCreated` runs once for a new workspace (the billing account and free credits; injected to avoid a cycle).
 */
export async function workspaceForClerkUser(
  sql: Sql,
  env: Env,
  user: ClerkUser,
  onCreated?: (workspaceId: string) => Promise<void>,
): Promise<Workspace & { created: boolean }> {
  const { userId } = user;
  if (isBlockedUser(env, userId)) throw new ApiError(403, "account_blocked", "This account is blocked on this Crusonia instance");
  if (isOwnerUser(env, userId)) {
    if (!memberCache.has(userId)) {
      await sql`insert into workspace_members (workspace_id, clerk_user_id, role) values (${OWNER_WORKSPACE_ID}, ${userId}, 'owner')
                on conflict do nothing`;
      memberCache.set(userId, { id: OWNER_WORKSPACE_ID, at: Date.now() });
    }
    return { ...OWNER_WORKSPACE, created: false };
  }
  const cached = memberCache.get(userId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return { ...workspaceRef(cached.id), created: false };

  const [existing] = await sql`select workspace_id from workspace_members where clerk_user_id = ${userId}`;
  if (existing) {
    memberCache.set(userId, { id: existing.workspace_id as string, at: Date.now() });
    return { ...workspaceRef(existing.workspace_id as string), created: false };
  }
  if (!signupsOpen(env) && !isInvitedUser(env, userId)) {
    throw new ApiError(403, "signups_closed", "Sign-ups are closed on this Crusonia instance; ask the owner for access");
  }

  // Serialized per user: two first requests at once create one workspace, and both get it.
  const id = newId("ws");
  const name = (user.name ? `${user.name}'s workspace` : user.email ? `${user.email}'s workspace` : "My workspace").slice(0, 200);
  const [, , , rows] = await sql.transaction([
    sql`select pg_advisory_xact_lock(hashtext(${`workspace-member:${userId}`}))::text as locked`,
    sql`insert into workspaces (id, name)
        select ${id}, ${name} where not exists (select 1 from workspace_members where clerk_user_id = ${userId})`,
    sql`insert into workspace_members (workspace_id, clerk_user_id, role)
        select ${id}, ${userId}, 'owner' where exists (select 1 from workspaces where id = ${id})
        on conflict do nothing`,
    sql`select workspace_id from workspace_members where clerk_user_id = ${userId}`,
  ]);
  const workspaceId = rows?.[0]?.workspace_id as string | undefined;
  if (!workspaceId) throw new ApiError(500, "workspace_failed", "Could not create a workspace for this account; try again");
  const created = workspaceId === id;
  if (created) {
    await logEvent(sql, workspaceId, null, "workspace_created", { actor: `clerk:${userId}` });
    await onCreated?.(workspaceId);
  }
  memberCache.set(userId, { id: workspaceId, at: Date.now() });
  return { ...workspaceRef(workspaceId), created };
}

export type WorkspaceRow = {
  id: string;
  name: string;
  paused: boolean;
  daily_cap_micro_usd: string | number | null;
  created_at: Date;
};

export async function getWorkspace(sql: Sql, id: string): Promise<WorkspaceRow> {
  const [row] = await sql`select id, name, paused, daily_cap_micro_usd, created_at from workspaces where id = ${id}`;
  if (!row) throw new ApiError(404, "not_found", "Workspace not found");
  return row as WorkspaceRow;
}
