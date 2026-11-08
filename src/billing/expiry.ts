// Rollover of included plan credits: a plan grant carries `expires_at` (the period end plus
// INCLUDED_CREDIT_ROLLOVER_MONTHS); when it passes, the grant's unused rest is written off with an `expire` row.
// "Unused" comes from replaying the owner's ledger: every debit spends the soonest-expiring credits first, then the
// oldest non-expiring ones (packs, the free sample), and a refund spends its own purchase first. Credits spent
// before a debt (negative balance) is paid off pay the debt first.
import { logEvent, type Sql } from "../db.ts";

export type LedgerEntry = {
  id: number;
  amount: number;
  reason: string;
  source: string;
  purchase_source: string | null;
  expires_at: Date | string | null;
  created_at: Date | string;
};

type Lot = { id: number; source: string; remaining: number; expiresAt: number | null };
export type Expiry = { source: string; credits: number; expiresAt: Date };

const time = (v: Date | string) => new Date(v).getTime();

/**
 * Replays a workspace's ledger (any order; sorted by id here). `due`: lots whose expiry is at or before `now`, with
 * their unused credits at that moment, that have no `expire` row yet. `upcoming`: unexpired lots with credits left.
 */
export function replayLedger(entries: LedgerEntry[], now: Date = new Date()): { due: Expiry[]; upcoming: Expiry[] } {
  const rows = [...entries].sort((a, b) => a.id - b.id);
  const lots: Lot[] = [];
  const expired = new Map<string, Expiry>();
  const written = new Set(rows.filter((r) => r.reason === "expire" && r.purchase_source).map((r) => r.purchase_source!));
  let debt = 0;

  const expireUpTo = (t: number) => {
    for (const lot of lots) {
      if (lot.expiresAt !== null && lot.expiresAt <= t && !expired.has(lot.source)) {
        expired.set(lot.source, { source: lot.source, credits: lot.remaining, expiresAt: new Date(lot.expiresAt) });
        lot.remaining = 0;
      }
    }
  };
  const spend = (credits: number, first?: Lot) => {
    let left = credits;
    if (first) {
      const take = Math.min(first.remaining, left);
      first.remaining -= take;
      left -= take;
    }
    const order = lots
      .filter((l) => l.remaining > 0)
      .sort((a, b) => (a.expiresAt ?? Number.POSITIVE_INFINITY) - (b.expiresAt ?? Number.POSITIVE_INFINITY) || a.id - b.id);
    for (const lot of order) {
      if (!left) break;
      const take = Math.min(lot.remaining, left);
      lot.remaining -= take;
      left -= take;
    }
    debt += left;
  };

  for (const r of rows) {
    expireUpTo(time(r.created_at));
    if (r.reason === "expire") continue; // the write-off of a lot already zeroed at its expiry
    if (r.amount > 0) {
      const pay = Math.min(debt, r.amount);
      debt -= pay;
      lots.push({ id: r.id, source: r.source, remaining: r.amount - pay, expiresAt: r.expires_at ? time(r.expires_at) : null });
    } else if (r.amount < 0) {
      const own = r.reason === "refund" && r.purchase_source ? lots.find((l) => l.source === r.purchase_source) : undefined;
      spend(-r.amount, own);
    }
  }
  expireUpTo(now.getTime());

  return {
    due: [...expired.values()].filter((e) => e.credits > 0 && !written.has(e.source)),
    upcoming: lots
      .filter((l) => l.expiresAt !== null && l.remaining > 0 && !expired.has(l.source))
      .sort((a, b) => a.expiresAt! - b.expiresAt!)
      .map((l) => ({ source: l.source, credits: l.remaining, expiresAt: new Date(l.expiresAt!) })),
  };
}

export async function loadLedger(sql: Sql, ws: string): Promise<LedgerEntry[]> {
  const rows = await sql`
    select id::int, amount::text, reason, source, purchase_source, expires_at, created_at
    from credit_ledger where workspace_id = ${ws} order by id`;
  return rows.map((r) => ({ ...(r as LedgerEntry), amount: Number(r.amount) }));
}

/**
 * Cron step: writes the `expire` row for every plan grant whose rollover ended in the last 3 days (a fully spent
 * grant needs no row). Idempotent on `expire:<grant source>`. Returns the number of rows written.
 */
export async function expireCredits(sql: Sql, now: Date = new Date()): Promise<number> {
  const owners = await sql`
    select distinct g.workspace_id from credit_ledger g
    where g.expires_at is not null and g.expires_at <= ${now.toISOString()}::timestamptz
      and g.expires_at > ${now.toISOString()}::timestamptz - interval '3 days'
      and not exists (select 1 from credit_ledger e where e.reason = 'expire' and e.purchase_source = g.source)
    limit 50`;
  let written = 0;
  for (const { workspace_id } of owners) {
    const ws = workspace_id as string;
    const { due } = replayLedger(await loadLedger(sql, ws), now);
    for (const e of due) {
      const inserted = await sql`
        insert into credit_ledger (workspace_id, owner_id, amount, reason, source, purchase_source, data)
        values (${ws}, ${ws}, ${-e.credits}::bigint, 'expire', ${`expire:${e.source}`}, ${e.source},
                ${JSON.stringify({ expired_at: e.expiresAt.toISOString() })}::jsonb)
        on conflict (source) do nothing
        returning id`;
      if (inserted.length) {
        written++;
        await logEvent(sql, ws, null, "billing_credits_expired", { workspace_id: ws, credits: e.credits, purchase_source: e.source });
      }
    }
  }
  return written;
}
