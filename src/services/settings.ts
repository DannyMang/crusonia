// Global pause switch and the suppression list.
import { logEvent, type Sql } from "../db.ts";
import { normalizeEmail } from "./addresses.ts";
import { ApiError } from "../lib/errors.ts";

export async function isPaused(sql: Sql): Promise<boolean> {
  const rows = await sql`select value from settings where key = 'paused'`;
  return rows[0]?.value === true;
}

export async function setPaused(sql: Sql, paused: boolean, actor: string): Promise<boolean> {
  await sql.transaction([
    sql`insert into settings (key, value) values ('paused', ${JSON.stringify(paused)}::jsonb)
        on conflict (key) do update set value = excluded.value`,
    sql`insert into events (lead_id, kind, data)
        values (null, ${paused ? "settings_paused" : "settings_resumed"}, ${JSON.stringify({ actor })}::jsonb)`,
  ]);
  return paused;
}

export type Suppression = { email: string; reason: string; created_at: Date };

export async function listSuppressions(sql: Sql, opts: { after?: string; limit: number; q?: string }) {
  const pattern = opts.q ? `%${opts.q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const rows = (await sql`
    select email, reason, created_at from suppressions
    where (${opts.after ?? null}::text is null or email > ${opts.after ?? null})
      and (${pattern}::text is null or email like ${pattern})
    order by email
    limit ${opts.limit + 1}`) as Suppression[];
  const page = rows.slice(0, opts.limit);
  return { data: page, next_cursor: rows.length > opts.limit ? page.at(-1)!.email : null };
}

export async function addSuppression(sql: Sql, rawEmail: string, reason: string, actor: string, leadId: string | null = null) {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new ApiError(400, "invalid_email", `Not an email address: ${rawEmail}`);
  const inserted = await sql`
    insert into suppressions (email, reason) values (${email}, ${reason})
    on conflict (email) do nothing
    returning email, reason, created_at`;
  if (inserted[0]) {
    const lead = leadId ?? ((await sql`select id from leads where email = ${email}`)[0]?.id as string | undefined) ?? null;
    await logEvent(sql, lead, "suppression_added", { email, reason, actor });
    return { suppression: inserted[0] as Suppression, created: true };
  }
  const existing = await sql`select email, reason, created_at from suppressions where email = ${email}`;
  return { suppression: existing[0] as Suppression, created: false };
}

export async function removeSuppression(sql: Sql, rawEmail: string, actor: string): Promise<boolean> {
  const email = normalizeEmail(rawEmail) ?? rawEmail.trim().toLowerCase();
  const rows = await sql`delete from suppressions where email = ${email} returning email`;
  if (!rows[0]) return false;
  const lead = (await sql`select id from leads where email = ${email}`)[0]?.id as string | undefined;
  await logEvent(sql, lead ?? null, "suppression_removed", { email, actor });
  return true;
}
