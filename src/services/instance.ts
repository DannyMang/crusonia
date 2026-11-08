// The instance's own brakes, on top of each workspace's limits (./limits.ts). Every workspace spends the instance's one
// Naive and Apify account, so with open sign-up someone has to watch the total:
//   - a spend cap: Naive + Apify spend of every workspace but the owner's over a rolling 24 hours, against
//     INSTANCE_DAILY_CAP_USD (default $25);
//   - a kill switch for platform admins (PUT /api/admin/instance), which also stops the owner's workspace.
// Either one stops new paid work: 429 instance_busy for a person, a quiet skip for Autopilot. Sessions already running
// finish, but their web reads stop too, because Apify spend sits outside Naive's budgets. Both go in the events log of
// the owner workspace, the only one that has anything to do with the instance as a whole.
import type { Sql } from "../db.ts";
import type { Env } from "../env.ts";
import { ApiError } from "../lib/errors.ts";
import { isOwnerWorkspace, OWNER_WORKSPACE_ID } from "./workspaces.ts";

const DEFAULT_CAP_USD = 25;
/**
 * A running session reports its spend late, so it counts as at least this much: otherwise a burst of starts all see $0
 * and overshoot the cap. Naive's budget limits one session to $1; a researched lead costs far less. Apify runs still
 * open count as their maxTotalChargeUsd.
 */
export const RUNNING_SESSION_RESERVE_MICRO_USD = 250_000;
const CAP_EVENT_EVERY_HOURS = 1;

/** The settings key of the kill switch. Only tests change it: they share a database with staging, which must not stop. */
const controlKey = (env: Env) => env.INSTANCE_CONTROL_KEY?.trim() || "instance_control";

export const instanceCapMicroUsd = (env: Env) => {
  const raw = env.INSTANCE_DAILY_CAP_USD;
  const n = Number(raw);
  return Math.round((raw?.trim() && Number.isFinite(n) && n >= 0 ? n : DEFAULT_CAP_USD) * 1_000_000);
};

export type InstanceState = { halted: boolean; halted_at: string | null; halted_by: string | null; spent_micro_usd: number; cap_micro_usd: number };

export async function instanceState(sql: Sql, env: Env): Promise<InstanceState> {
  const [row] = await sql`
    select
      (select coalesce(sum(case when status = 'running' then greatest(coalesce(consumed_micro_usd, 0), ${RUNNING_SESSION_RESERVE_MICRO_USD}::bigint)
                                else coalesce(consumed_micro_usd, 0) end), 0)::text
         from naive_sessions where workspace_id <> ${OWNER_WORKSPACE_ID} and created_at > now() - interval '1 day') as naive,
      (select coalesce(sum(case when usage_final then coalesce(usage_micro_usd, 0)
                                else greatest(coalesce(usage_micro_usd, 0), (coalesce(max_charge_usd, 0) * 1000000)::bigint) end), 0)::text
         from apify_runs where workspace_id <> ${OWNER_WORKSPACE_ID} and created_at > now() - interval '1 day') as apify,
      (select value from settings where key = ${controlKey(env)}) as control`;
  const control = (row?.control ?? null) as { halted?: boolean; at?: string; by?: string } | null;
  return {
    halted: control?.halted === true,
    halted_at: control?.halted === true ? (control.at ?? null) : null,
    halted_by: control?.halted === true ? (control.by ?? null) : null,
    spent_micro_usd: Number(row?.naive ?? 0) + Number(row?.apify ?? 0),
    cap_micro_usd: instanceCapMicroUsd(env),
  };
}

export type Brake = "halted" | "cap";

/** Whether a brake stops new paid work in this workspace: the switch stops everyone, the cap everyone but the owner. Pure. */
export function brakeFor(state: Pick<InstanceState, "halted" | "spent_micro_usd" | "cap_micro_usd">, ws: string): Brake | null {
  if (state.halted) return "halted";
  return !isOwnerWorkspace(ws) && state.spent_micro_usd >= state.cap_micro_usd ? "cap" : null;
}

/** The cap reached: one line in the owner's log per hour, not one per refused start. Safe to call on every refusal. */
export async function noteCapReached(sql: Sql, state: Pick<InstanceState, "spent_micro_usd" | "cap_micro_usd">): Promise<void> {
  const data = JSON.stringify({ spent_usd: state.spent_micro_usd / 1_000_000, cap_usd: state.cap_micro_usd / 1_000_000 });
  await sql`
    insert into events (workspace_id, lead_id, kind, data)
    select ${OWNER_WORKSPACE_ID}, null, 'instance_cap_reached', ${data}::jsonb
    where not exists (select 1 from events where workspace_id = ${OWNER_WORKSPACE_ID} and kind = 'instance_cap_reached'
                      and created_at > now() - make_interval(hours => ${CAP_EVENT_EVERY_HOURS}))`;
}

/** The brake on this workspace right now, if any. Logs the cap when it is what stopped it. */
export async function instanceBrake(sql: Sql, env: Env, ws: string): Promise<Brake | null> {
  const state = await instanceState(sql, env);
  const brake = brakeFor(state, ws);
  if (brake === "cap") await noteCapReached(sql, state);
  return brake;
}

/** What a person is told: the same words for the cap and the switch, and calm, because nothing is wrong on their side. */
export const instanceBusy = () => new ApiError(429, "instance_busy", "Crusonia is at capacity right now. New agent runs start again soon; everything you have is safe.");

/** 429 instance_busy when a brake stops new paid work in this workspace. */
export async function requireInstanceOpen(sql: Sql, env: Env, ws: string): Promise<void> {
  if (await instanceBrake(sql, env, ws)) throw instanceBusy();
}

/** Pulls or releases the kill switch, in one transaction with its line in the log. */
export async function setInstanceHalted(sql: Sql, env: Env, halted: boolean, actor: string): Promise<InstanceState> {
  const value = JSON.stringify(halted ? { halted: true, at: new Date().toISOString(), by: actor } : { halted: false });
  await sql.transaction([
    sql`insert into settings (key, value) values (${controlKey(env)}, ${value}::jsonb) on conflict (key) do update set value = excluded.value`,
    sql`insert into events (workspace_id, lead_id, kind, data)
        values (${OWNER_WORKSPACE_ID}, null, ${halted ? "instance_halted" : "instance_resumed"}, ${JSON.stringify({ actor })}::jsonb)`,
  ]);
  return instanceState(sql, env);
}
