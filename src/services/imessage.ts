// iMessage approvals through Photon. The bridge (bridge/, a small always-on box) holds the Spectrum connection and
// accepts no inbound traffic: it only calls the Worker, signed with BRIDGE_SECRET. This file is the Worker's half:
//   outbound  every ~5 s the bridge POSTs /webhooks/photon/poll (src/api/webhooks.ts); handleBridgePoll queues a notice
//             for each new approval (and one reminder before it expires) in `imessage_outbox`, leases a few to the
//             bridge with their text, and records the bridge's delivery acks. The bridge only ever texts OWNER_PHONE.
//   inbound   the bridge POSTs the owner's parsed command to /webhooks/photon, deduped by iMessage message id;
//             handlePhotonEvent applies it through the same services as the REST API (every rule re-checked, single
//             use), recording decided_via = 'imessage', and returns the reply text. A 👍 / 👎 tapback on a notice
//             approves / rejects exactly the approval (and draft version) that bubble was sent for; text commands
//             (A/R/E <code>) remain the fallback, since a plain reply cannot be tied to a bubble.
// Multi-tenancy: every decision is resolved from the approval it acts on (by code, or by the bubble's outbox row), so
// once approvals carry a workspace_id the action lands in that approval's workspace. iMessage stays owner-only.
// Off unless IMESSAGE_ENABLED=true and BRIDGE_SECRET is set. All message wording lives here.
import { z } from "zod";
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { toApiError } from "../lib/errors.ts";
import type { FetchFn } from "../providers/http.ts";
import type { QuestionField } from "../providers/naive.ts";
import { sendApprovalTtlMinutes } from "./approval-ttl.ts";
import { answerQuestion, editApproval, getApproval, rejectApproval, resolveTool, type Deps } from "./approvals.ts";
import { approveAndSend } from "./send.ts";
import { setPaused } from "./settings.ts";
import { claimWebhookEvent, releaseWebhookEvent } from "./webhook-events.ts";

export const IMESSAGE_ACTOR = "imessage:owner";
export const PHOTON_WEBHOOK_PATH = "/webhooks/photon";
export const PHOTON_POLL_PATH = "/webhooks/photon/poll";

/** Notices handed to the bridge per poll, delivery attempts per notice, and how long a lease lasts before a retry. */
const MAX_LEASE = 5;
const MAX_NOTIFY_ATTEMPTS = 5;
const LEASE_SECONDS = 120;
/** Poll intervals the Worker asks for: normal, and while iMessage is switched off. */
const POLL_MS = 5_000;
const DISABLED_POLL_MS = 60_000;

// ---------------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------------

export type IMessageConfig = {
  enabled: boolean;
  configured: boolean;
  /** enabled and configured: notices go out and commands are applied. */
  active: boolean;
  missing: string[];
  owner_phone_set: boolean;
};

export function imessageConfig(env: Env): IMessageConfig {
  const enabled = env.IMESSAGE_ENABLED?.trim().toLowerCase() === "true";
  const missing = (env.BRIDGE_SECRET?.length ?? 0) >= 32 ? [] : ["BRIDGE_SECRET"];
  return { enabled, configured: missing.length === 0, active: enabled && missing.length === 0, missing, owner_phone_set: Boolean(env.OWNER_PHONE) };
}

/** E.164 digits with a leading + (formatting stripped), or a lowercased email; undefined otherwise. */
export function normalizeHandle(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim();
  if (v.includes("@")) return v.toLowerCase();
  const digits = v.replace(/^tel:/i, "").replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(digits) ? digits : undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Message wording (pure; tested in test/imessage.test.ts)
// ---------------------------------------------------------------------------------------------------------

/** Untrusted text (agent output, scraped lead fields) on one line: control characters and line breaks removed, capped. */
export function oneLine(text: string | null | undefined, max: number): string {
  const flat = (text ?? "").replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Multi-line text (an email body) with control characters removed, at most `max` characters. */
function block(text: string, max: number): { text: string; cut: boolean } {
  const clean = text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return clean.length > max ? { text: `${clean.slice(0, max - 1).trimEnd()}…`, cut: true } : { text: clean, cut: false };
}

export function timeLeft(expiresAt: Date | string, now: Date = new Date()): string {
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (ms <= 60_000) return "under a minute";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

export type NoticeRow = {
  code: string;
  kind: "send" | "tool" | "question";
  recipient: string | null;
  payload: Record<string, unknown> | null;
  expires_at: Date | string;
  lead_name: string | null;
  lead_company: string | null;
  lead_email: string | null;
  draft_version: number | null;
  draft_subject: string | null;
  draft_body: string | null;
};

/** "Dana Okafor (Fieldnote)", falling back to the email. Lead fields can come from CSVs and scraping: one line, capped. */
function leadLabel(r: Pick<NoticeRow, "lead_name" | "lead_company" | "lead_email" | "recipient">): string {
  const name = oneLine(r.lead_name, 60);
  const company = oneLine(r.lead_company, 60);
  const email = oneLine(r.recipient ?? r.lead_email, 120);
  if (name) return company ? `${name} (${company})` : name;
  return company ? `${email || "a lead"} (${company})` : email || "a lead";
}

function questionOf(r: Pick<NoticeRow, "payload">): { prompt: string; fields: QuestionField[] } {
  const q = (r.payload?.question ?? {}) as { prompt?: unknown; fields?: unknown };
  return { prompt: typeof q.prompt === "string" ? q.prompt : "", fields: Array.isArray(q.fields) ? (q.fields as QuestionField[]) : [] };
}

function optionLabel(o: unknown): string {
  if (typeof o === "string" || typeof o === "number") return String(o);
  if (o && typeof o === "object") {
    const v = (o as { label?: unknown; value?: unknown }).label ?? (o as { value?: unknown }).value;
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  return "";
}

/** How to answer a question by text: "Reply 7KXM <your answer>" or, with several fields, "7KXM role: ...; budget: ...". */
function answerHint(code: string, fields: QuestionField[]): string {
  if (fields.length <= 1) return `Reply ${code} <your answer>`;
  return `Reply ${code} ${fields.map((f) => `${oneLine(f.key, 30)}: …`).join("; ")}`;
}

/** The text sent when an approval opens. Agent-written parts are labeled as the agent's and flattened. */
export function formatApprovalNotice(r: NoticeRow, now: Date = new Date()): string {
  const expires = `Expires in ${timeLeft(r.expires_at, now)}.`;
  if (r.kind === "send") {
    const to = leadLabel(r);
    const email = oneLine(r.recipient, 120);
    const header = `Draft to ${to}${email && !to.includes(email) ? ` <${email}>` : ""}${r.draft_version && r.draft_version > 1 ? `, v${r.draft_version}` : ""}:`;
    const body = block(r.draft_body ?? "", 700);
    return [
      header,
      `"${oneLine(r.draft_subject, 150)}"`,
      "",
      body.text + (body.cut ? "\n(cut short; the full draft is in the app)" : ""),
      "",
      `Tap 👍 on this message to send it, 👎 to reject. Or reply A ${r.code}, R ${r.code}, or E ${r.code} <new text>. ${expires}`,
    ].join("\n");
  }
  const lead = r.lead_name || r.lead_company || r.lead_email ? ` (lead: ${leadLabel(r)})` : "";
  if (r.kind === "tool") {
    const name = oneLine(typeof r.payload?.name === "string" ? r.payload.name : "a tool", 80);
    const args = r.payload?.args === undefined ? "" : oneLine(JSON.stringify(r.payload.args), 300);
    return [
      `Agent wants to run ${name}${lead}.`,
      ...(args && args !== "{}" ? [`Args: ${args}`] : []),
      `Tap 👍 to allow, 👎 to deny (or reply A ${r.code} / R ${r.code}). ${expires}`,
    ].join("\n");
  }
  const { prompt, fields } = questionOf(r);
  const lines = [`Agent asks${lead}: "${oneLine(prompt, 500)}"`];
  if (fields.length > 1) lines.push(`Fields: ${fields.map((f) => oneLine(f.label ? `${f.key} (${f.label})` : f.key, 60)).join(", ")}`);
  const options = fields.length === 1 ? (fields[0]!.options ?? []).map(optionLabel).filter(Boolean) : [];
  if (options.length) lines.push(`Options: ${oneLine(options.join(", "), 200)}`);
  lines.push(`${answerHint(r.code, fields)}. ${expires}`);
  return lines.join("\n");
}

/** The one reminder before an approval expires. */
export function formatExpiryWarning(r: NoticeRow, now: Date = new Date()): string {
  const left = timeLeft(r.expires_at, now);
  if (r.kind === "send") {
    return `Reminder: ${r.code} expires in ${left} (draft to ${leadLabel(r)}: "${oneLine(r.draft_subject, 80)}"). Tap 👍 here to send it, 👎 to reject (or A ${r.code} / R ${r.code}).`;
  }
  if (r.kind === "tool") {
    const name = oneLine(typeof r.payload?.name === "string" ? r.payload.name : "a tool", 80);
    return `Reminder: ${r.code} expires in ${left} (agent wants to run ${name}); it is denied after that. Tap 👍 to allow, 👎 to deny (or A ${r.code} / R ${r.code}).`;
  }
  return `Reminder: ${r.code} expires in ${left} (agent question). ${answerHint(r.code, questionOf(r).fields)}.`;
}

// ---------------------------------------------------------------------------------------------------------
// Outbound: the bridge polls for notices
// ---------------------------------------------------------------------------------------------------------

export const BridgePollSchema = z.object({
  // What the bridge reports about itself (shown in /api/status). No secrets, no phone numbers.
  bridge: z
    .object({
      version: z.string().max(40).optional(),
      mode: z.enum(["live", "mock"]).optional(),
      state: z.string().max(40),
      connected: z.boolean(),
      last_heartbeat_at: z.string().max(40).nullable().optional(),
      reconnects: z.number().int().min(0).max(1_000_000).optional(),
    })
    .strict(),
  // Results for notices from earlier polls.
  // `message_id`: the delivered bubble's iMessage id, which later tapbacks point at.
  acks: z
    .array(z.object({ id: z.string().min(1).max(100), ok: z.boolean(), error: z.string().max(300).optional(), message_id: z.string().min(1).max(200).optional() }))
    .max(50)
    .default([]),
  // How many notices the bridge can deliver now: 0 while its iMessage connection is down.
  max: z.number().int().min(0).max(10).default(MAX_LEASE),
});
export type BridgePoll = z.infer<typeof BridgePollSchema>;

export type BridgeNotice = { id: string; type: "approval" | "expiry_warning"; text: string };
export type PollResponse = { ok: true; enabled: boolean; notices: BridgeNotice[]; poll_after_ms: number };

const noticeRows = async (sql: Sql, codes: string[]): Promise<NoticeRow[]> =>
  (await sql`
    select a.code, a.kind, a.recipient, a.payload, a.expires_at,
           l.name as lead_name, l.company as lead_company, l.email as lead_email,
           d.version as draft_version, d.subject as draft_subject, d.body as draft_body
    from approvals a
    left join leads l on l.id = a.lead_id
    left join drafts d on d.id = a.draft_id
    where a.code = any(${codes}::text[])`) as NoticeRow[];

/**
 * One bridge poll, in one database round trip plus one read:
 *   1. record acks (delivered, or failed: released for the next poll) and the bridge's status (written at most every
 *      30 s, or when its state changes);
 *   2. queue a notice for every approval opened in the last 24 hours (once per approval, keyed by `approval:<code>`)
 *      and one reminder (`warn:<code>`) for approvals in the last quarter of their life (at most the last 12 hours),
 *      at least 10 minutes after the owner was told about them;
 *   3. lease up to `max` undelivered notices whose approval is still open (skip locked, so overlapping polls never
 *      get the same notice; a lease the bridge never acks expires after 2 minutes; 5 attempts at most).
 * The notice text is rendered now, so "expires in" is current. Answers without touching the database while off.
 */
export async function handleBridgePoll(getSql: () => Sql, env: Env, poll: BridgePoll): Promise<PollResponse> {
  if (!imessageConfig(env).active) return { ok: true, enabled: false, notices: [], poll_after_ms: DISABLED_POLL_MS };
  const sql = getSql();
  const delivered = poll.acks.filter((a) => a.ok);
  const failed = poll.acks.filter((a) => !a.ok);
  const status = JSON.stringify({ ...poll.bridge, seen_at: new Date().toISOString() });
  const results = await sql.transaction([
    // Delivered either way; the bubble id is recorded once and never reassigned to another notice.
    sql`update imessage_outbox o set delivered_at = coalesce(o.delivered_at, now()), last_error = null,
          message_id = coalesce(o.message_id, case
            when exists (select 1 from imessage_outbox x where x.message_id = nullif(f.message_id, '') and x.id <> o.id) then null
            else nullif(f.message_id, '') end)
        from unnest(${delivered.map((a) => a.id)}::text[], ${delivered.map((a) => a.message_id ?? "")}::text[]) as f(id, message_id)
        where o.id = f.id`,
    sql`update imessage_outbox o set leased_at = null, last_error = f.err
        from unnest(${failed.map((f) => f.id)}::text[], ${failed.map((f) => f.error ?? "send failed")}::text[]) as f(id, err)
        where o.id = f.id and o.delivered_at is null`,
    sql`insert into settings (key, value) values ('imessage_bridge', ${status}::jsonb)
        on conflict (key) do update set value = excluded.value
        where settings.value->>'state' is distinct from excluded.value->>'state'
           or settings.value->>'connected' is distinct from excluded.value->>'connected'
           or coalesce((settings.value->>'seen_at')::timestamptz, 'epoch') < now() - interval '30 seconds'`,
    sql`insert into imessage_outbox (id, approval_code, kind, draft_id)
        select 'approval:' || code, code, 'approval', draft_id from approvals
        where status = 'pending' and expires_at > now() and created_at > now() - interval '24 hours'
        on conflict (id) do nothing`,
    sql`insert into imessage_outbox (id, approval_code, kind, draft_id)
        select 'warn:' || a.code, a.code, 'expiry_warning', a.draft_id
        from approvals a join imessage_outbox o on o.id = 'approval:' || a.code
        where a.status = 'pending' and a.expires_at > now()
          and o.delivered_at <= now() - interval '10 minutes'
          and a.expires_at - now() <= least((a.expires_at - a.created_at) / 4, interval '12 hours')
        on conflict (id) do nothing`,
    sql`with picked as (
          select o.id from imessage_outbox o join approvals a on a.code = o.approval_code
          where o.delivered_at is null and o.attempts < ${MAX_NOTIFY_ATTEMPTS}
            and (o.leased_at is null or o.leased_at < now() - make_interval(secs => ${LEASE_SECONDS}))
            and a.status = 'pending' and a.expires_at > now()
          order by o.created_at
          limit ${poll.max}
          for update of o skip locked
        )
        update imessage_outbox o set leased_at = now(), attempts = o.attempts + 1
        from picked where o.id = picked.id
        returning o.id, o.approval_code, o.kind`,
  ]);
  const leased = (results.at(-1) ?? []) as { id: string; approval_code: string; kind: "approval" | "expiry_warning" }[];
  if (!leased.length) return { ok: true, enabled: true, notices: [], poll_after_ms: POLL_MS };
  const rows = new Map((await noticeRows(sql, leased.map((l) => l.approval_code))).map((r) => [r.code, r]));
  const notices: BridgeNotice[] = [];
  for (const l of leased) {
    const row = rows.get(l.approval_code);
    if (!row) continue;
    notices.push({ id: l.id, type: l.kind, text: l.kind === "approval" ? formatApprovalNotice(row) : formatExpiryWarning(row) });
  }
  return { ok: true, enabled: true, notices, poll_after_ms: POLL_MS };
}

/** For /api/status: switches, what the bridge last reported, and notices that could not be delivered. Never throws. */
export async function imessageStatus(sql: Sql | null, env: Env) {
  const cfg = imessageConfig(env);
  const base = { enabled: cfg.enabled, configured: cfg.configured, active: cfg.active, missing: cfg.missing, owner_phone_set: cfg.owner_phone_set };
  if (!sql) return { ...base, bridge: null };
  try {
    const [row] = await sql`
      select (select value from settings where key = 'imessage_bridge') as bridge,
             (select count(*)::int from imessage_outbox where delivered_at is null and attempts >= ${MAX_NOTIFY_ATTEMPTS}) as undeliverable,
             (select max(delivered_at) from imessage_outbox) as last_delivered_at`;
    const bridge = (row?.bridge ?? null) as (Record<string, unknown> & { seen_at?: string }) | null;
    const seen = bridge?.seen_at ? Date.parse(bridge.seen_at) : NaN;
    return {
      ...base,
      // The bridge polls every ~5 s and writes its status at least every 30 s: older than 90 s means it is down.
      bridge: bridge ? { ...bridge, online: Number.isFinite(seen) && Date.now() - seen < 90_000 } : null,
      undeliverable_notices: row?.undeliverable ?? 0,
      last_delivered_at: row?.last_delivered_at ?? null,
    };
  } catch {
    // Table missing until `bun run migrate`; the rest of /api/status still answers.
    return { ...base, bridge: null, error: "schema_out_of_date" };
  }
}

/** Cron: drop notices older than 30 days (they only matter while their approval is open). */
export async function pruneOutbox(sql: Sql, env: Env): Promise<number> {
  if (!imessageConfig(env).active) return 0;
  const rows = await sql`delete from imessage_outbox where created_at < now() - interval '30 days' returning id`;
  return rows.length;
}

// ---------------------------------------------------------------------------------------------------------
// Inbound: owner commands from the bridge
// ---------------------------------------------------------------------------------------------------------

const Code = z
  .string()
  .regex(/^[A-Za-z0-9]{4}$/, "code must be 4 letters or digits")
  .transform((s) => s.toUpperCase());

export const OwnerCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), code: Code }),
  z.object({ action: z.literal("reject"), code: Code, reason: z.string().trim().min(1).max(1000).optional() }),
  z.object({ action: z.literal("edit"), code: Code, text: z.string().trim().min(1).max(10_000) }),
  z.object({ action: z.literal("answer"), code: Code, text: z.string().trim().min(1).max(4_000) }),
  // A 👍 (like) or 👎 (dislike) tapback on the bubble with this iMessage id.
  z.object({ action: z.literal("react"), reaction: z.enum(["like", "dislike"]), message_id: z.string().min(1).max(200) }),
  z.object({ action: z.literal("status") }),
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
]);
export type OwnerCommand = z.infer<typeof OwnerCommandSchema>;

/** What the bridge POSTs to /webhooks/photon (signed). `id` is the iMessage message id: the dedupe key. */
export const PhotonEventSchema = z.object({
  id: z.string().min(1).max(200),
  from: z.string().min(3).max(320),
  received_at: z.string().max(64).optional(),
  command: OwnerCommandSchema,
});
export type PhotonEvent = z.infer<typeof PhotonEventSchema>;

export type CommandResult = { ok: boolean; reply: string; error?: string };

/**
 * Free text -> the `answers` object a Naive question needs (exactly one entry per field). One field takes the whole
 * text (split on commas/new lines when it allows several values); several fields need "key: value" parts separated
 * by new lines or semicolons, keys matched case-insensitively against each field's key or label.
 */
export function parseAnswers(code: string, text: string, fields: QuestionField[]): { ok: true; answers: Record<string, string | string[]> } | { ok: false; reply: string } {
  const value = (f: QuestionField, raw: string): string | string[] =>
    f.multiple ? raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) : raw.trim();
  if (fields.length === 0) return { ok: true, answers: {} };
  if (fields.length === 1) return { ok: true, answers: { [fields[0]!.key]: value(fields[0]!, text) } };
  const byName = new Map<string, QuestionField>();
  for (const f of fields) {
    byName.set(f.key.toLowerCase(), f);
    if (f.label) byName.set(f.label.toLowerCase(), f);
  }
  const answers: Record<string, string | string[]> = {};
  for (const part of text.split(/[;\n]/)) {
    const m = /^\s*([^:=]+?)\s*[:=]\s*([\s\S]+?)\s*$/.exec(part);
    const field = m ? byName.get(m[1]!.toLowerCase()) : undefined;
    if (field && m) answers[field.key] = value(field, m[2]!);
  }
  const missing = fields.filter((f) => answers[f.key] === undefined || answers[f.key] === "");
  if (missing.length) {
    return { ok: false, reply: `That question has ${fields.length} parts. ${answerHint(code, fields)} (missing: ${missing.map((f) => f.key).join(", ")}).` };
  }
  return { ok: true, answers };
}

/** An expected failure as a short text; undefined for unexpected errors (the route answers 5xx so the bridge retries). */
function friendlyError(err: unknown, code: string | undefined): CommandResult | undefined {
  const e = toApiError(err);
  if (!e) return undefined;
  const c = code ?? "";
  const text: Record<string, string> = {
    not_found: `No approval ${c}. Text status to see what's open.`,
    approval_expired: `Code ${c} expired.`,
    approval_not_pending: `${c} is already closed: ${e.message.replace(/^Approval is /, "")}.`,
    paused: `Sending is paused. Text resume first, then A ${c}.`,
    suppressed: `${c} can't be sent: the recipient is on the do-not-contact list.`,
    no_consent: `${c} can't be sent: the lead has not opted in to email.`,
    recipient_mismatch: `${c} can't be sent: the lead's email changed after the draft was written.`,
    draft_superseded: `${c} is an old version: ${e.message}. Text status for the newest code.`,
    not_editable: `${c} can't be edited: ${e.message}.`,
    send_failed: `AgentMail refused the email for ${c}: ${e.message}. Text E ${c} <text> to retry with a new version.`,
    not_configured: `Crusonia isn't set up for that yet: ${e.message}.`,
    invalid_answers: `Those answers don't fit the question: ${e.message}.`,
  };
  return { ok: false, error: e.code, reply: oneLine(text[e.code] ?? `Couldn't do that for ${c || "you"}: ${e.message}.`, 600) };
}

type ApprovalContext = { lead_name: string | null; lead_company: string | null; lead_email: string | null; recipient: string | null; draft_subject: string | null };

async function contextOf(sql: Sql, code: string): Promise<ApprovalContext> {
  const rows = await sql`
    select a.recipient, l.name as lead_name, l.company as lead_company, l.email as lead_email, d.subject as draft_subject
    from approvals a left join leads l on l.id = a.lead_id left join drafts d on d.id = a.draft_id
    where a.code = ${code}`;
  return (rows[0] ?? { lead_name: null, lead_company: null, lead_email: null, recipient: null, draft_subject: null }) as ApprovalContext;
}

async function statusReply(sql: Sql, now: Date = new Date()): Promise<string> {
  const [state] = await sql`
    select coalesce((select value = 'true'::jsonb from settings where key = 'paused'), false) as paused,
           (select count(*)::int from approvals where status = 'pending' and expires_at > now()) as pending`;
  const rows = (await sql`
    select a.code, a.kind, a.recipient, a.payload, a.expires_at,
           l.name as lead_name, l.company as lead_company, l.email as lead_email,
           d.version as draft_version, d.subject as draft_subject, null::text as draft_body
    from approvals a left join leads l on l.id = a.lead_id left join drafts d on d.id = a.draft_id
    where a.status = 'pending' and a.expires_at > now()
    order by a.expires_at
    limit 5`) as NoticeRow[];
  const head = state?.paused ? "Crusonia is PAUSED (text resume to restart)." : "Crusonia is running.";
  const pending = Number(state?.pending ?? 0);
  if (!pending) return `${head} Nothing is waiting for you.`;
  const lines = rows.map((r) => {
    const left = timeLeft(r.expires_at, now);
    if (r.kind === "send") return `${r.code} draft to ${leadLabel(r)}: "${oneLine(r.draft_subject, 60)}" (${left} left)`;
    if (r.kind === "tool") return `${r.code} agent tool ${oneLine(String(r.payload?.name ?? ""), 60)} (${left} left)`;
    return `${r.code} agent question: "${oneLine(questionOf(r).prompt, 60)}" (${left} left)`;
  });
  if (pending > rows.length) lines.push(`…and ${pending - rows.length} more in the app.`);
  return [`${head} ${pending} waiting for you, soonest to expire first:`, ...lines, "Reply A <code>, R <code>, or help."].join("\n");
}

export async function handleOwnerCommand(ctx: { sql: Sql; env: Env; fetch?: FetchFn }, cmd: OwnerCommand): Promise<CommandResult> {
  const { sql, env } = ctx;
  const deps: Deps = { sql, env, fetch: ctx.fetch, actor: IMESSAGE_ACTOR, sendTtlMinutes: sendApprovalTtlMinutes(env), via: "imessage" };
  let code = "code" in cmd ? cmd.code : undefined;

  const approve = async (approvalCode: string): Promise<CommandResult> => {
    const approval = await getApproval(sql, approvalCode);
    if (approval.kind === "send") {
      const c = await contextOf(sql, approval.code);
      const result = await approveAndSend({ sql, env, fetch: ctx.fetch, actor: IMESSAGE_ACTOR, via: "imessage" }, approval.code);
      const to = leadLabel(c);
      return result.status === "sent"
        ? { ok: true, reply: `Approved. Sent "${oneLine(c.draft_subject, 80)}" to ${to}.` }
        : { ok: true, reply: `Approved. Sending to ${to}; AgentMail hasn't confirmed yet, Crusonia checks again within minutes.` };
    }
    if (approval.kind === "tool") {
      await resolveTool(deps, approval, { decision: "allow" });
      return { ok: true, reply: `Allowed. The agent can run ${oneLine(String(approval.payload?.name ?? "the tool"), 80)} and continues.` };
    }
    return { ok: false, error: "wrong_kind", reply: `${approval.code} is a question, not an approval. Reply ${approval.code} <your answer>.` };
  };

  const reject = async (approvalCode: string, reason?: string): Promise<CommandResult> => {
    const approval = await getApproval(sql, approvalCode);
    if (approval.kind === "question") {
      return { ok: false, error: "wrong_kind", reply: `Questions can't be rejected. Reply ${approval.code} <your answer> (e.g. ${approval.code} skip this lead).` };
    }
    if (approval.kind === "tool") {
      await resolveTool(deps, approval, { decision: "deny", ...(reason ? { reason } : {}) });
      return { ok: true, reply: `Denied. The agent won't run ${oneLine(String(approval.payload?.name ?? "the tool"), 80)}.` };
    }
    const c = await contextOf(sql, approval.code);
    await rejectApproval(deps, approval.code, reason);
    return { ok: true, reply: `Rejected. The draft to ${leadLabel(c)} won't be sent.` };
  };

  try {
    switch (cmd.action) {
      case "status":
        return { ok: true, reply: await statusReply(sql) };
      case "pause":
        await setPaused(sql, true, IMESSAGE_ACTOR);
        return { ok: true, reply: "Paused. No emails go out and no new agent work starts. Text resume to restart." };
      case "resume":
        await setPaused(sql, false, IMESSAGE_ACTOR);
        return { ok: true, reply: "Resumed. Approved emails send again and agents can start new work." };
      case "approve":
        return await approve(cmd.code);
      case "reject":
        return await reject(cmd.code, cmd.reason);
      case "react": {
        // The bubble decides: only a notice we delivered (with its recorded iMessage id) binds to an approval, and only
        // to the draft version it showed. Tapbacks on anything else are ignored without a reply.
        const [bubble] = await sql`
          select o.approval_code, o.draft_id, a.draft_id as approval_draft_id
          from imessage_outbox o join approvals a on a.code = o.approval_code
          where o.message_id = ${cmd.message_id}`;
        if (!bubble) return { ok: false, error: "unknown_message", reply: "" };
        code = bubble.approval_code as string;
        if ((bubble.draft_id ?? null) !== (bubble.approval_draft_id ?? null)) {
          return { ok: false, error: "draft_mismatch", reply: `That message showed a different version than ${code} now holds. Text status for the current code.` };
        }
        return await (cmd.reaction === "like" ? approve(code) : reject(code, "Rejected with a 👎 tapback"));
      }
      case "edit": {
        const approval = await getApproval(sql, cmd.code);
        if (approval.kind !== "send") {
          return { ok: false, error: "wrong_kind", reply: `Only email drafts can be edited; ${approval.code} is an agent ${approval.kind}.` };
        }
        const created = await editApproval(deps, approval.code, { body: cmd.text });
        // The new version gets its own notice on the next poll (seconds), so it can be tapped like any other draft.
        const c = await contextOf(sql, created.approval.code);
        return {
          ok: true,
          reply: `Saved as v${created.draft.version} for ${leadLabel(c)} (${approval.code} is closed). The new draft follows: tap 👍 on it to send, or reply A ${created.approval.code}.`,
        };
      }
      case "answer": {
        const approval = await getApproval(sql, cmd.code);
        if (approval.kind === "tool") return { ok: false, error: "wrong_kind", reply: `${approval.code} is a tool request: A ${approval.code} to allow, R ${approval.code} to deny.` };
        if (approval.kind === "send") {
          return { ok: false, error: "wrong_kind", reply: `${approval.code} is an email draft: A ${approval.code} to send, R ${approval.code} to reject, E ${approval.code} <new text> to rewrite.` };
        }
        const parsed = parseAnswers(approval.code, cmd.text, questionOf(approval).fields);
        if (!parsed.ok) return { ok: false, error: "invalid_answers", reply: parsed.reply };
        await answerQuestion(deps, approval, parsed.answers);
        return { ok: true, reply: "Answered. The agent continues." };
      }
    }
  } catch (err) {
    const friendly = friendlyError(err, code);
    if (friendly) return friendly;
    throw err;
  }
}

/**
 * /webhooks/photon after the signature check: dedupe by iMessage message id (a retried delivery gets the first
 * reply back without acting again), apply the command, audit it. Unexpected errors release the claim and throw.
 */
export async function handlePhotonEvent(sql: Sql, env: Env, event: PhotonEvent, fetchFn?: FetchFn): Promise<CommandResult & { duplicate?: boolean }> {
  const eventId = `photon:${event.id}`;
  if (!(await claimWebhookEvent(sql, "photon", eventId))) {
    const prior = await sql`
      select data->>'reply' as reply from events
      where kind = 'imessage_command' and data->>'message_id' = ${event.id}
      order by id desc limit 1`;
    return { ok: true, duplicate: true, reply: (prior[0]?.reply as string | undefined) ?? "Already handled that message." };
  }
  let result: CommandResult;
  try {
    result = await handleOwnerCommand({ sql, env, fetch: fetchFn }, event.command);
  } catch (err) {
    await releaseWebhookEvent(sql, eventId).catch(() => {});
    throw err;
  }
  const code = "code" in event.command ? event.command.code : null;
  await sql`insert into events (lead_id, kind, data) values (null, 'imessage_command', ${JSON.stringify({
    message_id: event.id,
    action: event.command.action,
    ...(event.command.action === "react" ? { reaction: event.command.reaction, target_message_id: event.command.message_id } : {}),
    code,
    ok: result.ok,
    error: result.error ?? null,
    reply: result.reply.slice(0, 1000),
  })}::jsonb)`;
  return result;
}
