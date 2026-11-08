// What the agents are doing, in plain words: the Home feed, the Operator's memory of past cycles, and the honest tally
// of things the agents did vs times a person stepped in. Everything comes from the audit events, so it can't drift from
// what really happened. No recommendations and no statistics: only what happened.
import type { Sql } from "../db.ts";

export type FeedRow = {
  id: string;
  kind: string;
  data: Record<string, unknown>;
  created_at: Date | string;
  lead_id: string | null;
  who: string | null;
  score: number | null;
  why: string | null;
};
export type FeedItem = { id: string; at: string; text: string; detail?: string; by: "agent" | "you" | "system"; lead_id: string | null; waiting?: boolean };

const CHANNEL_WORD: Record<string, string> = { linkedin: "LinkedIn note", x: "X message", intro: "intro", email_manual: "email" };

/** The first sentence of a why-summary without its [1] citations, short enough for one row. Pure. */
export function shortWhy(raw: string | null | undefined, max = 70): string | null {
  if (!raw) return null;
  const clean = raw.replace(/\s*\[\d+\]/g, "").replace(/\s+/g, " ").trim();
  const sentence = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  const text = sentence.replace(/[.!?]$/, "");
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}


const isAutomated = (actor: unknown) => typeof actor === "string" && /^(autopilot|agent)/.test(actor);

/** One audit event as a feed row, or null when it isn't worth a row. Pure. */
export function feedItem(r: FeedRow): FeedItem | null {
  const d = r.data ?? {};
  const name = r.who ?? "a lead";
  const row = (text: string, by: FeedItem["by"] = "agent"): FeedItem => ({ id: r.id, at: new Date(r.created_at).toISOString(), text, by, lead_id: r.lead_id });
  switch (r.kind) {
    case "lead_added": {
      // The summary usually opens with the company's name: don't say it twice.
      const why = shortWhy(r.why?.startsWith(`${name} `) ? r.why.slice(name.length + 1) : r.why);
      return d.via === "mcp" ? row(`Found ${name}${why ? ` · ${why}` : ""}`) : null;
    }
    case "find_leads_started":
      return row(d.like_lead_id ? `Looking for companies like one you rated` : `Looking for up to ${d.count ?? 5} new leads`, isAutomated(d.actor) ? "agent" : "you");
    case "research_started":
      return row(`Researching ${name}`, isAutomated(d.actor) ? "agent" : "you");
    case "lead_scored":
      return row(`Researched ${name} · fit ${d.score ?? "?"}`);
    case "lead_needs_review":
      return { ...row(`Waiting for your answer on ${name}`), waiting: true };
    case "draft_created": {
      if (d.via === "api" && !isAutomated(d.actor)) return row(`You wrote an email to ${name}`, "you");
      if (d.channel === "email" || !d.channel) return { ...row(`Waiting for your 👍 on the email to ${name}`), waiting: true };
      return row(`Drafted ${CHANNEL_WORD[d.channel as string] ?? "message"} for ${name}`);
    }
    case "followup_scheduled":
      return row(`Follow-up scheduled for ${name}`, "system");
    case "company_summary_updated":
      return String(d.author ?? "").startsWith("user:")
        ? row("You edited the Company summary", "you")
        : row("Updated the Company summary");
    case "operator_cycle":
      return { ...row(String(d.did ?? "Operator cycle")), ...(typeof d.why === "string" ? { detail: d.why } : {}) };
    case "operate_started":
      return row("Operator is deciding what to do next");
    case "workflow_run_started":
      return isAutomated(d.actor) ? (d.finding ? null : row(`Started a run on ${d.leads} ${d.leads === 1 ? "lead" : "leads"}`)) : row("You started a run", "you");
    case "workflow_run_finished":
      return row(`Finished a run · ${d.found ?? 0} found, ${d.researched ?? 0} researched, ${d.drafted ?? 0} drafted`);
    case "workflow_skipped":
      return row(`Next run is waiting · ${SKIP_TEXT[d.reason as string] ?? String(d.reason ?? "")}`, "system");
    case "approval_approved":
      return row(`You approved the email to ${name}${d.via === "imessage" ? " by iMessage" : ""}`, "you");
    case "approval_rejected":
      return row(`You rejected the email to ${name}`, "you");
    case "email_sent":
      return row(`Sent the email to ${name}`, "system");
    case "email_received":
      return row(`${name} replied`, "system");
    case "task_sent":
      return row(`You sent the message to ${name}`, "you");
    case "task_skipped":
      return row(`You skipped the message to ${name}`, "you");
    case "note_added":
      if (!String(d.author ?? "").startsWith("user:")) return null;
      return row(d.kind === "thumbs_up" ? `You liked ${name}` : d.kind === "thumbs_down" ? `You passed on ${name}` : `You added a note on ${name}`, "you");
    case "lead_excluded":
      return row(`You excluded ${name}`, "you");
    case "autopilot_on":
      return row("Autopilot on", isAutomated(d.actor) ? "system" : "you");
    case "autopilot_off":
      return row("Autopilot off", "you");
    default:
      return null;
  }
}

export const SKIP_TEXT: Record<string, string> = {
  active_run: "the last one is still going",
  spend_cap_reached: "the weekly cap is reached",
  daily_cap_reached: "the daily cap is reached",
  no_credits: "out of credits",
  no_leads: "no new leads to work on",
  failed: "the agent could not start",
};

const FEED_KINDS = [
  "lead_added",
  "find_leads_started",
  "research_started",
  "lead_scored",
  "lead_needs_review",
  "draft_created",
  "followup_scheduled",
  "company_summary_updated",
  "operator_cycle",
  "operate_started",
  "workflow_run_started",
  "workflow_run_finished",
  "workflow_skipped",
  "approval_approved",
  "approval_rejected",
  "email_sent",
  "email_received",
  "task_sent",
  "task_skipped",
  "note_added",
  "lead_excluded",
  "autopilot_on",
  "autopilot_off",
];

/**
 * A lead-finding run scores a lead in the same call that adds it. That first score isn't research, and "Found" already
 * says it, so it gets no row of its own: only a score at least this long after the lead was found does. Pure.
 */
const INLINE_SCORE_MS = 30_000;
export function dropInlineScores(rows: FeedRow[]): FeedRow[] {
  const found = new Map(rows.filter((r) => r.kind === "lead_added" && r.lead_id).map((r) => [r.lead_id!, new Date(r.created_at).getTime()]));
  return rows.filter((r) => {
    if (r.kind !== "lead_scored" || !r.lead_id) return true;
    const at = found.get(r.lead_id);
    return at === undefined || Math.abs(new Date(r.created_at).getTime() - at) > INLINE_SCORE_MS;
  });
}

/** Newest first. `limit` rows are read; rows that say nothing are dropped. */
export async function activityFeed(sql: Sql, ws: string, opts: { limit?: number } = {}): Promise<FeedItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
  const rows = (await sql`
    select e.id::text, e.kind, e.data, e.created_at, e.lead_id, coalesce(l.company, l.name, l.domain, l.email) as who, l.score,
           coalesce(l.why_summary, l.rationale) as why
    from events e left join leads l on l.id = e.lead_id
    where e.workspace_id = ${ws} and e.kind = any(${FEED_KINDS}::text[])
    order by e.id desc limit ${limit}`) as FeedRow[];
  return dropInlineScores(rows).map(feedItem).filter((x): x is FeedItem => x !== null);
}

/** Things the agents did and times a person stepped in, over the last `days` days. */
export async function autonomyCounts(sql: Sql, ws: string, days = 7): Promise<{ agent_actions: number; owner_actions: number; days: number }> {
  const [row] = await sql`
    select
      (count(*) filter (where
        (kind = 'lead_added' and data->>'via' = 'mcp')
        or kind in ('lead_scored', 'lead_needs_review', 'operator_cycle')
        or (kind = 'draft_created' and (coalesce(data->>'via', '') <> 'api' or coalesce(data->>'actor', '') ~ '^(agent|autopilot)'))
        or (kind = 'company_summary_updated' and coalesce(data->>'author', '') not like 'user:%')
      ))::int as agent_actions,
      (count(*) filter (where
        kind in ('approval_approved', 'approval_rejected', 'naive_question_answered', 'naive_tool_decided', 'task_sent', 'task_skipped',
                 'lead_excluded', 'lead_unexcluded')
        or (kind = 'draft_created' and data->>'via' = 'api' and coalesce(data->>'actor', '') !~ '^(agent|autopilot)')
        or (kind = 'note_added' and coalesce(data->>'author', '') like 'user:%')
        or (kind = 'company_summary_updated' and coalesce(data->>'author', '') like 'user:%')
        or (kind in ('workflow_run_started', 'find_leads_started', 'redraft_started') and coalesce(data->>'actor', '') !~ '^(agent|autopilot)')
      ))::int as owner_actions
    from events
    where workspace_id = ${ws} and created_at > now() - make_interval(days => ${days})`;
  return { agent_actions: Number(row?.agent_actions ?? 0), owner_actions: Number(row?.owner_actions ?? 0), days };
}

const RUNNING_TEXT: Record<string, string> = {
  find_leads: "Finding leads",
  operate: "Operator is deciding what to do next",
  onboarding: "Writing the Company summary",
};

/** The sessions open right now, in plain words. One out of budget isn't open: it won't go on, and nothing waits on the owner. */
export async function runningNow(sql: Sql, ws: string) {
  const rows = await sql`
    select s.id, s.purpose, s.status, s.stop_reason, s.lead_id, coalesce(l.company, l.name, l.domain, l.email) as who
    from naive_sessions s left join leads l on l.id = s.lead_id
    where s.workspace_id = ${ws} and s.status in ('running', 'idle') and coalesce(s.stop_reason, '') <> 'budget_paused'
    order by s.created_at desc limit 20`;
  return rows.map((r) => ({
    session_id: r.id as string,
    lead_id: (r.lead_id as string | null) ?? null,
    waiting_on_you: r.status === "idle",
    text:
      r.status === "idle"
        ? `Waiting for you${r.who ? ` on ${r.who}` : ""}`
        : r.purpose === "research"
          ? `Researching ${r.who ?? "a lead"}`
          : r.purpose === "redraft"
            ? `Rewriting the message to ${r.who ?? "a lead"}`
            : (RUNNING_TEXT[r.purpose as string] ?? "Working"),
  }));
}
