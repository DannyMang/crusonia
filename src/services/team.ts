// Who is in a workspace and what they may do. Roles: an owner can do everything, an admin everything but touch owners
// (billing, keys, team, integrations), a member none of those. Every change that could affect the owner count takes
// the workspace's team lock, so two owners demoting each other can't leave a workspace with none.
import { ensureAccount } from "../billing/accounts.ts";
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { newId } from "../ids.ts";
import { ApiError, notFound } from "../lib/errors.ts";
import { clerkUsers } from "../providers/clerk.ts";
import { limitsConfig } from "./limits.ts";
import { isInvitedUser, isOwnerUser, isOwnerWorkspace, signupsOpen, type ClerkUser, type WorkspaceRole } from "./workspaces.ts";

export type Member = {
  user_id: string;
  role: WorkspaceRole;
  joined_at: Date;
  email?: string;
  name?: string;
  image_url?: string;
};

/** Oldest first, with names and emails from Clerk when it answers (a missing one shows as just the user id). */
export async function listMembers(sql: Sql, env: Env, ws: string): Promise<Member[]> {
  const rows = (await sql`
    select clerk_user_id as user_id, role, created_at as joined_at from workspace_members
    where workspace_id = ${ws} order by created_at, clerk_user_id limit 500`) as { user_id: string; role: WorkspaceRole; joined_at: Date }[];
  const profiles = await clerkUsers(env, rows.map((r) => r.user_id));
  return rows.map((r) => {
    const p = profiles.get(r.user_id);
    return {
      ...r,
      ...(p?.email ? { email: p.email } : {}),
      ...(p?.name ? { name: p.name } : {}),
      ...(p?.image_url ? { image_url: p.image_url } : {}),
    };
  });
}

export type TeamActor = { actor: string; role: WorkspaceRole };

const teamLock = (sql: Sql, ws: string) => sql`select pg_advisory_xact_lock(hashtext(${`workspace-team:${ws}`}))::text as locked`;

const lastOwner = () => new ApiError(409, "last_owner", "A workspace needs an owner. Make someone else an owner first.");

async function memberRole(sql: Sql, ws: string, userId: string): Promise<WorkspaceRole> {
  const [row] = await sql`select role from workspace_members where workspace_id = ${ws} and clerk_user_id = ${userId}`;
  if (!row) throw notFound("Member");
  return row.role as WorkspaceRole;
}

/** The instance owner always belongs to the owner workspace as an owner (workspaceForClerkUser puts them back anyway). */
function protectInstanceOwner(env: Env, ws: string, userId: string) {
  if (isOwnerWorkspace(ws) && isOwnerUser(env, userId)) throw new ApiError(403, "forbidden_role", "The instance owner stays an owner of this workspace");
}

/** Only owners can make an owner or change one. 409 last_owner when it would leave the workspace with none. */
export async function changeRole(sql: Sql, env: Env, ws: string, userId: string, role: WorkspaceRole, by: TeamActor): Promise<{ user_id: string; role: WorkspaceRole }> {
  const current = await memberRole(sql, ws, userId);
  protectInstanceOwner(env, ws, userId);
  if (by.role !== "owner" && (current === "owner" || role === "owner")) throw new ApiError(403, "forbidden_role", "Only an owner can change an owner or make one");
  if (current === role) return { user_id: userId, role };
  const actorIsOwner = by.role === "owner";
  const [, rows] = await sql.transaction([
    teamLock(sql, ws),
    sql`with up as (
          update workspace_members m set role = ${role}
          where m.workspace_id = ${ws} and m.clerk_user_id = ${userId}
            and (${actorIsOwner}::boolean or m.role <> 'owner')
            and (m.role <> 'owner' or ${role} = 'owner'
                 or (select count(*) from workspace_members o where o.workspace_id = ${ws} and o.role = 'owner') > 1)
          returning m.role
        ), ev as (
          insert into events (workspace_id, lead_id, kind, data)
          select ${ws}, null, 'member_role_changed', jsonb_build_object('user', ${userId}::text, 'from', ${current}::text, 'to', role, 'actor', ${by.actor}::text) from up
        )
        select role from up`,
  ]);
  if (!rows?.length) throw lastOwner();
  return { user_id: userId, role };
}

/**
 * Takes a person out of the workspace, with what would otherwise outlive their access: the API keys they made and the
 * invites they sent (an ex-admin must not be able to get back in through either).
 */
async function dropMember(sql: Sql, ws: string, userId: string, by: TeamActor, kind: "member_removed" | "member_left"): Promise<void> {
  const clerkActor = `clerk:${userId}`;
  const actorIsOwner = by.role === "owner";
  const [, rows] = await sql.transaction([
    teamLock(sql, ws),
    sql`with del as (
          delete from workspace_members m
          where m.workspace_id = ${ws} and m.clerk_user_id = ${userId}
            and (${actorIsOwner}::boolean or m.role <> 'owner' or ${kind} = 'member_left')
            and (m.role <> 'owner' or (select count(*) from workspace_members o where o.workspace_id = ${ws} and o.role = 'owner') > 1)
          returning m.role
        ), keys as (
          update api_keys set revoked_at = now()
          where workspace_id = ${ws} and kind = 'user' and revoked_at is null and exists (select 1 from del)
            and id in (select e.data->>'key_id' from events e where e.workspace_id = ${ws} and e.kind = 'api_key_created' and e.data->>'actor' = ${clerkActor})
          returning id
        ), invites as (
          update workspace_invites set revoked_at = now()
          where workspace_id = ${ws} and invited_by = ${clerkActor} and accepted_at is null and revoked_at is null and exists (select 1 from del)
          returning id
        ), ev as (
          insert into events (workspace_id, lead_id, kind, data)
          select ${ws}, null, ${kind}, jsonb_build_object('user', ${userId}::text, 'role', role, 'actor', ${by.actor}::text,
                 'keys_revoked', (select count(*) from keys), 'invites_revoked', (select count(*) from invites)) from del
        )
        select role from del`,
  ]);
  if (!rows?.length) throw lastOwner();
}

/** An admin can remove members and admins; only an owner can remove an owner. Never the last owner. */
export async function removeMember(sql: Sql, env: Env, ws: string, userId: string, by: TeamActor): Promise<void> {
  const current = await memberRole(sql, ws, userId);
  protectInstanceOwner(env, ws, userId);
  if (current === "owner" && by.role !== "owner") throw new ApiError(403, "forbidden_role", "Only an owner can remove an owner");
  await dropMember(sql, ws, userId, by, "member_removed");
}

/** Anyone can leave, except the last owner. */
export async function leaveWorkspace(sql: Sql, env: Env, ws: string, userId: string): Promise<void> {
  const role = await memberRole(sql, ws, userId);
  protectInstanceOwner(env, ws, userId);
  await dropMember(sql, ws, userId, { actor: `clerk:${userId}`, role }, "member_left");
}

/**
 * A new workspace owned by the caller. The free sample is one per person: only the first workspace they make gets it.
 * While SIGNUPS_OPEN is false, people who only joined through an invite can't make one (that would turn every invite
 * into a sign-up); 403 workspace_limit past MAX_WORKSPACES_PER_USER.
 */
export async function createWorkspace(sql: Sql, env: Env, user: ClerkUser, name: string): Promise<{ id: string; name: string; role: WorkspaceRole; owner: boolean }> {
  const { userId } = user;
  if (!signupsOpen(env) && !isOwnerUser(env, userId) && !isInvitedUser(env, userId)) {
    const [owns] = await sql`select 1 as hit from workspace_members where clerk_user_id = ${userId} and role = 'owner' limit 1`;
    if (!owns) throw new ApiError(403, "signups_closed", "Sign-ups are closed on this Crusonia instance; ask the owner for access");
  }
  const id = newId("ws");
  const cap = limitsConfig(env).maxWorkspacesPerUser;
  const [, rows] = await sql.transaction([
    sql`select pg_advisory_xact_lock(hashtext(${`workspace-member:${userId}`}))::text as locked`,
    sql`with made as (
          select count(*)::int as n from workspaces where created_by = ${userId}
        ), w as (
          insert into workspaces (id, name, created_by, no_free_sample)
          select ${id}, ${name}, ${userId}, made.n > 0 from made where made.n < ${cap}::int
          returning id
        ), m as (
          insert into workspace_members (workspace_id, clerk_user_id, role) select id, ${userId}, 'owner' from w
        ), ev as (
          insert into events (workspace_id, lead_id, kind, data)
          select id, null, 'workspace_created', jsonb_build_object('actor', ${`clerk:${userId}`}::text) from w
        )
        select id from w`,
  ]);
  if (!rows?.length) throw new ApiError(403, "workspace_limit", `You can make up to ${cap} workspaces`);
  await ensureAccount(sql, env, id);
  return { id, name, role: "owner", owner: false };
}

export async function renameWorkspace(sql: Sql, ws: string, name: string, actor: string): Promise<{ id: string; name: string }> {
  const [row] = await sql`
    with up as (update workspaces set name = ${name} where id = ${ws} returning id, name),
    ev as (insert into events (workspace_id, lead_id, kind, data)
           select id, null, 'workspace_renamed', jsonb_build_object('name', name, 'actor', ${actor}::text) from up)
    select id, name from up`;
  if (!row) throw notFound("Workspace");
  return row as { id: string; name: string };
}
