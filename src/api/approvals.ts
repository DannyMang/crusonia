// /api/approvals: list, inspect, approve (send / allow), reject (deny), edit (new draft version), answer.
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, approvalTtlMinutes, parseJson, parseQuery, sqlFor, type AppEnv } from "../lib/context.ts";
import { ApiError } from "../lib/errors.ts";
import {
  answerQuestion,
  APPROVAL_STATUSES,
  editApproval,
  getApproval,
  listApprovals,
  rejectApproval,
  resolveTool,
  type Deps,
} from "../services/approvals.ts";
import { approveAndSend } from "../services/send.ts";

export const approvals = new Hono<AppEnv>();

const deps = (c: { env: AppEnv["Bindings"]; get: (k: "principal") => AppEnv["Variables"]["principal"] }): Deps => ({
  sql: sqlFor(c.env),
  env: c.env,
  actor: actorOf(c.get("principal")),
  ttlMinutes: approvalTtlMinutes(c.env),
});

const ListQuery = z.object({
  status: z.enum(APPROVAL_STATUSES).default("pending"),
  kind: z.enum(["send", "tool", "question"]).optional(),
  lead_id: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

approvals.get("/", async (c) => {
  const query = parseQuery(c, ListQuery);
  return c.json({ data: await listApprovals(sqlFor(c.env), query) });
});

approvals.get("/:code", async (c) => c.json({ approval: await getApproval(sqlFor(c.env), c.req.param("code")) }));

const ApproveBody = z.object({ scope: z.enum(["call", "session"]).optional() });

// send: re-checks every rule and sends through AgentMail. tool: allows the call (scope `session` allows
// the tool for the rest of that Naive session). question: use /answer.
approvals.post("/:code/approve", async (c) => {
  const d = deps(c);
  const approval = await getApproval(d.sql, c.req.param("code"));
  if (approval.kind === "send") {
    const result = await approveAndSend({ sql: d.sql, env: c.env, actor: d.actor }, approval.code);
    return c.json(result, result.status === "sent" ? 200 : 202);
  }
  if (approval.kind === "tool") {
    const body = await parseJson(c, ApproveBody);
    return c.json(await resolveTool(d, approval, { decision: "allow", scope: body.scope }));
  }
  throw new ApiError(409, "wrong_kind", "Questions are answered, not approved: POST /api/approvals/:code/answer");
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

const ToolAnswer = z.object({
  decision: z.enum(["allow", "deny"]),
  reason: z.string().trim().min(1).max(1000).optional(),
  scope: z.enum(["call", "session"]).optional(),
});
const QuestionAnswer = z.object({
  answers: z.record(z.string().min(1).max(100), z.union([z.string().max(4000), z.array(z.string().max(4000)).max(20)])),
});

// tool: {decision: "allow"|"deny", reason?, scope?}. question: {answers: {<field key>: "text"}}.
approvals.post("/:code/answer", async (c) => {
  const d = deps(c);
  const approval = await getApproval(d.sql, c.req.param("code"));
  if (approval.kind === "tool") return c.json(await resolveTool(d, approval, await parseJson(c, ToolAnswer)));
  if (approval.kind === "question") return c.json(await answerQuestion(d, approval, (await parseJson(c, QuestionAnswer)).answers));
  throw new ApiError(409, "wrong_kind", "Send approvals are approved, rejected or edited, not answered");
});
