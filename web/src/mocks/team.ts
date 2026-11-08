// /api/workspaces, /api/team/* and /api/invites/* mocks, in the backend's shapes (src/api/team.ts). Sample data mirrors
// the Paper designs. An invite link in dev: /invite/inv_mock (also inv_expired, inv_revoked, inv_used).
import { http } from "msw";
import type { InviteRole, MyWorkspace, TeamInvite, TeamMember, WorkspaceRole } from "../api.ts";
import { ago, ahead, body, DAY, fail, noContent, ok } from "./util.ts";

const workspaces: MyWorkspace[] = [
  { id: "ws_acme", name: "Acme", role: "owner", owner: false },
  { id: "ws_fieldnote", name: "Fieldnote", role: "member", owner: false },
];
let current = "ws_acme";

const members: TeamMember[] = [
  { user_id: "user_mock", role: "owner", joined_at: ago(5 * DAY), email: "daniel@acme.com", name: "Daniel Ung" },
  { user_id: "user_maya", role: "admin", joined_at: ago(2 * DAY), email: "maya@acme.com", name: "Maya Chen" },
  { user_id: "user_tom", role: "member", joined_at: ago(1 * DAY), email: "tom@acme.com", name: "Tom Okafor" },
];

const invite = (id: string, email: string, role: InviteRole, expires: string, status: TeamInvite["status"]): TeamInvite => ({
  id,
  email,
  role,
  inviter_name: "Daniel Ung",
  created_at: ago(1 * DAY),
  expires_at: expires,
  last_sent_at: ago(1 * DAY),
  status,
});

const invites: TeamInvite[] = [invite("inv_1", "priya@acme.com", "member", ahead(6 * DAY), "pending"), invite("inv_2", "sam@acme.com", "admin", ago(1 * DAY), "expired")];

const CLOSED: Record<string, [number, string, string]> = {
  inv_expired: [410, "invite_expired", "This invite has expired"],
  inv_revoked: [410, "invite_revoked", "This invite was revoked"],
  inv_used: [410, "invite_used", "This invite was already used"],
};

export const teamHandlers = [
  http.get("/api/workspaces", ({ request }) => ok({ current: request.headers.get("X-Crusonia-Workspace") ?? current, data: workspaces })),
  http.post("/api/workspaces", async ({ request }) => {
    const name = (await body<{ name?: string }>(request)).name?.trim();
    if (!name) return fail(400, "invalid_request", "name: Required");
    const workspace: MyWorkspace = { id: `ws_${Date.now()}`, name, role: "owner", owner: false };
    workspaces.push(workspace);
    current = workspace.id;
    return ok({ workspace }, 201);
  }),
  http.patch("/api/workspaces/current", async ({ request }) => {
    const name = (await body<{ name?: string }>(request)).name?.trim() ?? "";
    const w = workspaces.find((x) => x.id === (request.headers.get("X-Crusonia-Workspace") ?? current));
    if (w) w.name = name;
    return ok({ workspace: { id: w?.id ?? current, name } });
  }),

  http.get("/api/team/members", () => ok({ data: members })),
  http.patch("/api/team/members/:id", async ({ params, request }) => {
    const role = (await body<{ role?: WorkspaceRole }>(request)).role;
    const m = members.find((x) => x.user_id === params.id);
    if (!m || !role) return fail(404, "not_found", "Member not found");
    m.role = role;
    return ok({ member: { user_id: m.user_id, role } });
  }),
  http.delete("/api/team/members/:id", ({ params }) => {
    const i = members.findIndex((x) => x.user_id === params.id);
    if (i < 0) return fail(404, "not_found", "Member not found");
    members.splice(i, 1);
    return noContent();
  }),
  http.post("/api/team/leave", () => fail(409, "last_owner", "A workspace needs an owner. Make someone else an owner first.")),

  http.get("/api/team/invites", () => ok({ data: invites })),
  http.post("/api/team/invites", async ({ request }) => {
    const b = await body<{ email?: string; role?: InviteRole }>(request);
    const email = b.email?.trim().toLowerCase() ?? "";
    if (invites.some((i) => i.email === email)) return fail(409, "invite_exists", "That address already has an open invite. Resend it instead.");
    const created = invite(`inv_${Date.now()}`, email, b.role ?? "member", ahead(7 * DAY), "pending");
    invites.unshift(created);
    return ok({ invite: created }, 201);
  }),
  http.post("/api/team/invites/:id/resend", ({ params }) => {
    const i = invites.find((x) => x.id === params.id);
    if (!i) return fail(404, "not_found", "Invite not found");
    Object.assign(i, { status: "pending", expires_at: ahead(7 * DAY), last_sent_at: new Date().toISOString() });
    return ok({ invite: i });
  }),
  http.delete("/api/team/invites/:id", ({ params }) => {
    const i = invites.findIndex((x) => x.id === params.id);
    if (i < 0) return fail(404, "not_found", "Invite not found");
    invites.splice(i, 1);
    return noContent();
  }),

  http.get("/api/invites/:token", ({ params }) => {
    const closed = CLOSED[String(params.token)];
    if (closed) return fail(...closed);
    if (params.token !== "inv_mock") return fail(404, "invite_not_found", "This invite link is not valid");
    return ok({ invite: { workspace_name: "Acme", inviter_name: "Daniel Ung", email: "priya@acme.com", role: "admin", expires_at: ahead(6 * DAY) } });
  }),
  http.post("/api/invites/:token/accept", () => ok({ workspace: { id: "ws_acme", name: "Acme", role: "admin" }, already_member: false })),
];
