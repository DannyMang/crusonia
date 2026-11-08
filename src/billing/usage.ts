// Metered usage: a finished Naive session debits its reported spend (naive_sessions.consumed_micro_usd) times
// the markup in src/billing/plans.ts, from the billing owner that started it. Idempotent per session: the debit
// is the difference between what the spend is worth now and what was already debited for the session, written
// under a per-session advisory lock, so a session that resumes and spends more is topped up, never double-charged.
// Apify Actor runs we start (search_web, read_website) are metered the same way, per run (see "Apify" below).
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import type { FetchFn } from "../providers/http.ts";
import { NaiveClient } from "../providers/naive.ts";
import { getActorRun, TERMINAL_RUN_STATUSES, type ApifyMeter, type ApifyRun } from "../services/apify.ts";
import { OWNER_ACCOUNT } from "./accounts.ts";
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

// ---------- Apify ----------
//
// Every Actor run we start is recorded in apify_runs when it starts and when it ends (runActor's meter), then
// debited: usageTotalUsd x the same markup as Naive spend, rounded up to whole credits. The ledger source
// `apify:<run id>:<total credits>` and `apify_runs.debited_credits` (updated in the same statement, under a per-run
// advisory lock) make it idempotent: settling twice writes nothing, and a usage figure that grew later (Apify
// finalizes usage shortly after a run ends) writes only the difference. Apify rows never set credit_ledger.session_id,
// which is what a Naive session's own debit is summed by.

const usd = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v * 1_000_000) : null);

/** Upserts a run's state. Usage only ever goes up; a terminal status is never replaced by a running one. */
export async function recordApifyRun(
  sql: Sql,
  input: { run: ApifyRun; actor: string; maxChargeUsd: number | null; billingOwnerId: string | null; sessionId?: string | null; via?: string },
): Promise<void> {
  const { run } = input;
  const finished = TERMINAL_RUN_STATUSES.has(run.status);
  await sql`
    insert into apify_runs (run_id, actor, status, usage_micro_usd, max_charge_usd, billing_owner_id, session_id, via, finished_at)
    values (${run.id}, ${input.actor}, ${run.status}, ${usd(run.usageTotalUsd)}, ${input.maxChargeUsd}, ${input.billingOwnerId},
            ${input.sessionId ?? null}, ${input.via ?? null}, ${finished ? (run.finishedAt ?? new Date().toISOString()) : null}::timestamptz)
    on conflict (run_id) do update set
      status = case when apify_runs.finished_at is not null and excluded.finished_at is null then apify_runs.status else excluded.status end,
      usage_micro_usd = greatest(apify_runs.usage_micro_usd, excluded.usage_micro_usd),
      finished_at = coalesce(apify_runs.finished_at, excluded.finished_at),
      updated_at = now()`;
}

/** Debits what a run still owes its billing owner. Returns the credits debited by this call (0 if none). */
export async function settleApifyRun(sql: Sql, runId: string): Promise<number> {
  const [, rows] = await sql.transaction([
    sql`select pg_advisory_xact_lock(hashtext(${`apify:${runId}`}))::text as locked`,
    sql`
      with r as (
        select run_id, actor, billing_owner_id, session_id, usage_micro_usd, debited_credits, ${target(sql, "usage_micro_usd")} as total
        from apify_runs
        where run_id = ${runId} and billing_owner_id is not null and usage_micro_usd > 0
      ),
      ins as (
        insert into credit_ledger (owner_id, amount, reason, source, data)
        select billing_owner_id, -(total - debited_credits), 'usage', 'apify:' || run_id || ':' || total,
               jsonb_build_object('kind', 'apify', 'apify_run_id', run_id, 'actor', actor, 'session_id', session_id,
                                  'usage_micro_usd', usage_micro_usd, 'markup_bps', ${USAGE_MARKUP_BPS}::int, 'run_total_credits', total)
        from r
        where total > debited_credits
        on conflict (source) do nothing
        returning owner_id, amount::text
      ),
      up as (
        update apify_runs set debited_credits = (select total from r), updated_at = now()
        where run_id = ${runId} and exists (select 1 from ins)
      )
      select owner_id, amount from ins`,
  ]);
  const row = rows?.[0];
  if (!row) return 0;
  const credits = -Number(row.amount);
  await sql`insert into events (lead_id, kind, data) values (null, 'billing_usage_debited', ${JSON.stringify({
    apify_run_id: runId,
    owner_id: row.owner_id,
    credits,
  })}::jsonb)`;
  return credits;
}

/**
 * The meter handed to runActor: records the run when it starts and when it ends, and debits it once it ended.
 * `billingOwnerId` may be a function, resolved once on the first run (MCP calls look it up lazily).
 */
export function apifyMeter(
  sql: Sql,
  who: { billingOwnerId: string | null | (() => Promise<{ billingOwnerId: string | null; sessionId?: string | null }>); sessionId?: string | null; via: string },
): ApifyMeter {
  let resolved: Promise<{ billingOwnerId: string | null; sessionId?: string | null }> | undefined;
  const owner = () =>
    (resolved ??= typeof who.billingOwnerId === "function" ? who.billingOwnerId() : Promise.resolve({ billingOwnerId: who.billingOwnerId, sessionId: who.sessionId }));
  return {
    async onRun(actor, run, maxChargeUsd) {
      const { billingOwnerId, sessionId } = await owner();
      await recordApifyRun(sql, { run, actor, maxChargeUsd, billingOwnerId, sessionId, via: who.via });
      if (TERMINAL_RUN_STATUSES.has(run.status)) await settleApifyRun(sql, run.id);
    },
  };
}

/**
 * Who pays for Actor runs started over MCP. MCP callers (MCP_TOKEN, API keys) bill the `owner` account, except
 * while Naive sessions with one billing owner are active: the Naive agent calls our MCP tools with MCP_TOKEN, so its
 * data calls bill whoever started the session (and name the session when only one is active).
 * TODO(workspaces): the workspace's billing owner.
 */
export async function mcpBillingOwner(sql: Sql): Promise<{ billingOwnerId: string; sessionId: string | null }> {
  const rows = (await sql`
    select id, billing_owner_id from naive_sessions
    where status in ('running', 'idle') and billing_owner_id is not null and updated_at > now() - interval '1 hour'
    limit 20`) as { id: string; billing_owner_id: string }[];
  const owners = new Set(rows.map((r) => r.billing_owner_id));
  if (owners.size !== 1) return { billingOwnerId: OWNER_ACCOUNT, sessionId: null };
  return { billingOwnerId: [...owners][0]!, sessionId: rows.length === 1 ? rows[0]!.id : null };
}

/**
 * Cron step: re-read runs whose usage may not be final (ended over 2 minutes ago, or never seen ending: the Worker
 * stopped mid-wait) from Apify (a free read), then debit every run that still owes credits.
 */
export async function settleApifyUsage(sql: Sql, env: Env, fetchFn?: FetchFn): Promise<{ refreshed: number; debited: number }> {
  let refreshed = 0;
  if (env.APIFY_TOKEN) {
    const open = (await sql`
      select run_id, actor, max_charge_usd, billing_owner_id, session_id, via from apify_runs
      where usage_final = false and created_at > now() - interval '7 days'
        and ((finished_at is not null and finished_at < now() - interval '2 minutes')
             or (finished_at is null and created_at < now() - interval '10 minutes'))
      order by updated_at limit 10`) as { run_id: string; actor: string; max_charge_usd: string | null; billing_owner_id: string | null; session_id: string | null; via: string | null }[];
    for (const r of open) {
      try {
        const run = await getActorRun(env.APIFY_TOKEN, r.run_id, fetchFn);
        await recordApifyRun(sql, {
          run,
          actor: r.actor,
          maxChargeUsd: r.max_charge_usd === null ? null : Number(r.max_charge_usd),
          billingOwnerId: r.billing_owner_id,
          sessionId: r.session_id,
          via: r.via ?? undefined,
        });
        if (TERMINAL_RUN_STATUSES.has(run.status)) {
          await sql`update apify_runs set usage_final = true, updated_at = now() where run_id = ${r.run_id}`;
          refreshed++;
        }
      } catch (err) {
        console.error(`apify usage refresh ${r.run_id}:`, err instanceof Error ? err.message : err);
      }
    }
  }
  const owing = await sql`
    select run_id from apify_runs
    where billing_owner_id is not null and usage_micro_usd > 0 and created_at > now() - interval '30 days'
      and ${target(sql, "usage_micro_usd")} > debited_credits
    order by updated_at limit 25`;
  let debited = 0;
  for (const { run_id } of owing) {
    try {
      if ((await settleApifyRun(sql, run_id as string)) > 0) debited++;
    } catch (err) {
      console.error(`apify settle ${run_id}:`, err instanceof Error ? err.message : err);
    }
  }
  return { refreshed, debited };
}
