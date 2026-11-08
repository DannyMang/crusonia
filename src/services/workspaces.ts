// Workspaces: every /api and /mcp call acts on exactly one. How each caller resolves to its workspace:
//   Clerk session   one of the user's workspaces (workspace_members): the one named by X-Crusonia-Workspace, checked
//                   against membership on every request, else the default (the owner workspace for OWNER_CLERK_USER_ID,
//                   otherwise their oldest). A user with none gets one on first sign-in, with the free credits.
//   crs_live_ key   the key's workspace (api_keys.workspace_id); a header naming another one is refused
//   MCP_TOKEN       the owner workspace; same
// Webhooks map back through the row they are about (a Naive session, an email thread, a Stripe customer).
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
export const blockedUserIds = (env: Env) => list(env.BLOCKED_USER_IDS);
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

/** The header the web app names the current workspace with. Only ever a request: see workspaceForClerkUser. */
export const WORKSPACE_HEADER = "x-crusonia-workspace";

export const ROLES = ["owner", "admin", "member"] as const;
export type WorkspaceRole = (typeof ROLES)[number];
const RANK: Record<WorkspaceRole, number> = { member: 0, admin: 1, owner: 2 };
export const roleAtLeast = (role: WorkspaceRole, min: WorkspaceRole) => RANK[role] >= RANK[min];

export type ClerkUser = { userId: string; email?: string; name?: string };

/** Refused the same way whether the workspace exists or not, so the answer says nothing about other workspaces. */
export const notAMember = () => new ApiError(403, "not_a_member", "You are not a member of that workspace");

/**
 * The workspace a signed-in Clerk user acts on for this request, and their role in it. Reads workspace_members every
 * time: there is no cache, so a removed member loses access on their next request.
 * 403 account_blocked for BLOCKED_USER_IDS, 403 not_a_member when `requested` is not one of theirs, 403 signups_closed
 * for a user with no workspace while SIGNUPS_OPEN is false. `onCreated` runs once for a new workspace (the billing
 * account and free credits; injected to avoid a cycle).
 */
export async function workspaceForClerkUser(
  sql: Sql,
  env: Env,
  user: ClerkUser,
  opts: { requested?: string; onCreated?: (workspaceId: string) => Promise<void> } = {},
): Promise<Workspace & { role: WorkspaceRole; created: boolean }> {
  const { userId } = user;
  const { requested, onCreated } = opts;
  if (isBlockedUser(env, userId)) throw new ApiError(403, "account_blocked", "This account is blocked on this Crusonia instance");
  const rows = (await sql`select workspace_id, role from workspace_members where clerk_user_id = ${userId} order by created_at, workspace_id`) as {
    workspace_id: string;
    role: WorkspaceRole;
  }[];
  const found = (m: { workspace_id: string; role: WorkspaceRole }) => ({ ...workspaceRef(m.workspace_id), role: m.role, created: false });

  // OWNER_CLERK_USER_ID always belongs to the owner workspace, and it is their default.
  if (isOwnerUser(env, userId) && !rows.some((m) => m.workspace_id === OWNER_WORKSPACE_ID)) {
    await sql`insert into workspace_members (workspace_id, clerk_user_id, role) values (${OWNER_WORKSPACE_ID}, ${userId}, 'owner') on conflict do nothing`;
    rows.unshift({ workspace_id: OWNER_WORKSPACE_ID, role: "owner" });
  }
  if (requested !== undefined) {
    const member = rows.find((m) => m.workspace_id === requested);
    if (!member) throw notAMember();
    return found(member);
  }
  const preferred = isOwnerUser(env, userId) ? rows.find((m) => m.workspace_id === OWNER_WORKSPACE_ID) : rows[0];
  if (preferred) return found(preferred);
  if (!signupsOpen(env) && !isInvitedUser(env, userId)) {
    throw new ApiError(403, "signups_closed", "Sign-ups are closed on this Crusonia instance; ask the owner for access");
  }

  // Serialized per user: two first requests at once create one workspace, and both get it. Someone who already made a
  // workspace (they were removed from it, or left it) gets a new one without a second free sample.
  const id = newId("ws");
  const name = (user.name ? `${user.name}'s workspace` : user.email ? `${user.email}'s workspace` : "My workspace").slice(0, 200);
  const [, , , created] = await sql.transaction([
    sql`select pg_advisory_xact_lock(hashtext(${`workspace-member:${userId}`}))::text as locked`,
    sql`insert into workspaces (id, name, created_by, no_free_sample)
        select ${id}, ${name}, ${userId}, exists (select 1 from workspaces where created_by = ${userId})
        where not exists (select 1 from workspace_members where clerk_user_id = ${userId})`,
    sql`insert into workspace_members (workspace_id, clerk_user_id, role)
        select ${id}, ${userId}, 'owner' where exists (select 1 from workspaces where id = ${id})
        on conflict do nothing`,
    sql`select workspace_id, role from workspace_members where clerk_user_id = ${userId} order by created_at, workspace_id limit 1`,
  ]);
  const workspaceId = created?.[0]?.workspace_id as string | undefined;
  if (!workspaceId) throw new ApiError(500, "workspace_failed", "Could not create a workspace for this account; try again");
  const isNew = workspaceId === id;
  if (isNew) {
    await logEvent(sql, workspaceId, null, "workspace_created", { actor: `clerk:${userId}` });
    await onCreated?.(workspaceId);
  }
  return { ...workspaceRef(workspaceId), role: created?.[0]?.role as WorkspaceRole, created: isNew };
}

export type MyWorkspace = { id: string; name: string; role: WorkspaceRole; owner: boolean; joined_at: Date };

/** The workspaces a user belongs to: the owner workspace first, then oldest first. For the switcher. */
export async function workspacesOf(sql: Sql, userId: string): Promise<MyWorkspace[]> {
  const rows = await sql`
    select w.id, w.name, m.role, m.created_at as joined_at
    from workspace_members m join workspaces w on w.id = m.workspace_id
    where m.clerk_user_id = ${userId}
    order by (w.id = ${OWNER_WORKSPACE_ID}) desc, m.created_at, w.id`;
  return rows.map((r) => ({ ...(r as Omit<MyWorkspace, "owner">), owner: isOwnerWorkspace(r.id as string) }));
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
