// The manual outreach task queue: drafts on a manual channel (LinkedIn, X, intro, the owner's own mailbox). The
// owner copies the text, opens the profile, sends it personally, then marks the task sent (recorded as an outbound
// message, and the lead moves to `sent`) or skips it. Nothing here, or anywhere, sends a manual draft.
// TODO(workspaces): scope by workspace.
import { z } from "zod";
import type { Sql } from "../db.ts";
import { DRAFT_CHANNELS, MANUAL_CHANNELS, openUrl } from "./channels.ts";
import { ServiceError } from "./errors.ts";

export const TASK_STATUSES = ["open", "sent", "skipped", "superseded"] as const;

export const listTasksSchema = z.object({
  status: z.enum([...TASK_STATUSES, "all"]).default("open").describe("open (default): waiting for the owner. sent, skipped, superseded, or all."),
  channel: z.enum(MANUAL_CHANNELS).nullish().describe("Only tasks on this channel."),
  lead_id: z.string().trim().min(1).max(64).nullish().describe("Only tasks for this lead."),
  limit: z.number().int().min(1).max(200).default(50).describe("Maximum tasks to return (default 50)."),
});
export type ListTasksInput = z.input<typeof listTasksSchema>;

export type TaskLead = {
  id: string;
  name: string | null;
  title: string | null;
  company: string | null;
  domain: string | null;
  website: string | null;
  linkedin_url: string | null;
  email: string | null;
  stage: string;
  score: number | null;
  has_consent: boolean;
};

export type Task = {
  id: string;
  lead_id: string;
  version: number;
  channel: (typeof DRAFT_CHANNELS)[number];
  status: string;
  /** The subject (email_manual) or a title like "LinkedIn message to Ada (Acme)". */
  subject: string;
  body: string;
  target_url: string | null;
  /** What "open" opens: the profile, or a mailto: link (email_manual) that only opens the owner's mail client. */
  open_url: string | null;
  citations: { text: string; source_url: string }[];
  created_at: string;
  closed_at: string | null;
  lead: TaskLead;
};

type Row = Omit<Task, "open_url" | "created_at" | "closed_at"> & { created_at: Date | string; closed_at: Date | string | null };

const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);

function toTask(r: Row): Task {
  return { ...r, created_at: iso(r.created_at)!, closed_at: iso(r.closed_at), open_url: openUrl(r, r.lead.email) };
}

const TASK_COLUMNS = (sql: Sql) => sql`
  d.id, d.lead_id, d.version, d.channel, d.status, d.subject, d.body, d.target_url, d.citations, d.created_at, d.closed_at,
  jsonb_build_object('id', l.id, 'name', l.name, 'title', l.title, 'company', l.company, 'domain', l.domain,
                     'website', l.website, 'linkedin_url', l.linkedin_url, 'email', l.email, 'stage', l.stage,
                     'score', l.score, 'has_consent', l.consent_at is not null) as lead`;

/** Tasks, newest first. Open tasks of leads who unsubscribed since are left out (do not contact). */
export async function listTasks(sql: Sql, ws: string, input: ListTasksInput = {}): Promise<{ data: Task[]; open_total: number }> {
  const q = listTasksSchema.parse(input);
  const status = q.status === "all" ? null : q.status;
  const [rows, counts] = await sql.transaction(
    [
      sql`select ${TASK_COLUMNS(sql)}
          from drafts d join leads l on l.id = d.lead_id
          where d.workspace_id = ${ws} and d.channel <> 'email'
            and (${status}::text is null or d.status = ${status})
            and (${q.channel ?? null}::text is null or d.channel = ${q.channel ?? null})
            and (${q.lead_id ?? null}::text is null or d.lead_id = ${q.lead_id ?? null})
            and not (d.status = 'open' and l.stage = 'unsubscribed')
          order by d.created_at desc, d.id
          limit ${q.limit}`,
      sql`select count(*)::int as n from drafts d join leads l on l.id = d.lead_id
          where d.workspace_id = ${ws} and d.channel <> 'email' and d.status = 'open' and l.stage <> 'unsubscribed'`,
    ],
    { readOnly: true },
  );
  return { data: (rows as Row[]).map(toTask), open_total: (counts?.[0]?.n as number) ?? 0 };
}

async function getTask(sql: Sql, ws: string, id: string): Promise<Task> {
  const rows = (await sql`select ${TASK_COLUMNS(sql)} from drafts d join leads l on l.id = d.lead_id
                          where d.workspace_id = ${ws} and d.id = ${id} and d.channel <> 'email'`) as Row[];
  if (!rows[0]) throw new ServiceError("not_found", `No manual task with id ${id}.`);
  return toTask(rows[0]);
}

function notOpen(task: Task): ServiceError {
  return new ServiceError("conflict", `Task ${task.id} is ${task.status}${task.status === "superseded" ? " (a newer version replaced it)" : ""}, not open.`);
}

/** Stages that marking a task sent never moves a lead out of (the conversation is further along, or it ended). */
const AFTER_SEND = ["replied", "interested", "not_interested", "meeting_booked", "unsubscribed"];

/**
 * The owner sent it. Records the outbound message (on the task's channel, with the text actually sent when given)
 * and moves the lead to `sent`, in one statement. Only an open task can be marked sent, and only once.
 */
export async function markTaskSent(sql: Sql, ws: string, id: string, input: { body?: string | null; note?: string | null }, actor: string) {
  const task = await getTask(sql, ws, id);
  if (task.status !== "open") throw notOpen(task);
  if (task.lead.stage === "unsubscribed") throw new ServiceError("invalid", `Lead ${task.lead_id} unsubscribed: do not contact.`);
  const body = input.body?.trim() || null;
  const rows = await sql`
    with d as (
      update drafts set status = 'sent', closed_at = now()
      where workspace_id = ${ws} and id = ${id} and channel <> 'email' and status = 'open'
      returning id, lead_id, channel, subject, body, target_url, version
    ),
    before as (select l.id, l.stage, l.email from leads l where l.workspace_id = ${ws} and l.id = (select lead_id from d)),
    msg as (
      insert into messages (workspace_id, lead_id, direction, channel, to_addr, subject, body)
      select ${ws}, d.lead_id, 'out', d.channel, coalesce(d.target_url, b.email),
             case when d.channel = 'email_manual' then d.subject end, coalesce(${body}::text, d.body)
      from d, before b
      returning id
    ),
    st as (
      update leads set stage = case when stage = any(${AFTER_SEND}::text[]) then stage else 'sent' end, updated_at = now()
      where workspace_id = ${ws} and id = (select lead_id from d)
      returning id, stage
    ),
    ev as (
      insert into events (workspace_id, lead_id, kind, data)
      select ${ws}, d.lead_id, 'task_sent',
             jsonb_build_object('via', 'api', 'draft_id', d.id, 'version', d.version, 'channel', d.channel, 'message_id', (select id from msg),
                                'edited', ${body}::text is not null, 'note', ${input.note ?? null}::text, 'actor', ${actor}::text)
      from d
      union all
      select ${ws}, b.id, 'lead_stage_changed', jsonb_build_object('via', 'task', 'from', b.stage, 'to', st.stage, 'actor', ${actor}::text)
      from before b join st on st.id = b.id
      where st.stage <> b.stage
    )
    select (select stage from st) as stage, (select id from msg) as message_id from d`;
  if (!rows[0]) throw notOpen(await getTask(sql, ws, id));
  return { task: await getTask(sql, ws, id), lead_stage: rows[0].stage as string, message_id: String(rows[0].message_id) };
}

/** The owner decided not to send it. The lead's stage is unchanged. */
export async function skipTask(sql: Sql, ws: string, id: string, input: { reason?: string | null }, actor: string) {
  const task = await getTask(sql, ws, id);
  if (task.status !== "open") throw notOpen(task);
  const rows = await sql`
    with d as (
      update drafts set status = 'skipped', closed_at = now()
      where workspace_id = ${ws} and id = ${id} and channel <> 'email' and status = 'open'
      returning id, lead_id, channel, version
    ),
    ev as (
      insert into events (workspace_id, lead_id, kind, data)
      select ${ws}, lead_id, 'task_skipped',
             jsonb_build_object('via', 'api', 'draft_id', id, 'version', version, 'channel', channel,
                                'reason', ${input.reason ?? null}::text, 'actor', ${actor}::text)
      from d
    )
    select id from d`;
  if (!rows[0]) throw notOpen(await getTask(sql, ws, id));
  return { task: await getTask(sql, ws, id) };
}

export { getTask };
