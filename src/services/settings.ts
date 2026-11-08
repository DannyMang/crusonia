// Per-workspace pause switch (workspaces.paused) and the workspace's suppression (do-not-contact) list.
import { logEvent, type Sql } from "../db.ts";
import { normalizeEmail } from "./addresses.ts";
import { ApiError } from "../lib/errors.ts";

export async function isPaused(sql: Sql, ws: string): Promise<boolean> {
  const rows = await sql`select paused from workspaces where id = ${ws}`;
  return rows[0]?.paused === true;
}

export async function setPaused(sql: Sql, ws: string, paused: boolean, actor: string): Promise<boolean> {
  await sql.transaction([
    sql`update workspaces set paused = ${paused} where id = ${ws}`,
    sql`insert into events (workspace_id, lead_id, kind, data)
        values (${ws}, null, ${paused ? "settings_paused" : "settings_resumed"}, ${JSON.stringify({ actor })}::jsonb)`,
  ]);
  return paused;
}

export type Suppression = { email: string; reason: string; created_at: Date };

export async function listSuppressions(sql: Sql, ws: string, opts: { after?: string; limit: number; q?: string }) {
  const pattern = opts.q ? `%${opts.q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const rows = (await sql`
    select email, reason, created_at from suppressions
    where workspace_id = ${ws}
      and (${opts.after ?? null}::text is null or email > ${opts.after ?? null})
      and (${pattern}::text is null or email like ${pattern})
    order by email
    limit ${opts.limit + 1}`) as Suppression[];
  const page = rows.slice(0, opts.limit);
  return { data: page, next_cursor: rows.length > opts.limit ? page.at(-1)!.email : null };
}

export async function addSuppression(sql: Sql, ws: string, rawEmail: string, reason: string, actor: string, leadId: string | null = null) {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new ApiError(400, "invalid_email", `Not an email address: ${rawEmail}`);
  const inserted = await sql`
    insert into suppressions (workspace_id, email, reason) values (${ws}, ${email}, ${reason})
    on conflict (workspace_id, email) do nothing
    returning email, reason, created_at`;
  if (inserted[0]) {
    const lead =
      leadId ?? ((await sql`select id from leads where workspace_id = ${ws} and email = ${email}`)[0]?.id as string | undefined) ?? null;
    await logEvent(sql, ws, lead, "suppression_added", { email, reason, actor });
    return { suppression: inserted[0] as Suppression, created: true };
  }
  const existing = await sql`select email, reason, created_at from suppressions where workspace_id = ${ws} and email = ${email}`;
  return { suppression: existing[0] as Suppression, created: false };
}

export async function removeSuppression(sql: Sql, ws: string, rawEmail: string, actor: string): Promise<boolean> {
  const email = normalizeEmail(rawEmail) ?? rawEmail.trim().toLowerCase();
  const rows = await sql`delete from suppressions where workspace_id = ${ws} and email = ${email} returning email`;
  if (!rows[0]) return false;
  const lead = (await sql`select id from leads where workspace_id = ${ws} and email = ${email}`)[0]?.id as string | undefined;
  await logEvent(sql, ws, lead ?? null, "suppression_removed", { email, actor });
  return true;
}
