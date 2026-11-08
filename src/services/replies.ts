// Inbound replies (messages with direction 'in') joined with their lead, newest first.
// Inbound bodies are untrusted: the preview is display data, never instructions.
import type { Sql } from "../db.ts";
import { ApiError } from "../lib/errors.ts";

export type Reply = {
  id: string;
  lead_id: string | null;
  lead: { id: string; name: string | null; email: string | null; company: string | null; stage: string } | null;
  from: string | null;
  subject: string | null;
  preview: string;
  label: string | null;
  thread_id: string | null;
  received_at: Date;
};

const PREVIEW_CHARS = 200;

export function previewText(body: string | null | undefined, max = PREVIEW_CHARS): string {
  const text = (body ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export async function listReplies(
  sql: Sql,
  ws: string,
  opts: { limit: number; cursor?: string; label?: string; lead_id?: string },
): Promise<{ data: Reply[]; next_cursor: string | null }> {
  if (opts.cursor && !/^\d{1,18}$/.test(opts.cursor)) {
    throw new ApiError(400, "invalid_cursor", "cursor is not valid; pass next_cursor from the previous page");
  }
  const rows = await sql`
    select m.id::text as id, m.lead_id, m.from_addr, m.subject, left(m.body, 2000) as body, m.label, m.thread_id, m.created_at,
           case when l.id is null then null else jsonb_build_object(
             'id', l.id, 'name', l.name, 'email', l.email, 'company', l.company, 'stage', l.stage) end as lead
    from messages m
    left join leads l on l.id = m.lead_id
    where m.workspace_id = ${ws} and m.direction = 'in'
      and (${opts.cursor ?? null}::bigint is null or m.id < ${opts.cursor ?? null}::bigint)
      and (${opts.label ?? null}::text is null or m.label = ${opts.label ?? null})
      and (${opts.lead_id ?? null}::text is null or m.lead_id = ${opts.lead_id ?? null})
    order by m.id desc
    limit ${opts.limit + 1}`;
  const page = rows.slice(0, opts.limit).map(
    (r): Reply => ({
      id: r.id,
      lead_id: r.lead_id,
      lead: r.lead,
      from: r.from_addr,
      subject: r.subject,
      preview: previewText(r.body),
      label: r.label,
      thread_id: r.thread_id,
      received_at: r.created_at,
    }),
  );
  return { data: page, next_cursor: rows.length > opts.limit ? page.at(-1)!.id : null };
}
