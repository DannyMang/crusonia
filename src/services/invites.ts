// Invites: how a teammate joins a workspace. Created by an owner or admin, and sent by email from the instance's own
// inbox (AGENTMAIL_INBOX_ID) as a fixed template (src/services/invite-email.ts), which any workspace may do, unlike
// outreach (canSendEmail), so sending is tightly limited, and needs a workspace owner with a verified email.
//
// A token is 32 random bytes, emailed once and stored only as its SHA-256; resending mints a new one and the old link
// stops working. Accepting needs a signed-in Clerk user with the invited address among their verified emails (read
// from Clerk, never from the session token), and claims the invite in one statement, so a token works once. It works
// while SIGNUPS_OPEN=false: being invited is the permission.
import { logEvent, type Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { newId } from "../ids.ts";
import { sha256, toHex } from "../lib/crypto.ts";
import { ApiError, notConfigured, notFound } from "../lib/errors.ts";
import { AgentMailClient } from "../providers/agentmail.ts";
import { clerkUser, clerkUsers, type ClerkProfile } from "../providers/clerk.ts";
import { ProviderError } from "../providers/http.ts";
import { inviteEmail, safeName } from "./invite-email.ts";
import { limitsConfig } from "./limits.ts";
import { listMembers } from "./team.ts";
import { getWorkspace, isBlockedUser, isOwnerWorkspace, OWNER_WORKSPACE_ID, type ClerkUser, type WorkspaceRole } from "./workspaces.ts";

export const INVITE_DAYS = 7;
const TOKEN_PREFIX = "inv_";
const TOKEN_RE = /^inv_[0-9a-f]{64}$/;
/** Seconds before an invite can be emailed again. */
const RESEND_COOLDOWN_SECONDS = 60;

export type InviteRole = Exclude<WorkspaceRole, "owner">;
export type InviteActor = { actor: string; role: WorkspaceRole; name?: string | undefined };

type InviteRow = {
  id: string;
  workspace_id: string;
  email: string;
  role: InviteRole;
  token_hash: string;
  inviter_name: string | null;
  expires_at: Date;
  created_at: Date;
  last_sent_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
};

/** What the app sees of an open invite. Never the token or its hash. */
export type Invite = {
  id: string;
  email: string;
  role: InviteRole;
  inviter_name: string | null;
  created_at: Date;
  expires_at: Date;
  last_sent_at: Date;
  status: "pending" | "expired";
};

const toInvite = (r: InviteRow): Invite => ({
  id: r.id,
  email: r.email,
  role: r.role,
  inviter_name: r.inviter_name,
  created_at: r.created_at,
  expires_at: r.expires_at,
  last_sent_at: r.last_sent_at,
  status: new Date(r.expires_at).getTime() > Date.now() ? "pending" : "expired",
});

async function newToken(): Promise<{ token: string; hash: string }> {
  const token = TOKEN_PREFIX + toHex(crypto.getRandomValues(new Uint8Array(32)));
  return { token, hash: await hashInviteToken(token) };
}

export const hashInviteToken = async (token: string) => toHex(await sha256(token));

const inviteUrl = (env: Env, token: string) => `${env.PUBLIC_URL.replace(/\/+$/, "")}/invite/${token}`;

function mailer(env: Env) {
  if (!env.AGENTMAIL_API_KEY) throw notConfigured("AGENTMAIL_API_KEY");
  if (!env.AGENTMAIL_INBOX_ID) throw notConfigured("AGENTMAIL_INBOX_ID");
  return new AgentMailClient(env.AGENTMAIL_API_KEY, env.AGENTMAIL_INBOX_ID);
}

/**
 * Takes one send from the daily limits, or answers 429. Serialized across the instance (invites are rare), so a burst
 * of concurrent requests can't slip past a limit.
 */
async function claimSend(sql: Sql, env: Env, ws: string, actor: string, email: string): Promise<void> {
  const cfg = limitsConfig(env);
  const [, rows] = await sql.transaction([
    sql`select pg_advisory_xact_lock(hashtext('invite-sends'))::text as locked`,
    sql`with n as (
          select
            (select count(*)::int from invite_sends where workspace_id = ${ws} and created_at > now() - interval '1 day') as workspace,
            (select count(*)::int from invite_sends where actor = ${actor} and created_at > now() - interval '1 day') as sender,
            (select count(*)::int from invite_sends where email = ${email} and created_at > now() - interval '1 day') as address,
            (select count(*)::int from invite_sends where created_at > now() - interval '1 day') as instance
        ), ins as (
          insert into invite_sends (workspace_id, actor, email)
          select ${ws}, ${actor}, ${email} from n
          where workspace < ${cfg.invitesPerWorkspacePerDay}::int and sender < ${cfg.invitesPerUserPerDay}::int
            and address < ${cfg.invitesPerEmailPerDay}::int and instance < ${cfg.invitesPerInstancePerDay}::int
          returning id
        )
        select n.*, (select count(*)::int from ins) as claimed from n`,
  ]);
  const r = rows?.[0];
  if (r?.claimed) return;
  await logEvent(sql, ws, null, "invite_rate_limited", { actor, email });
  const message =
    Number(r?.address) >= cfg.invitesPerEmailPerDay ? "That address has had enough invites for today; try again tomorrow." : "Too many invites sent today; try again tomorrow.";
  throw new ApiError(429, "invite_rate_limited", message);
}

/** Refuses an address that asked not to be contacted, here or on the instance's own inbox (where complaints land). */
async function requireContactable(sql: Sql, ws: string, email: string): Promise<void> {
  const [row] = await sql`select 1 as hit from suppressions where email = ${email} and workspace_id in (${ws}, ${OWNER_WORKSPACE_ID}) limit 1`;
  if (row) throw new ApiError(422, "email_suppressed", "This address can't be invited: it asked not to be contacted");
}

const verifiedEmail = (p: ClerkProfile | undefined) => {
  const primary = p?.email?.trim().toLowerCase();
  return primary && p?.verified_emails.includes(primary) ? primary : (p?.verified_emails[0] ?? null);
};

/**
 * The verified address an invite is sent under: the inviter's, else a workspace owner's. Strangers can invite people from
 * the instance's own inbox, so a workspace with no verified owner email may not (403 owner_email_unverified, also when
 * Clerk doesn't answer). The owner workspace is the instance owner's own, so it only uses the address when there is one.
 */
async function inviteSender(sql: Sql, env: Env, ws: string, by: InviteActor): Promise<string | null> {
  const owners = (await sql`select clerk_user_id from workspace_members where workspace_id = ${ws} and role = 'owner' order by created_at limit 20`).map((r) => r.clerk_user_id as string);
  const inviter = by.actor.startsWith("clerk:") ? by.actor.slice("clerk:".length) : null;
  const profiles = await clerkUsers(env, [...new Set([...owners, ...(inviter ? [inviter] : [])])]);
  const ownerEmail = owners.map((id) => verifiedEmail(profiles.get(id))).find(Boolean) ?? null;
  if (!ownerEmail && !isOwnerWorkspace(ws)) {
    throw new ApiError(403, "owner_email_unverified", "A workspace owner needs a verified email address before this workspace can send invites");
  }
  return (inviter ? verifiedEmail(profiles.get(inviter)) : null) ?? ownerEmail;
}

/** Sends the email. An ambiguous failure counts as a failure: the worst case is one dead link in someone's inbox. */
async function sendInvite(
  env: Env,
  invite: { id: string; email: string; role: InviteRole; inviter_name: string | null },
  workspaceName: string,
  token: string,
  senderEmail: string | null,
): Promise<void> {
  const client = mailer(env);
  const mail = inviteEmail({
    workspaceName,
    inviterName: invite.inviter_name,
    inviterEmail: senderEmail,
    role: invite.role,
    email: invite.email,
    url: inviteUrl(env, token),
    expiresInDays: INVITE_DAYS,
  });
  try {
    // A reply goes to the person who invited them, not to the instance owner's inbox.
    await client.send({ to: invite.email, ...mail, labels: ["invite", `invite-${invite.id}`], ...(senderEmail ? { reply_to: senderEmail } : {}) });
  } catch (err) {
    if (err instanceof ProviderError) throw new ApiError(502, "invite_email_failed", "The invite email could not be sent; try again");
    throw err;
  }
}

/** Creates an invite and emails it. 409 invite_exists / already_member, 422 email_suppressed, 429 invite_rate_limited. */
export async function createInvite(sql: Sql, env: Env, ws: string, input: { email: string; role: InviteRole }, by: InviteActor): Promise<Invite> {
  const email = input.email.trim().toLowerCase();
  mailer(env); // 503 before anything else when email is not set up
  const workspace = await getWorkspace(sql, ws);
  // The kill switch stops every outgoing email of this workspace.
  if (workspace.paused) throw new ApiError(409, "workspace_paused", "Sends are paused in this workspace. Resume them to send invites.");
  await requireContactable(sql, ws, email);
  const members = await listMembers(sql, env, ws);
  if (members.some((m) => m.email?.toLowerCase() === email)) throw new ApiError(409, "already_member", "That person is already in this workspace");
  const [open] = await sql`
    select 1 as hit from workspace_invites
    where workspace_id = ${ws} and email = ${email} and accepted_at is null and revoked_at is null and expires_at > now()`;
  if (open) throw new ApiError(409, "invite_exists", "That address already has an open invite. Resend it instead.");
  const senderEmail = await inviteSender(sql, env, ws, by);

  await claimSend(sql, env, ws, by.actor, email);
  const { token, hash } = await newToken();
  const id = newId("inv");
  const inviterName = safeName(by.name);
  const [, inserted] = await sql.transaction([
    // An expired invite no longer holds the address's one open slot.
    sql`update workspace_invites set revoked_at = now()
        where workspace_id = ${ws} and email = ${email} and accepted_at is null and revoked_at is null and expires_at <= now()`,
    sql`insert into workspace_invites (id, workspace_id, email, role, token_hash, invited_by, inviter_name, expires_at)
        values (${id}, ${ws}, ${email}, ${input.role}, ${hash}, ${by.actor}, ${inviterName}, now() + make_interval(days => ${INVITE_DAYS}))
        on conflict (workspace_id, email) where accepted_at is null and revoked_at is null do nothing
        returning *`,
  ]);
  const row = inserted?.[0] as InviteRow | undefined;
  if (!row) throw new ApiError(409, "invite_exists", "That address already has an open invite. Resend it instead.");
  try {
    await sendInvite(env, row, workspace.name, token, senderEmail);
  } catch (err) {
    // Nobody got a link: free the address so they can try again.
    await sql`delete from workspace_invites where id = ${id} and workspace_id = ${ws}`;
    throw err;
  }
  await logEvent(sql, ws, null, "member_invited", { invite_id: id, email, role: input.role, actor: by.actor });
  return toInvite(row);
}

/** Open invites (including expired ones nobody has replaced), newest first. */
export async function listInvites(sql: Sql, ws: string): Promise<Invite[]> {
  const rows = await sql`
    select * from workspace_invites
    where workspace_id = ${ws} and accepted_at is null and revoked_at is null
    order by created_at desc, id desc limit 200`;
  return (rows as InviteRow[]).map(toInvite);
}

/** Mints a new token (the old link stops working), restarts the 7 days and sends the email again. */
export async function resendInvite(sql: Sql, env: Env, ws: string, id: string, by: InviteActor): Promise<Invite> {
  mailer(env);
  const workspace = await getWorkspace(sql, ws);
  if (workspace.paused) throw new ApiError(409, "workspace_paused", "Sends are paused in this workspace. Resume them to send invites.");
  const [found] = await sql`
    select *, last_sent_at > now() - make_interval(secs => ${RESEND_COOLDOWN_SECONDS}) as too_soon
    from workspace_invites where id = ${id} and workspace_id = ${ws} and accepted_at is null and revoked_at is null`;
  if (!found) throw notFound("Invite");
  const row = found as InviteRow & { too_soon: boolean };
  if (row.too_soon) throw new ApiError(429, "invite_resend_too_soon", "That invite was just sent; wait a minute before resending");
  await requireContactable(sql, ws, row.email);
  const senderEmail = await inviteSender(sql, env, ws, by);
  await claimSend(sql, env, ws, by.actor, row.email);
  const { token, hash } = await newToken();
  // The email first: if it fails, the link already in their inbox keeps working.
  await sendInvite(env, row, workspace.name, token, senderEmail);
  const [updated] = await sql`
    update workspace_invites
    set token_hash = ${hash}, last_sent_at = now(), expires_at = now() + make_interval(days => ${INVITE_DAYS})
    where id = ${id} and workspace_id = ${ws} and accepted_at is null and revoked_at is null
    returning *`;
  if (!updated) throw notFound("Invite");
  await logEvent(sql, ws, null, "invite_resent", { invite_id: id, email: row.email, actor: by.actor });
  return toInvite(updated as InviteRow);
}

export async function revokeInvite(sql: Sql, ws: string, id: string, actor: string): Promise<void> {
  const [row] = await sql`
    with up as (
      update workspace_invites set revoked_at = now()
      where id = ${id} and workspace_id = ${ws} and accepted_at is null and revoked_at is null
      returning id, email
    ), ev as (
      insert into events (workspace_id, lead_id, kind, data)
      select ${ws}, null, 'invite_revoked', jsonb_build_object('invite_id', id, 'email', email, 'actor', ${actor}::text) from up
    )
    select id from up`;
  if (!row) throw notFound("Invite");
}

const CLOSED: Record<"used" | "revoked" | "expired", [string, string]> = {
  used: ["invite_used", "This invite was already used"],
  revoked: ["invite_revoked", "This invite was revoked"],
  expired: ["invite_expired", "This invite has expired"],
};

function closedReason(row: { accepted_at: unknown; revoked_at: unknown; expires_at: Date | string }): keyof typeof CLOSED | null {
  if (row.accepted_at) return "used";
  if (row.revoked_at) return "revoked";
  return new Date(row.expires_at).getTime() <= Date.now() ? "expired" : null;
}

async function findByToken(sql: Sql, token: string) {
  if (!TOKEN_RE.test(token)) throw new ApiError(404, "invite_not_found", "This invite link is not valid");
  const [row] = await sql`
    select i.*, w.name as workspace_name from workspace_invites i join workspaces w on w.id = i.workspace_id
    where i.token_hash = ${await hashInviteToken(token)}`;
  if (!row) throw new ApiError(404, "invite_not_found", "This invite link is not valid");
  return row as InviteRow & { workspace_name: string };
}

export type InvitePreview = { workspace_name: string; inviter_name: string | null; email: string; role: InviteRole; expires_at: Date };

/** What the invite page shows before anyone signs in. Only an open invite says anything about itself. */
export async function previewInvite(sql: Sql, token: string): Promise<InvitePreview> {
  const row = await findByToken(sql, token);
  const closed = closedReason(row);
  if (closed) throw new ApiError(410, ...CLOSED[closed]);
  return { workspace_name: row.workspace_name, inviter_name: row.inviter_name, email: row.email, role: row.role, expires_at: row.expires_at };
}

export type AcceptedInvite = { workspace: { id: string; name: string; role: WorkspaceRole }; already_member: boolean };

/**
 * Joins the workspace. 403 invite_email_mismatch unless the invited address is one of the user's verified emails, 410
 * when the invite is used, revoked or expired, 503 clerk_unavailable when Clerk can't say. A person already in the
 * workspace keeps their role, and the invite is used up.
 */
export async function acceptInvite(sql: Sql, env: Env, token: string, user: ClerkUser): Promise<AcceptedInvite> {
  const { userId } = user;
  if (isBlockedUser(env, userId)) throw new ApiError(403, "account_blocked", "This account is blocked on this Crusonia instance");
  const invite = await findByToken(sql, token);
  const closed = closedReason(invite);
  if (closed) throw new ApiError(410, ...CLOSED[closed]);

  const profile = await clerkUser(env, userId);
  if (!profile) throw new ApiError(503, "clerk_unavailable", "Could not check your email address; try again");
  if (!profile.verified_emails.includes(invite.email)) {
    await logEvent(sql, invite.workspace_id, null, "invite_refused", { invite_id: invite.id, user: `clerk:${userId}`, reason: "email_mismatch" });
    throw new ApiError(403, "invite_email_mismatch", `This invite is for ${invite.email}. Sign in with that address to accept it.`, { invited_email: invite.email });
  }

  // One statement: the conditions and the claim can't be separated, so a token can only ever be used once.
  const [row] = await sql`
    with claimed as (
      update workspace_invites set accepted_at = now(), accepted_by = ${userId}
      where id = ${invite.id} and token_hash = ${invite.token_hash} and accepted_at is null and revoked_at is null and expires_at > now()
      returning workspace_id, role, id
    ), joined as (
      insert into workspace_members (workspace_id, clerk_user_id, role)
      select workspace_id, ${userId}, role from claimed
      on conflict (workspace_id, clerk_user_id) do nothing
      returning role
    ), ev as (
      insert into events (workspace_id, lead_id, kind, data)
      select workspace_id, null, 'invite_accepted',
             jsonb_build_object('invite_id', id, 'user', ${`clerk:${userId}`}::text, 'role', role, 'already_member', not exists (select 1 from joined))
      from claimed
    )
    select (select count(*)::int from claimed) as claimed, (select count(*)::int from joined) as joined`;
  if (!row?.claimed) throw new ApiError(410, ...CLOSED.used);
  const [member] = await sql`select role from workspace_members where workspace_id = ${invite.workspace_id} and clerk_user_id = ${userId}`;
  return {
    workspace: { id: invite.workspace_id, name: invite.workspace_name, role: (member?.role ?? invite.role) as WorkspaceRole },
    already_member: !row.joined,
  };
}
