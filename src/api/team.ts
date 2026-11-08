// /api/workspaces (the switcher, creating and renaming), /api/team (members and invites of the current workspace) and
// /api/invites/:token (the link in the invite email). Who may do what is decided here and in src/services/team.ts, with
// the role read from workspace_members on this request. API keys are refused by src/api/guards.ts: an agent can't
// invite people or change the team.
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { actorOf, parseJson, sqlFor, wsOf, type AppEnv, type Principal } from "../lib/context.ts";
import { ApiError } from "../lib/errors.ts";
import { clerkUser } from "../providers/clerk.ts";
import { acceptInvite, createInvite, listInvites, previewInvite, resendInvite, revokeInvite, type InviteActor } from "../services/invites.ts";
import { changeRole, createWorkspace, leaveWorkspace, listMembers, removeMember, renameWorkspace, type TeamActor } from "../services/team.ts";
import { getWorkspace, ROLES, roleAtLeast, workspacesOf, type WorkspaceRole } from "../services/workspaces.ts";
import { authenticate } from "./auth.ts";

/** 403 forbidden_role unless the caller's role in this workspace is at least `min`. */
export const requireRole =
  (min: WorkspaceRole): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const role = c.get("role");
    if (!role || !roleAtLeast(role, min)) throw new ApiError(403, "forbidden_role", `This needs the ${min} role in this workspace`);
    await next();
  };

function clerkOnly(principal: Principal, what: string) {
  if (principal.kind !== "clerk") throw new ApiError(403, "human_required", `${what} needs a signed-in person (the Crusonia app)`);
  return principal;
}

const teamActor = (c: { get(k: "principal"): Principal; get(k: "role"): WorkspaceRole }): TeamActor => ({ actor: actorOf(c.get("principal")), role: c.get("role") });

const WorkspaceName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\p{C}]+$/u, "must not contain control characters");

// ---------- /api/workspaces ----------

export const workspaces = new Hono<AppEnv>();

// The workspaces the caller can switch to. A key or MCP_TOKEN is bound to one, so that is the only one listed.
workspaces.get("/", async (c) => {
  const p = c.get("principal");
  const current = wsOf(c);
  const sql = sqlFor(c.env);
  if (p.kind === "clerk") {
    const list = await workspacesOf(sql, p.userId);
    return c.json({ current, data: list.map((w) => ({ id: w.id, name: w.name, role: w.role, owner: w.owner })) });
  }
  const w = await getWorkspace(sql, current);
  return c.json({ current, data: [{ id: w.id, name: w.name, role: c.get("role"), owner: c.get("workspace").owner }] });
});

workspaces.post("/", async (c) => {
  const p = clerkOnly(c.get("principal"), "Creating a workspace");
  const body = await parseJson(c, z.object({ name: WorkspaceName }).strict());
  return c.json({ workspace: await createWorkspace(sqlFor(c.env), c.env, p, body.name) }, 201);
});

workspaces.patch("/current", requireRole("admin"), async (c) => {
  const body = await parseJson(c, z.object({ name: WorkspaceName }).strict());
  return c.json({ workspace: await renameWorkspace(sqlFor(c.env), wsOf(c), body.name, actorOf(c.get("principal"))) });
});

// ---------- /api/team ----------

export const team = new Hono<AppEnv>();

team.get("/members", async (c) => c.json({ data: await listMembers(sqlFor(c.env), c.env, wsOf(c)) }));

team.patch("/members/:userId", requireRole("admin"), async (c) => {
  const body = await parseJson(c, z.object({ role: z.enum(ROLES) }).strict());
  return c.json({ member: await changeRole(sqlFor(c.env), c.env, wsOf(c), c.req.param("userId"), body.role, teamActor(c)) });
});

team.delete("/members/:userId", requireRole("admin"), async (c) => {
  await removeMember(sqlFor(c.env), c.env, wsOf(c), c.req.param("userId"), teamActor(c));
  return c.body(null, 204);
});

team.post("/leave", async (c) => {
  const p = clerkOnly(c.get("principal"), "Leaving a workspace");
  await leaveWorkspace(sqlFor(c.env), c.env, wsOf(c), p.userId);
  return c.body(null, 204);
});

const InviteBody = z.object({ email: z.string().trim().toLowerCase().max(254).pipe(z.email()), role: z.enum(["admin", "member"]).default("member") }).strict();

/** Who the invite email says it is from: the Clerk profile (the session token rarely carries a name). */
async function inviteActor(c: { env: AppEnv["Bindings"]; get(k: "principal"): Principal; get(k: "role"): WorkspaceRole }): Promise<InviteActor> {
  const p = c.get("principal");
  const name = p.kind === "clerk" ? (p.name ?? (await clerkUser(c.env, p.userId))?.name) : undefined;
  return { actor: actorOf(p), role: c.get("role"), name };
}

team.get("/invites", requireRole("admin"), async (c) => c.json({ data: await listInvites(sqlFor(c.env), wsOf(c)) }));

team.post("/invites", requireRole("admin"), async (c) => {
  const body = await parseJson(c, InviteBody);
  return c.json({ invite: await createInvite(sqlFor(c.env), c.env, wsOf(c), body, await inviteActor(c)) }, 201);
});

team.post("/invites/:id/resend", requireRole("admin"), async (c) => c.json({ invite: await resendInvite(sqlFor(c.env), c.env, wsOf(c), c.req.param("id"), await inviteActor(c)) }));

team.delete("/invites/:id", requireRole("admin"), async (c) => {
  await revokeInvite(sqlFor(c.env), wsOf(c), c.req.param("id"), actorOf(c.get("principal")));
  return c.body(null, 204);
});

// ---------- /api/invites/:token ----------

/**
 * The link in the email. Registered before the /api auth middleware because the person following it may have no
 * workspace yet, and no account at all: requireAuth would create a workspace for them or refuse them while sign-ups are
 * closed. The token is the credential for reading; accepting also needs a Clerk session with the invited email.
 */
export const inviteLinks = new Hono<AppEnv>();

inviteLinks.get("/:token", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ invite: await previewInvite(sqlFor(c.env), c.req.param("token")) });
});

inviteLinks.post("/:token/accept", async (c) => {
  c.header("Cache-Control", "no-store");
  const p = clerkOnly(await authenticate(c.env, c.req.header("authorization")), "Accepting an invite");
  return c.json(await acceptInvite(sqlFor(c.env), c.env, c.req.param("token"), p));
});
