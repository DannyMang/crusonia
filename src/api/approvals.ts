// /api/approvals: list, inspect, approve (send), reject, edit (new draft version).
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, parseJson, parseQuery, sqlFor, wsOf, type AppEnv } from "../lib/context.ts";
import {
  APPROVAL_STATUSES,
  editApproval,
  getApproval,
  listApprovals,
  rejectApproval,
  type Deps,
} from "../services/approvals.ts";
import { sendApprovalTtlMinutes } from "../services/approval-ttl.ts";
import { approveAndSend } from "../services/send.ts";

export const approvals = new Hono<AppEnv>();

const deps = (c: { env: AppEnv["Bindings"]; var: AppEnv["Variables"] }): Deps => ({
  sql: sqlFor(c.env),
  ws: c.var.workspace.id,
  env: c.env,
  actor: actorOf(c.var.principal),
  sendTtlMinutes: sendApprovalTtlMinutes(c.env),
});

const ListQuery = z.object({
  status: z.enum(APPROVAL_STATUSES).default("pending"),
  kind: z.enum(["send"]).optional(),
  lead_id: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

approvals.get("/", async (c) => {
  const query = parseQuery(c, ListQuery);
  return c.json({ data: await listApprovals(sqlFor(c.env), wsOf(c), query) });
});

approvals.get("/:code", async (c) => c.json({ approval: await getApproval(sqlFor(c.env), wsOf(c), c.req.param("code")) }));

// Re-checks every rule and sends through AgentMail.
approvals.post("/:code/approve", async (c) => {
  const d = deps(c);
  const approval = await getApproval(d.sql, d.ws, c.req.param("code"));
  const result = await approveAndSend({ sql: d.sql, ws: d.ws, env: c.env, actor: d.actor }, approval.code);
  return c.json(result, result.status === "sent" ? 200 : 202);
});

const RejectBody = z.object({ reason: z.string().trim().min(1).max(1000).optional() });

approvals.post("/:code/reject", async (c) => {
  const body = await parseJson(c, RejectBody);
  return c.json(await rejectApproval(deps(c), c.req.param("code"), body.reason));
});

const EditBody = z
  .object({ subject: z.string().trim().min(1).max(200).optional(), body: z.string().trim().min(1).max(10_000).optional() })
  .strict();

// Omitting both fields re-requests approval for the same content (e.g. after it expired or a send failed).
approvals.post("/:code/edit", async (c) => {
  const body = await parseJson(c, EditBody);
  return c.json(await editApproval(deps(c), c.req.param("code"), body), 201);
});
