// Metered usage: a finished Naive session debits its reported spend (naive_sessions.consumed_micro_usd) times
// the markup in src/billing/plans.ts, from the billing owner that started it. Idempotent per session: the debit
// is the difference between what the spend is worth now and what was already debited for the session, written
// under a per-session advisory lock, so a session that resumes and spends more is topped up, never double-charged.
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import type { FetchFn } from "../providers/http.ts";
import { NaiveClient } from "../providers/naive.ts";
import { MICRO_USD_PER_CREDIT, USAGE_MARKUP_BPS } from "./plans.ts";

// The same formula as creditsForUsage() in plans.ts, in SQL: ceil(micro-USD x bps / (10,000 x micro-USD per credit)).
const target = (sql: Sql, column: string) =>
  sql.unsafe(`ceil(${column}::numeric * ${USAGE_MARKUP_BPS} / ${10_000 * MICRO_USD_PER_CREDIT})::bigint`);

/** Debits what a finished, billable session still owes. Returns the credits debited by this call (0 if none). */
export async function settleSessionUsage(sql: Sql, sessionId: string): Promise<number> {
  const [, rows] = await sql.transaction([
    sql`select pg_advisory_xact_lock(hashtext(${`usage:${sessionId}`}))::text as locked`,
    sql`
      with s as (
        select id, lead_id, purpose, billing_owner_id, consumed_micro_usd, ${target(sql, "consumed_micro_usd")} as total
        from naive_sessions
        where id = ${sessionId} and billing_owner_id is not null and status in ('done', 'error') and consumed_micro_usd > 0
      ),
      d as (select coalesce(-sum(amount), 0)::bigint as debited from credit_ledger where session_id = ${sessionId} and reason = 'usage')
      insert into credit_ledger (owner_id, amount, reason, source, session_id, data)
      select s.billing_owner_id, -(s.total - d.debited), 'usage',
             case when d.debited = 0 then 'usage:' || s.id else 'usage:' || s.id || ':' || s.consumed_micro_usd end,
             s.id,
             jsonb_build_object('purpose', s.purpose, 'lead_id', s.lead_id, 'consumed_micro_usd', s.consumed_micro_usd,
                                'markup_bps', ${USAGE_MARKUP_BPS}::int, 'session_total_credits', s.total)
      from s, d
      where s.total > d.debited
      on conflict (source) do nothing
      returning owner_id, amount::text, (data->>'lead_id') as lead_id, (data->>'consumed_micro_usd') as consumed`,
  ]);
  const row = rows?.[0];
  if (!row) return 0;
  const credits = -Number(row.amount);
  await sql`insert into events (lead_id, kind, data) values (${row.lead_id ?? null}, 'billing_usage_debited', ${JSON.stringify({
    session_id: sessionId,
    owner_id: row.owner_id,
    credits,
    consumed_micro_usd: Number(row.consumed),
  })}::jsonb)`;
  return credits;
}

/**
 * Cron step: fill in the spend of finished billable sessions that never reported it (a free Naive read), then
 * settle every finished billable session that still owes credits (missed or failed debits, later spend).
 */
export async function settleUsage(sql: Sql, env: Env, fetchFn?: FetchFn): Promise<number> {
  if (env.NAIVE_API_KEY) {
    const missing = await sql`
      select id from naive_sessions
      where billing_owner_id is not null and status in ('done', 'error') and consumed_micro_usd is null
        and updated_at > now() - interval '1 day'
      order by updated_at limit 5`;
    const client = new NaiveClient(env.NAIVE_API_KEY, fetchFn);
    for (const { id } of missing) {
      try {
        const remote = await client.getSession(id as string);
        const consumed = typeof remote.consumed_micro_usd === "number" ? Math.round(remote.consumed_micro_usd) : 0;
        await sql`update naive_sessions set consumed_micro_usd = greatest(coalesce(consumed_micro_usd, 0), ${consumed}::bigint) where id = ${id}`;
      } catch (err) {
        console.error(`usage backfill ${id}:`, err instanceof Error ? err.message : err);
      }
    }
  }
  const owing = await sql`
    select s.id from naive_sessions s
    where s.billing_owner_id is not null and s.status in ('done', 'error') and s.consumed_micro_usd > 0
      and s.updated_at > now() - interval '30 days'
      and ${target(sql, "s.consumed_micro_usd")} >
          coalesce((select -sum(l.amount) from credit_ledger l where l.session_id = s.id and l.reason = 'usage'), 0)
    order by s.updated_at limit 25`;
  let debited = 0;
  for (const { id } of owing) {
    try {
      if ((await settleSessionUsage(sql, id as string)) > 0) debited++;
    } catch (err) {
      console.error(`usage settle ${id}:`, err instanceof Error ? err.message : err);
    }
  }
  return debited;
}
