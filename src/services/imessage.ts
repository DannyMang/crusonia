// iMessage approvals through Photon. The bridge (bridge/, a small always-on box) holds the Spectrum connection and
// accepts no inbound traffic: it only calls the Worker, signed with BRIDGE_SECRET. This file is the Worker's half:
//   outbound  every ~5 s the bridge POSTs /webhooks/photon/poll (src/api/webhooks.ts); handleBridgePoll queues a notice
//             for each new approval (and one reminder before it expires) in `imessage_outbox`, leases a few to the
//             bridge with their text, and records the bridge's delivery acks. The bridge only ever texts OWNER_PHONE.
//   inbound   thumbs only: the bridge POSTs the owner's 👍 / 👎 tapback on a notice to /webhooks/photon, deduped by
//             iMessage event id. handlePhotonEvent approves / rejects exactly the approval (and draft version) that
//             bubble was sent for, through the same services as the REST API (every rule re-checked, single use),
//             recording decided_via = 'imessage', and returns a confirmation. There are no text commands.
// Workspaces: the bridge texts the instance owner's phone (OWNER_PHONE), so iMessage covers the owner workspace only:
// only its approvals are announced, and every tapback is looked up through the bubble's outbox row in the owner
// workspace.
// IMESSAGE_ENABLED=true (with BRIDGE_SECRET set) turns new notices on. Off does not cancel what is already on the owner's
// phone: a tapback on a delivered notice is still applied. All message wording lives here.
import { z } from "zod";
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { toApiError } from "../lib/errors.ts";
import type { FetchFn } from "../providers/http.ts";
import { sendApprovalTtlMinutes } from "./approval-ttl.ts";
import { getApproval, rejectApproval, resolveTool, type Deps } from "./approvals.ts";
import { approveAndSend } from "./send.ts";
import { claimWebhookEvent, releaseWebhookEvent } from "./webhook-events.ts";
import { OWNER_WORKSPACE_ID } from "./workspaces.ts";

/** The workspace iMessage serves (the owner's phone, the owner's approvals). */
const WS = OWNER_WORKSPACE_ID;

export const IMESSAGE_ACTOR = "imessage:owner";
export const PHOTON_WEBHOOK_PATH = "/webhooks/photon";
export const PHOTON_POLL_PATH = "/webhooks/photon/poll";

/** Notices handed to the bridge per poll, delivery attempts per notice, and how long a lease lasts before a retry. */
const MAX_LEASE = 5;
const MAX_NOTIFY_ATTEMPTS = 5;
const LEASE_SECONDS = 120;
/**
 * Send cap: at most NOTICE_CAP notices (new approvals and reminders) per NOTICE_WINDOW_MINUTES. Due notices beyond it
 * are skipped and summed up in one "+N more approvals waiting" text, sent at most once per window.
 */
export const NOTICE_CAP = 6;
export const NOTICE_WINDOW_MINUTES = 10;
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
  /** "···0142": the last 4 digits of OWNER_PHONE for the UI, never the full number. Null when unset. */
  owner_phone_hint: string | null;
};

/** The last 4 digits of a phone number behind middle dots ("···0142"); null without at least 4 digits. */
export function phoneHint(phone: string | undefined | null): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? `\u00B7\u00B7\u00B7${digits.slice(-4)}` : null;
}

export function imessageConfig(env: Env): IMessageConfig {
  const enabled = env.IMESSAGE_ENABLED?.trim().toLowerCase() === "true";
  const missing = (env.BRIDGE_SECRET?.length ?? 0) >= 32 ? [] : ["BRIDGE_SECRET"];
  return {
    enabled,
    configured: missing.length === 0,
    active: enabled && missing.length === 0,
    missing,
    owner_phone_set: Boolean(env.OWNER_PHONE),
    owner_phone_hint: phoneHint(env.OWNER_PHONE),
  };
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
  /** The newest older version of this lead's draft that the owner was texted about, if any (it is now closed). */
  replaces_version?: number | null;
};

/** "Dana Okafor (Fieldnote)", falling back to the email. Lead fields can come from CSVs and scraping: one line, capped. */
function leadLabel(r: Pick<NoticeRow, "lead_name" | "lead_company" | "lead_email" | "recipient">): string {
  const name = oneLine(r.lead_name, 60);
  const company = oneLine(r.lead_company, 60);
  const email = oneLine(r.recipient ?? r.lead_email, 120);
  if (name) return company ? `${name} (${company})` : name;
  return company ? `${email || "a lead"} (${company})` : email || "a lead";
}

function questionPrompt(r: Pick<NoticeRow, "payload">): string {
  const prompt = (r.payload?.question as { prompt?: unknown } | undefined)?.prompt;
  return typeof prompt === "string" ? prompt : "";
}

/**
 * The text sent when an approval opens. The first line always names the request (the approval code) and, for drafts, the
 * exact version: a 👍 on this bubble approves that version only. A new version of a draft the owner was already texted
 * about says so first. Questions can't be answered with a thumb, so they point to the app. Agent-written parts are
 * labeled as the agent's and flattened.
 */
export function formatApprovalNotice(r: NoticeRow): string {
  if (r.kind === "send") {
    const to = leadLabel(r);
    const email = oneLine(r.recipient, 120);
    const body = block(r.draft_body ?? "", 700);
    return [
      ...(r.replaces_version ? [`That draft changed; here's the new one (v${r.replaces_version} is closed).`] : []),
      `Request ${r.code} · draft v${r.draft_version ?? 1} to ${to}${email && !to.includes(email) ? ` <${email}>` : ""}:`,
      `"${oneLine(r.draft_subject, 150)}"`,
      "",
      body.text + (body.cut ? "\n(cut short; the full draft is in the app)" : ""),
      "",
      "Tap 👍 to send, 👎 to reject.",
    ].join("\n");
  }
  const lead = r.lead_name || r.lead_company || r.lead_email ? ` (lead: ${leadLabel(r)})` : "";
  if (r.kind === "tool") {
    const name = oneLine(typeof r.payload?.name === "string" ? r.payload.name : "a tool", 80);
    const args = r.payload?.args === undefined ? "" : oneLine(JSON.stringify(r.payload.args), 300);
    return [
      `Request ${r.code} · agent wants to run ${name}${lead}.`,
      ...(args && args !== "{}" ? [`Args: ${args}`] : []),
      "Tap 👍 to allow, 👎 to deny.",
    ].join("\n");
  }
  return [`Request ${r.code} · agent asks${lead}: "${oneLine(questionPrompt(r), 500)}"`, "Answer it in the app."].join("\n");
}

/** The one reminder before an approval expires. */
export function formatExpiryWarning(r: NoticeRow, now: Date = new Date()): string {
  const left = timeLeft(r.expires_at, now);
  if (r.kind === "send") {
    return `Reminder: request ${r.code} expires in ${left} (draft to ${leadLabel(r)}: "${oneLine(r.draft_subject, 80)}"). Tap 👍 to send, 👎 to reject.`;
  }
  if (r.kind === "tool") {
    const name = oneLine(typeof r.payload?.name === "string" ? r.payload.name : "a tool", 80);
    return `Reminder: request ${r.code} expires in ${left} (agent wants to run ${name}); it is denied after that. Tap 👍 to allow, 👎 to deny.`;
  }
  return `Reminder: request ${r.code} expires in ${left} (agent question). Answer it in the app.`;
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

export type BridgeNotice = { id: string; type: "approval" | "expiry_warning" | "summary"; text: string };

/** The text that stands in for notices beyond the send cap. */
export function formatSummary(count: number, publicUrl: string): string {
  const url = `${publicUrl.replace(/\/+$/, "")}/app/approvals`;
  return `+${count} more approval${count === 1 ? "" : "s"} waiting: open Crusonia (${url}).`;
}
export type PollResponse = { ok: true; enabled: boolean; notices: BridgeNotice[]; poll_after_ms: number };

const noticeRows = async (sql: Sql, codes: string[]): Promise<NoticeRow[]> =>
  (await sql`
    select a.code, a.kind, a.recipient, a.payload, a.expires_at,
           l.name as lead_name, l.company as lead_company, l.email as lead_email,
           d.version as draft_version, d.subject as draft_subject, d.body as draft_body,
           (select max(d2.version) from drafts d2
              join approvals a2 on a2.draft_id = d2.id
              join imessage_outbox o2 on o2.id = 'approval:' || a2.code and o2.delivered_at is not null
            where d2.lead_id = a.lead_id and d2.version < d.version) as replaces_version
    from approvals a
    left join leads l on l.id = a.lead_id
    left join drafts d on d.id = a.draft_id
    where a.workspace_id = ${WS} and a.code = any(${codes}::text[])`) as NoticeRow[];

/** Records the bridge's delivery results. */
function ackQueries(sql: Sql, acks: BridgePoll["acks"]) {
  const delivered = acks.filter((a) => a.ok);
  const failed = acks.filter((a) => !a.ok);
  return [
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
  ];
}

/**
 * One bridge poll, in one database round trip plus one read:
 *   1. record acks (delivered, or failed: released for the next poll) and the bridge's status (written at most every
 *      30 s, or when its state changes);
 *   2. queue a notice for every approval opened in the last 24 hours (once per approval, keyed by `approval:<code>`)
 *      and one reminder (`warn:<code>`) for approvals in the last quarter of their life (at most the last 12 hours),
 *      at least 10 minutes after the owner was told about them;
 *   3. lease up to `max` undelivered notices whose approval is still open (skip locked, so overlapping polls never
 *      get the same notice; a lease the bridge never acks expires after 2 minutes; 5 attempts at most).
 * The notice text is rendered now, so "expires in" is current. While off, it only records acks: no new notices.
 */
export async function handleBridgePoll(getSql: () => Sql, env: Env, poll: BridgePoll): Promise<PollResponse> {
  if (!imessageConfig(env).active) {
    // Off stops new notices, but a text that already went out must keep its bubble id, or a later tapback can't find it.
    if (poll.acks.length) {
      const sql = getSql();
      await sql.transaction(ackQueries(sql, poll.acks));
    }
    return { ok: true, enabled: false, notices: [], poll_after_ms: DISABLED_POLL_MS };
  }
  const sql = getSql();
  const status = JSON.stringify({ ...poll.bridge, seen_at: new Date().toISOString() });
  // Integration-test fixtures on a shared database are never texted (unless IMESSAGE_INCLUDE_TEST_DATA=true): leads
  // with an it_* source, recipients on reserved example domains (RFC 2606/6761), and ses_it_* agent sessions.
  const includeTest = env.IMESSAGE_INCLUDE_TEST_DATA?.trim().toLowerCase() === "true";
  const testDomain = "@([a-z0-9-]+\\.)*(example\\.(com|org|net)|[a-z0-9-]+\\.(test|example|invalid|localhost))$";
  // Notices counted against the cap: delivered in the window, plus leases still outstanding.
  const window = `${NOTICE_WINDOW_MINUTES} minutes`;
  const capSetting = Number(env.IMESSAGE_NOTICE_CAP);
  const cap = Number.isInteger(capSetting) && capSetting > 0 ? capSetting : NOTICE_CAP;
  const results = await sql.transaction([
    ...ackQueries(sql, poll.acks),
    sql`insert into settings (key, value) values ('imessage_bridge', ${status}::jsonb)
        on conflict (key) do update set value = excluded.value
        where settings.value->>'state' is distinct from excluded.value->>'state'
           or settings.value->>'connected' is distinct from excluded.value->>'connected'
           or coalesce((settings.value->>'seen_at')::timestamptz, 'epoch') < now() - interval '30 seconds'`,
    sql`insert into imessage_outbox (id, workspace_id, approval_code, kind, draft_id)
        select 'approval:' || a.code, a.workspace_id, a.code, 'approval', a.draft_id
        from approvals a left join leads l on l.id = a.lead_id
        where a.workspace_id = ${WS} and a.status = 'pending' and a.expires_at > now() and a.created_at > now() - interval '24 hours'
          and (${includeTest}::boolean or not (
                left(coalesce(l.source, ''), 3) = 'it_'
             or left(coalesce(a.naive_session_id, ''), 7) = 'ses_it_'
             or lower(coalesce(a.recipient, l.email, '')) ~ ${testDomain}))
        on conflict (id) do nothing`,
    sql`insert into imessage_outbox (id, workspace_id, approval_code, kind, draft_id)
        select 'warn:' || a.code, a.workspace_id, a.code, 'expiry_warning', a.draft_id
        from approvals a join imessage_outbox o on o.id = 'approval:' || a.code
        where a.workspace_id = ${WS} and a.status = 'pending' and a.expires_at > now()
          and o.delivered_at <= now() - interval '10 minutes'
          and a.expires_at - now() <= least((a.expires_at - a.created_at) / 4, interval '12 hours')
        on conflict (id) do nothing`,
    // Lease within what is left of the cap.
    sql`with used as (
          select count(*) as n from imessage_outbox
          where workspace_id = ${WS} and (delivered_at > now() - ${window}::interval
             or (delivered_at is null and skipped_at is null and leased_at > now() - make_interval(secs => ${LEASE_SECONDS})))
        ), picked as (
          select o.id from imessage_outbox o join approvals a on a.code = o.approval_code
          where o.workspace_id = ${WS} and a.workspace_id = ${WS} and o.delivered_at is null and o.skipped_at is null
            and o.attempts < ${MAX_NOTIFY_ATTEMPTS}
            and (o.leased_at is null or o.leased_at < now() - make_interval(secs => ${LEASE_SECONDS}))
            and a.status = 'pending' and a.expires_at > now()
          order by o.created_at
          limit (select greatest(0, least(${poll.max}::int, ${cap}::int - n::int)) from used)
          for update of o skip locked
        )
        update imessage_outbox o set leased_at = now(), attempts = o.attempts + 1
        from picked where o.id = picked.id
        returning o.id, o.approval_code, o.kind`,
    // Cap reached (and the bridge can deliver): every other due notice collapses into the summary instead.
    sql`with used as (
          select count(*) as n from imessage_outbox
          where workspace_id = ${WS} and (delivered_at > now() - ${window}::interval
             or (delivered_at is null and skipped_at is null and leased_at > now() - make_interval(secs => ${LEASE_SECONDS})))
        ), due as (
          select o.id from imessage_outbox o join approvals a on a.code = o.approval_code
          where ${poll.max}::int > 0 and (select n from used) >= ${cap}
            and o.workspace_id = ${WS} and a.workspace_id = ${WS} and o.delivered_at is null and o.skipped_at is null and o.attempts < ${MAX_NOTIFY_ATTEMPTS}
            and (o.leased_at is null or o.leased_at < now() - make_interval(secs => ${LEASE_SECONDS}))
            and a.status = 'pending' and a.expires_at > now()
          for update of o skip locked
        )
        update imessage_outbox o set skipped_at = now(), skip_reason = 'rate_limited'
        from due where o.id = due.id
        returning o.id`,
    // One summary per window for approvals collapsed since the last one (claimed here, so overlapping polls send one).
    sql`with last as (
          select coalesce((select (value->>'at')::timestamptz from settings where key = 'imessage_summary'), 'epoch'::timestamptz) as at
        ), pending as (
          select count(distinct o.approval_code)::int as n
          from imessage_outbox o join approvals a on a.code = o.approval_code, last
          where o.workspace_id = ${WS} and o.skip_reason = 'rate_limited' and o.skipped_at > last.at
            and a.status = 'pending' and a.expires_at > now()
        ), claim as (
          insert into settings (key, value)
          select 'imessage_summary', jsonb_build_object('at', now(), 'count', pending.n)
          from pending, last
          where ${poll.max}::int > 0 and pending.n > 0 and last.at < now() - ${window}::interval
          on conflict (key) do update set value = excluded.value
            where coalesce((settings.value->>'at')::timestamptz, 'epoch') < now() - ${window}::interval
          returning (value->>'count')::int as n
        )
        select n from claim`,
  ]);
  const summarized = ((results.at(-1) ?? []) as { n: number }[])[0]?.n ?? 0;
  const leased = (results.at(-3) ?? []) as { id: string; approval_code: string; kind: "approval" | "expiry_warning" }[];
  const notices: BridgeNotice[] = [];
  if (summarized > 0) notices.push({ id: `summary:${Date.now()}`, type: "summary", text: formatSummary(summarized, env.PUBLIC_URL) });
  if (!leased.length) return { ok: true, enabled: true, notices, poll_after_ms: POLL_MS };
  const rows = new Map((await noticeRows(sql, leased.map((l) => l.approval_code))).map((r) => [r.code, r]));
  for (const l of leased) {
    const row = rows.get(l.approval_code);
    if (!row) continue;
    notices.push({ id: l.id, type: l.kind, text: l.kind === "approval" ? formatApprovalNotice(row) : formatExpiryWarning(row) });
  }
  // Individual notices first, the summary of what did not fit last.
  notices.sort((a, b) => Number(a.type === "summary") - Number(b.type === "summary"));
  return { ok: true, enabled: true, notices, poll_after_ms: POLL_MS };
}

/** For /api/status: switches, what the bridge last reported, and notices that could not be delivered. Never throws. */
export async function imessageStatus(sql: Sql | null, env: Env) {
  const cfg = imessageConfig(env);
  const base = {
    enabled: cfg.enabled,
    configured: cfg.configured,
    active: cfg.active,
    missing: cfg.missing,
    owner_phone_set: cfg.owner_phone_set,
    owner_phone_hint: cfg.owner_phone_hint,
  };
  if (!sql) return { ...base, bridge: null };
  try {
    const [row] = await sql`
      select (select value from settings where key = 'imessage_bridge') as bridge,
             (select count(*)::int from imessage_outbox where workspace_id = ${WS} and delivered_at is null and attempts >= ${MAX_NOTIFY_ATTEMPTS}) as undeliverable,
             (select max(delivered_at) from imessage_outbox where workspace_id = ${WS}) as last_delivered_at`;
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

// A 👍 (like) or 👎 (dislike) tapback on the bubble with this iMessage id: the only thing the owner does by iMessage.
export const OwnerCommandSchema = z.object({ action: z.literal("react"), reaction: z.enum(["like", "dislike"]), message_id: z.string().min(1).max(200) });
export type OwnerCommand = z.infer<typeof OwnerCommandSchema>;

/** What the bridge POSTs to /webhooks/photon (signed). `id` is the iMessage event id: the dedupe key. */
export const PhotonEventSchema = z.object({
  id: z.string().min(1).max(200),
  from: z.string().min(3).max(320),
  received_at: z.string().max(64).optional(),
  command: OwnerCommandSchema,
});
export type PhotonEvent = z.infer<typeof PhotonEventSchema>;

/** `reply` empty = text nothing back. `code`: the approval the tapback resolved to, for the audit trail. */
export type CommandResult = { ok: boolean; reply: string; error?: string; code?: string };

/** An expected failure as a short text; undefined for unexpected errors (the route answers 5xx so the bridge retries). */
function friendlyError(err: unknown, code: string | undefined): CommandResult | undefined {
  const e = toApiError(err);
  if (!e) return undefined;
  const c = code ?? "";
  const text: Record<string, string> = {
    not_found: `Request ${c} no longer exists.`,
    approval_expired: `Request ${c} expired.`,
    approval_not_pending: `Request ${c} is already closed: ${e.message.replace(/^Approval is /, "")}.`,
    paused: `Sending is paused. Resume in the app, then tap 👍 again.`,
    suppressed: `Request ${c} can't be sent: the recipient is on the do-not-contact list.`,
    no_consent: `Request ${c} can't be sent: the lead has not opted in to email.`,
    recipient_mismatch: `Request ${c} can't be sent: the lead's email changed after the draft was written.`,
    draft_superseded: `Request ${c} is an old version: ${e.message}.`,
    send_failed: `AgentMail refused the email for ${c}: ${e.message}. Retry from the app.`,
    not_configured: `Crusonia isn't set up for that yet: ${e.message}.`,
  };
  return { ok: false, error: e.code, code, reply: oneLine(text[e.code] ?? `Couldn't do that for ${c || "you"}: ${e.message}.`, 600) };
}

type ApprovalContext = { lead_name: string | null; lead_company: string | null; lead_email: string | null; recipient: string | null; draft_subject: string | null };

async function contextOf(sql: Sql, code: string): Promise<ApprovalContext> {
  const rows = await sql`
    select a.recipient, l.name as lead_name, l.company as lead_company, l.email as lead_email, d.subject as draft_subject
    from approvals a left join leads l on l.id = a.lead_id left join drafts d on d.id = a.draft_id
    where a.workspace_id = ${WS} and a.code = ${code}`;
  return (rows[0] ?? { lead_name: null, lead_company: null, lead_email: null, recipient: null, draft_subject: null }) as ApprovalContext;
}

export async function handleOwnerCommand(ctx: { sql: Sql; env: Env; fetch?: FetchFn }, cmd: OwnerCommand): Promise<CommandResult> {
  const { sql, env } = ctx;
  const deps: Deps = { sql, ws: WS, env, fetch: ctx.fetch, actor: IMESSAGE_ACTOR, sendTtlMinutes: sendApprovalTtlMinutes(env), via: "imessage" };
  let code: string | undefined;

  const approve = async (approvalCode: string): Promise<CommandResult> => {
    const approval = await getApproval(sql, WS, approvalCode);
    if (approval.kind === "send") {
      const c = await contextOf(sql, approval.code);
      const result = await approveAndSend({ sql, ws: WS, env, fetch: ctx.fetch, actor: IMESSAGE_ACTOR, via: "imessage" }, approval.code);
      const to = leadLabel(c);
      if (result.status === "scheduled") {
        return { ok: true, code: approval.code, reply: `Approved. The follow-up to ${to} goes out ${result.send_at.slice(0, 16).replace("T", " ")} UTC unless they reply first.` };
      }
      return result.status === "sent"
        ? { ok: true, code: approval.code, reply: `Approved. Sent "${oneLine(c.draft_subject, 80)}" to ${to}.` }
        : { ok: true, code: approval.code, reply: `Approved. Sending to ${to}; AgentMail hasn't confirmed yet, Crusonia checks again within minutes.` };
    }
    if (approval.kind === "tool") {
      await resolveTool(deps, approval, { decision: "allow" });
      return { ok: true, code: approval.code, reply: `Allowed. The agent can run ${oneLine(String(approval.payload?.name ?? "the tool"), 80)} and continues.` };
    }
    return { ok: false, error: "wrong_kind", code: approval.code, reply: `Request ${approval.code} is a question: answer it in the app.` };
  };

  const reject = async (approvalCode: string): Promise<CommandResult> => {
    const approval = await getApproval(sql, WS, approvalCode);
    if (approval.kind === "question") {
      return { ok: false, error: "wrong_kind", code: approval.code, reply: `Request ${approval.code} is a question: answer it in the app.` };
    }
    if (approval.kind === "tool") {
      await resolveTool(deps, approval, { decision: "deny", reason: "Denied with a 👎 tapback" });
      return { ok: true, code: approval.code, reply: `Denied. The agent won't run ${oneLine(String(approval.payload?.name ?? "the tool"), 80)}.` };
    }
    const c = await contextOf(sql, approval.code);
    await rejectApproval(deps, approval.code, "Rejected with a 👎 tapback");
    return { ok: true, code: approval.code, reply: `Rejected. The draft to ${leadLabel(c)} won't be sent.` };
  };

  try {
    // The bubble decides: only a notice we delivered (with its recorded iMessage id) binds to an approval, and only to
    // the draft version it showed. Tapbacks on anything else are ignored without a reply.
    const [bubble] = await sql`
      select o.approval_code, o.draft_id, a.draft_id as approval_draft_id
      from imessage_outbox o join approvals a on a.code = o.approval_code
      where o.workspace_id = ${WS} and a.workspace_id = ${WS} and o.message_id = ${cmd.message_id}`;
    if (!bubble) return { ok: false, error: "unknown_message", reply: "" };
    code = bubble.approval_code as string;
    if ((bubble.draft_id ?? null) !== (bubble.approval_draft_id ?? null)) {
      return { ok: false, error: "draft_mismatch", code, reply: `That message showed a different version than request ${code} now holds.` };
    }
    return await (cmd.reaction === "like" ? approve(code) : reject(code));
  } catch (err) {
    const friendly = friendlyError(err, code);
    if (friendly) return friendly;
    throw err;
  }
}

/**
 * /webhooks/photon after the signature check: dedupe by iMessage event id (a retried delivery gets the first reply back
 * without acting again), apply the tapback, audit it. Unexpected errors release the claim and throw.
 */
export async function handlePhotonEvent(sql: Sql, env: Env, event: PhotonEvent, fetchFn?: FetchFn): Promise<CommandResult & { duplicate?: boolean }> {
  const eventId = `photon:${event.id}`;
  if (!(await claimWebhookEvent(sql, "photon", eventId))) {
    const prior = await sql`
      select data->>'reply' as reply from events
      where workspace_id = ${WS} and kind = 'imessage_command' and data->>'message_id' = ${event.id}
      order by id desc limit 1`;
    return { ok: true, duplicate: true, reply: (prior[0]?.reply as string | undefined) ?? "" };
  }
  let result: CommandResult;
  try {
    result = await handleOwnerCommand({ sql, env, fetch: fetchFn }, event.command);
  } catch (err) {
    await releaseWebhookEvent(sql, eventId).catch(() => {});
    throw err;
  }
  await sql`insert into events (workspace_id, lead_id, kind, data) values (${WS}, null, 'imessage_command', ${JSON.stringify({
    message_id: event.id,
    action: event.command.action,
    reaction: event.command.reaction,
    target_message_id: event.command.message_id,
    code: result.code ?? null,
    ok: result.ok,
    error: result.error ?? null,
    reply: result.reply.slice(0, 1000),
  })}::jsonb)`;
  return result;
}
