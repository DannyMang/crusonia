// /api/leads: list, detail, create, CSV import, patch, delete, and owner-written drafts.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { billingOwnerOf, requireCredits } from "../billing/accounts.ts";
import { actorOf, parseJson, parseQuery, sqlFor, type AppEnv } from "../lib/context.ts";
import { ApiError, errorBody, invalidRequest } from "../lib/errors.ts";
import { sendApprovalTtlMinutes } from "../services/approval-ttl.ts";
import { createLead, deleteLead, getLeadFull, importLeads, LEAD_STAGES, patchLead, searchLeads } from "../services/crm.ts";
import { IMPORT_FIELDS } from "../services/csv.ts";
import { createDraft } from "../services/drafts.ts";
import { createFollowUp, followupInputSchema, listFollowUps } from "../services/followups.ts";
import { getFindRun, MAX_FIND_LEADS, naiveAgent, startFindLeads } from "../services/runs.ts";

export const leads = new Hono<AppEnv>();

const text = (max: number) => z.string().trim().min(1).max(max);
const consent = z.object({
  text: text(2000).describe("How and when the person opted in, e.g. 'Signed up on crusonia.dev waitlist'"),
  at: z.iso.datetime({ offset: true }).optional(),
});

const ListQuery = z.object({
  stage: z.enum(LEAD_STAGES).optional(),
  min_score: z.coerce.number().int().min(0).max(100).optional(),
  source: z.string().max(100).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
});

leads.get("/", async (c) => {
  const query = parseQuery(c, ListQuery); // validate before touching the database
  return c.json(await searchLeads(sqlFor(c.env), query));
});

const CreateBody = z.object({
  email: z.string().trim().max(320),
  name: text(200).optional(),
  title: text(200).optional(),
  company: text(200).optional(),
  domain: text(253).optional(),
  website: text(2048).optional(),
  linkedin_url: z.httpUrl().max(2048).optional(),
  sells: text(2000).optional(),
  best_customers: text(2000).optional(),
  source: text(100).optional(),
  consent: consent.optional(),
});

leads.post("/", async (c) => {
  const body = await parseJson(c, CreateBody);
  return c.json({ lead: await createLead(sqlFor(c.env), body, actorOf(c.get("principal"))) }, 201);
});

// Starts a Naive session that searches for leads matching the saved profile, adds them (add_leads) and
// researches them. Async: follow it in GET /api/workflows (purpose find_leads).
// `like_lead_id`: find companies like that lead (the agent reads its why_summary, links and notes).
const FindBody = z
  .object({ count: z.number().int().min(1).max(MAX_FIND_LEADS).default(25), like_lead_id: z.string().trim().min(1).max(64).optional() })
  .strict();

leads.post("/find", async (c) => {
  const body = await parseJson(c, FindBody);
  naiveAgent(c.env); // 503 not_configured before touching the database
  const principal = c.get("principal");
  await requireCredits(c.env, principal); // 402 insufficient_credits when BILLING_ENFORCED and the balance is <= 0
  const result = await startFindLeads(sqlFor(c.env), c.env, body.count, actorOf(principal), undefined, {
    billingOwnerId: billingOwnerOf(principal),
    likeLeadId: body.like_lead_id,
  });
  return c.json(result, 202);
});

// The leads one find run touched, each with find_status created | merged | known (from its add_leads results).
leads.get("/find/:session_id", async (c) => c.json(await getFindRun(sqlFor(c.env), c.env, c.req.param("session_id"))));

const MAX_CSV_BYTES = 5 * 1024 * 1024;
const Mapping = z.partialRecord(z.enum(IMPORT_FIELDS), z.string().min(1).max(200));
const ImportBody = z.object({
  csv: z.string().min(1),
  mapping: Mapping.optional(),
  source: text(100).optional(),
  dry_run: z.boolean().optional(),
});
const ImportQuery = z.object({
  source: text(100).optional(),
  dry_run: z.enum(["true", "false", "1", "0"]).optional(),
  mapping: z.string().max(4000).optional(),
});

function parseMappingParam(raw: string | undefined) {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "invalid_request", 'mapping must be a JSON object, e.g. {"email":"Work Email"}');
  }
  const parsed = Mapping.safeParse(value);
  if (!parsed.success) throw invalidRequest(parsed.error);
  return parsed.data;
}

// JSON {csv, mapping?, source?, dry_run?}, or a raw text/csv body with ?source=&dry_run=&mapping=<json>.
leads.post(
  "/import",
  bodyLimit({ maxSize: MAX_CSV_BYTES, onError: (c) => c.json(errorBody("payload_too_large", "CSV is larger than 5 MB; split it"), 413) }),
  async (c) => {
    const actor = actorOf(c.get("principal"));
    const sql = sqlFor(c.env);
    if ((c.req.header("content-type") ?? "").toLowerCase().startsWith("text/csv")) {
      const q = parseQuery(c, ImportQuery);
      const input = { csv: await c.req.text(), mapping: parseMappingParam(q.mapping), source: q.source, dry_run: q.dry_run === "true" || q.dry_run === "1" };
      return c.json(await importLeads(sql, input, actor));
    }
    return c.json(await importLeads(sql, await parseJson(c, ImportBody), actor));
  },
);

leads.get("/:id", async (c) => c.json(await getLeadFull(sqlFor(c.env), c.req.param("id"))));

const nullableText = (max: number) => z.union([text(max), z.null()]);
const PatchBody = z
  .object({
    stage: z.enum(LEAD_STAGES).optional(),
    consent: z.union([consent, z.null()]).optional(),
    name: nullableText(200).optional(),
    title: nullableText(200).optional(),
    company: nullableText(200).optional(),
    website: nullableText(2048).optional(),
    linkedin_url: nullableText(2048).optional(),
    sells: nullableText(2000).optional(),
    best_customers: nullableText(2000).optional(),
  })
  .strict();

leads.patch("/:id", async (c) => {
  const body = await parseJson(c, PatchBody);
  return c.json({ lead: await patchLead(sqlFor(c.env), c.req.param("id"), body, actorOf(c.get("principal"))) });
});

leads.delete("/:id", async (c) => {
  await deleteLead(sqlFor(c.env), c.req.param("id"), actorOf(c.get("principal")));
  return c.body(null, 204);
});

// An owner-written draft (agents draft through the MCP create_draft tool). Same rules: the lead needs an
// email and consent and must not be suppressed; the new version closes older pending approvals.
const DraftBody = z.object({ subject: text(200), body: text(10_000) });

leads.post("/:id/drafts", async (c) => {
  const body = await parseJson(c, DraftBody);
  const result = await createDraft(
    sqlFor(c.env),
    { lead_id: c.req.param("id"), subject: body.subject, body: body.body },
    { ttlMinutes: sendApprovalTtlMinutes(c.env), via: "api", actor: actorOf(c.get("principal")) },
  );
  return c.json(result, 201);
});

// Follow-ups on a sent email (src/services/followups.ts): each is a new draft version with its own send approval,
// sent at its time unless the lead replies first.
leads.get("/:id/followups", async (c) => c.json({ data: await listFollowUps(sqlFor(c.env), c.req.param("id")) }));

leads.post("/:id/followups", async (c) => {
  const body = await parseJson(c, followupInputSchema);
  const result = await createFollowUp(sqlFor(c.env), c.req.param("id"), body, {
    ttlMinutes: sendApprovalTtlMinutes(c.env),
    actor: actorOf(c.get("principal")),
  });
  return c.json(result, 201);
});
