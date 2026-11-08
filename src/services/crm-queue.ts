// The CRM sync queue (crm_sync_queue): enqueue, claim, retry with exponential backoff, and the drain loop the
// minute cron runs. The loop is written against the small QueueStore interface so its retry, backoff and
// 429 rules are unit tested without a database; sqlQueueStore is the real one.
import type { Sql } from "../db.ts";
import { ProviderError, RateLimitError } from "../providers/http.ts";
import { missingScopes } from "../providers/hubspot.ts";
import { ENGAGED_STAGES, REPLIED_SYNC_STAGES, type CrmTarget, type SyncScope } from "./crm-fields.ts";
import { describeError } from "./errors.ts";

export type QueueEntity = "lead" | "import";

export type QueueItem = {
  id: string;
  target: CrmTarget;
  entity: QueueEntity;
  lead_id: string | null;
  reason: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  version: number;
};

/** What a handler reports for one item. `more`: not finished (an import page, a capped batch of notes): run again soon. */
export type HandleResult = { skipped?: boolean; more?: boolean; payload?: Record<string, unknown>; warnings?: string[] };

export interface QueueStore {
  claim(target: CrmTarget, entity: QueueEntity, limit: number): Promise<QueueItem[]>;
  /** Done: delete the row, unless it was re-queued meanwhile (then it stays due). `more`: keep it, due now. */
  complete(item: QueueItem, result: HandleResult): Promise<void>;
  /** Count a failed attempt and try again at `at`. */
  retry(item: QueueItem, error: string, at: Date): Promise<void>;
  /** Give up ('failed'): a later event or manual sync re-queues it. */
  giveUp(item: QueueItem, error: string): Promise<void>;
  /** Rate limited: try again at `at` without counting an attempt. */
  defer(item: QueueItem, at: Date): Promise<void>;
  /** Unlock claimed items that were not attempted this run. */
  release(items: QueueItem[]): Promise<void>;
}

// ---------- retry policy ----------

export const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 60_000;
const MAX_DELAY_MS = 6 * 60 * 60_000;

/** Delay before attempt `attempts + 1`: 1, 2, 4, ... minutes, capped at 6 hours, with +-20% jitter. */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), MAX_DELAY_MS);
  return Math.round(base * (0.8 + 0.4 * random()));
}

export type ErrorPlan = {
  /** Try this item again later (false: it is this record's data, retrying cannot help). */
  retry: boolean;
  /** Stop this target for the rest of the run: the next items would fail the same way. */
  stopTarget: boolean;
  message: string;
};

export function classifyError(err: unknown): ErrorPlan {
  if (err instanceof ProviderError) {
    const scopes = missingScopes(err);
    // Retried with backoff (not failed) so the queue resumes by itself once the scope is added to the app.
    if (scopes.length) return { retry: true, stopTarget: true, message: `HubSpot token lacks scope ${scopes.join(", ")}: ${err.message}` };
    if (err.status === undefined || err.status === 408 || err.status >= 500) return { retry: true, stopTarget: true, message: err.message };
    if (err.status === 401 || err.status === 403) return { retry: true, stopTarget: true, message: err.message };
    return { retry: false, stopTarget: false, message: err.message };
  }
  // Our code or the database: retry with backoff, keep going with the other items.
  return { retry: true, stopTarget: false, message: describeError(err) };
}

// ---------- drain ----------

export type DrainReport = {
  claimed: number;
  done: number;
  skipped: number;
  retried: number;
  failed: number;
  deferred: number;
  released: number;
  errors: string[];
  warnings: string[];
  rate_limited_until?: string;
  stopped?: string;
};

export const emptyReport = (): DrainReport => ({
  claimed: 0,
  done: 0,
  skipped: 0,
  retried: 0,
  failed: 0,
  deferred: 0,
  released: 0,
  errors: [],
  warnings: [],
});

/**
 * Runs `handle` on each claimed item in order. Success completes the item; a 429 defers it to the provider's
 * Retry-After without counting an attempt and stops the target for this run (the limit is per account);
 * other errors are retried with backoff up to MAX_ATTEMPTS, or given up at once when retrying cannot help.
 */
export async function drain(
  store: QueueStore,
  items: QueueItem[],
  handle: (item: QueueItem) => Promise<HandleResult>,
  opts: { now?: () => number; random?: () => number; report?: DrainReport } = {},
): Promise<DrainReport> {
  const now = opts.now ?? Date.now;
  const report = opts.report ?? emptyReport();
  report.claimed += items.length;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    let result: HandleResult;
    try {
      result = await handle(item);
    } catch (err) {
      const rest = items.slice(i + 1);
      if (err instanceof RateLimitError) {
        const at = new Date(now() + err.retryAfterMs);
        await store.defer(item, at);
        await store.release(rest);
        report.deferred++;
        report.released += rest.length;
        report.rate_limited_until = at.toISOString();
        break;
      }
      const plan = classifyError(err);
      report.errors.push(`${item.entity}${item.lead_id ? ` ${item.lead_id}` : ""}: ${plan.message}`);
      if (plan.retry && item.attempts + 1 < MAX_ATTEMPTS) {
        await store.retry(item, plan.message, new Date(now() + backoffMs(item.attempts + 1, opts.random)));
        report.retried++;
      } else {
        await store.giveUp(item, plan.message);
        report.failed++;
      }
      if (plan.stopTarget) {
        await store.release(rest);
        report.released += rest.length;
        report.stopped = plan.message;
        break;
      }
      continue;
    }
    await store.complete(item, result);
    if (result.skipped) report.skipped++;
    else report.done++;
    for (const w of result.warnings ?? []) if (!report.warnings.includes(w)) report.warnings.push(w);
  }
  return report;
}

// ---------- scope in SQL (mirror of inScope in ./crm-fields.ts) ----------

/** SQL predicate over `leads l`: is the lead in this target's sync scope. */
export function scopeSql(sql: Sql, target: CrmTarget, scope: SyncScope) {
  if (scope === "all") return sql`(l.email is not null or l.domain is not null)`;
  if (scope === "replied") return sql`((l.email is not null or l.domain is not null) and l.stage = any(${[...REPLIED_SYNC_STAGES]}::text[]))`;
  return sql`((l.email is not null or l.domain is not null) and (
    l.consent_at is not null or l.qualified is true or l.stage = any(${[...ENGAGED_STAGES]}::text[])
    or (${target === "hubspot"}::boolean and (l.hubspot_id is not null or l.hubspot_company_id is not null) and l.score is not null)))`;
}

// ---------- the SQL store ----------

const toItem = (r: Record<string, unknown>): QueueItem => ({
  id: String(r.id),
  target: r.target as CrmTarget,
  entity: r.entity as QueueEntity,
  lead_id: (r.lead_id as string | null) ?? null,
  reason: (r.reason as string | null) ?? null,
  payload: (r.payload as Record<string, unknown>) ?? {},
  attempts: Number(r.attempts),
  version: Number(r.version),
});

/** `leadIds` limits claiming lead items to those leads (tests on a shared database); the import job is unaffected. */
export function sqlQueueStore(sql: Sql, opts: { leadIds?: string[] } = {}): QueueStore & {
  claimLeads(target: CrmTarget, scope: SyncScope, limit: number): Promise<QueueItem[]>;
} {
  const leadIds = opts.leadIds ?? null;
  const claim = async (target: CrmTarget, entity: QueueEntity, limit: number) => {
    const rows = await sql`
      with due as (
        select id from crm_sync_queue
        where target = ${target} and entity = ${entity} and status = 'pending' and next_attempt_at <= now()
          and (locked_until is null or locked_until < now())
          and (${entity} <> 'lead' or ${leadIds}::text[] is null or lead_id = any(${leadIds}::text[]))
        order by next_attempt_at, id
        limit ${limit}
        for update skip locked
      )
      update crm_sync_queue q set locked_until = now() + interval '5 minutes', updated_at = now()
      from due where q.id = due.id
      returning q.id, q.target, q.entity, q.lead_id, q.reason, q.payload, q.attempts, q.version`;
    return rows.map(toItem).sort((a, b) => Number(a.id) - Number(b.id));
  };
  return {
    claim,
    /** Drops queued leads that left the scope (no API call needed), then claims. Forced rows (explicit lead_ids) stay. */
    async claimLeads(target, scope, limit) {
      await sql`
        delete from crm_sync_queue q using leads l
        where q.lead_id = l.id and q.target = ${target} and q.entity = 'lead' and q.status = 'pending'
          and (q.locked_until is null or q.locked_until < now())
          and not coalesce((q.payload->>'force')::boolean, false)
          and (${leadIds}::text[] is null or q.lead_id = any(${leadIds}::text[]))
          and not ${scopeSql(sql, target, scope)}`;
      return claim(target, "lead", limit);
    },
    async complete(item, result) {
      if (result.more) {
        await sql`
          update crm_sync_queue set locked_until = null, attempts = 0, last_error = null, next_attempt_at = now(),
                 payload = coalesce(${result.payload ? JSON.stringify(result.payload) : null}::jsonb, payload), updated_at = now()
          where id = ${item.id}`;
        return;
      }
      await sql`
        with d as (delete from crm_sync_queue where id = ${item.id} and version = ${item.version} returning id)
        update crm_sync_queue set locked_until = null, attempts = 0, last_error = null, updated_at = now()
        where id = ${item.id} and not exists (select 1 from d)`;
    },
    async retry(item, error, at) {
      await sql`
        update crm_sync_queue set attempts = attempts + 1, last_error = ${error.slice(0, 1000)}, next_attempt_at = ${at.toISOString()}::timestamptz,
               locked_until = null, status = 'pending', updated_at = now()
        where id = ${item.id}`;
    },
    async giveUp(item, error) {
      await sql`
        update crm_sync_queue set attempts = attempts + 1, last_error = ${error.slice(0, 1000)}, locked_until = null, status = 'failed', updated_at = now()
        where id = ${item.id}`;
    },
    async defer(item, at) {
      await sql`update crm_sync_queue set next_attempt_at = ${at.toISOString()}::timestamptz, locked_until = null, updated_at = now() where id = ${item.id}`;
    },
    async release(items) {
      if (!items.length) return;
      await sql`update crm_sync_queue set locked_until = null where id = any(${items.map((i) => i.id)}::bigint[])`;
    },
  };
}

/**
 * Queues leads for a target: the given ids (synced even outside the scope: `force`), or every lead in the
 * scope. Re-queuing resets a failed or backed-off row so it runs on the next cron tick.
 */
export async function enqueueLeads(
  sql: Sql,
  target: CrmTarget,
  sel: { leadIds: string[] } | { scope: SyncScope },
  reason: string,
): Promise<{ queued: number; lead_ids?: string[] }> {
  const force = "leadIds" in sel;
  const payload = JSON.stringify(force ? { force: true } : {});
  const filter = force ? sql`l.id = any(${sel.leadIds}::text[])` : scopeSql(sql, target, sel.scope);
  const rows = await sql`
    insert into crm_sync_queue as q (target, entity, lead_id, reason, payload)
    select ${target}, 'lead', l.id, ${reason}, ${payload}::jsonb from leads l where ${filter}
    on conflict (target, entity, (coalesce(lead_id, ''))) do update set
      reason = excluded.reason,
      payload = q.payload || excluded.payload,
      version = q.version + 1,
      attempts = 0,
      last_error = null,
      status = 'pending',
      next_attempt_at = now(),
      updated_at = now()
    returning lead_id`;
  return { queued: rows.length, ...(force ? { lead_ids: rows.map((r) => r.lead_id as string) } : {}) };
}
