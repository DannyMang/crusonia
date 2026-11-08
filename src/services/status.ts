// What is configured and whether the database answers. Works with no keys at all.
import { getSql } from "../db.ts";
import type { Env } from "../env.ts";
import { describeError } from "./errors.ts";

export type Status = {
  providers: Record<string, { configured: boolean; used_for: string; missing?: string[] }>;
  database: {
    configured: boolean;
    reachable: boolean | null;
    error?: string;
    leads_by_stage?: Record<string, number>;
    total_leads?: number;
    pending_approvals?: number;
    profile_saved?: boolean;
    paused?: boolean;
  };
  next_steps: string[];
};

function provider(env: Env, used_for: string, keys: (keyof Env)[]) {
  const missing = keys.filter((k) => !env[k]);
  return missing.length ? { configured: false, used_for, missing: missing as string[] } : { configured: true, used_for };
}

export async function getStatus(env: Env): Promise<Status> {
  const providers = {
    database: provider(env, "Neon Postgres: leads, drafts, approvals, events", ["DATABASE_URL"]),
    apify: provider(env, "web crawling (read_website) and Google search (search_web)", ["APIFY_TOKEN"]),
    agentmail: provider(env, "sending approved emails to opted-in leads and receiving replies", ["AGENTMAIL_API_KEY", "AGENTMAIL_INBOX_ID"]),
    naive: provider(env, "managed agent sessions (research and drafting)", ["NAIVE_API_KEY"]),
    hubspot: provider(env, "CRM sync: import contacts/companies, push leads, notes and lead status (writes only with HUBSPOT_SYNC_ENABLED=true)", [
      "HUBSPOT_ACCESS_TOKEN",
    ]),
    notion: provider(env, "CRM sync: a Crusonia leads database (writes only with NOTION_SYNC_ENABLED=true)", ["NOTION_API_TOKEN", "NOTION_LEADS_DATABASE_ID"]),
    stripe: provider(env, "billing: credit packs and monthly plans (Checkout, Customer Portal, webhook)", ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]),
  };

  const database: Status["database"] = { configured: providers.database.configured, reachable: null };
  if (database.configured) {
    try {
      const sql = getSql(env.DATABASE_URL);
      const [row] = await sql`
        select
          (select coalesce(jsonb_object_agg(stage, n), '{}'::jsonb)
             from (select stage, count(*)::int as n from leads group by stage) s) as leads_by_stage,
          (select count(*)::int from approvals where status = 'pending' and expires_at > now()) as pending_approvals,
          exists (select 1 from settings where key = 'profile') as profile_saved,
          coalesce((select value = 'true'::jsonb from settings where key = 'paused'), false) as paused`;
      const byStage = (row?.leads_by_stage ?? {}) as Record<string, number>;
      Object.assign(database, {
        reachable: true,
        leads_by_stage: byStage,
        total_leads: Object.values(byStage).reduce((a, b) => a + b, 0),
        pending_approvals: row?.pending_approvals as number,
        profile_saved: row?.profile_saved as boolean,
        paused: row?.paused as boolean,
      });
    } catch (err) {
      database.reachable = false;
      database.error = describeError(err);
    }
  }

  const next_steps: string[] = [];
  if (!database.configured) next_steps.push("Set DATABASE_URL (Neon) and run `bun run migrate` to enable leads, profile, drafts and approvals.");
  else if (!database.reachable) next_steps.push("Fix the database error above (wrong DATABASE_URL, or run `bun run migrate`).");
  else if (!database.profile_saved) next_steps.push("Onboard: read_website on the user's site, propose an ICP, then save_profile.");
  if (!providers.apify.configured) {
    next_steps.push("Set APIFY_TOKEN to enable search_web and full-site crawling (read_website falls back to a plain fetch without it).");
  }
  return { providers, database, next_steps };
}
