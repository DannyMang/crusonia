// Merging two leads that are the same company: `merge` goes into `keep` and is deleted. Everything it collected moves
// to the keeper (evidence, notes, contacts, links, drafts, sessions, the audit trail). Agents can call this, so it never
// moves consent or an address, and it never hides an opt-out: a lead with its own email address, consent or an
// unsubscribe is refused, and so is one with an open send approval or a session working on it.
import type { Sql } from "../db.ts";
import { ServiceError } from "./errors.ts";

type MergeRow = {
  id: string;
  stage: string;
  email: string | null;
  consent_at: Date | null;
  excluded_at: Date | null;
  open_approvals: number;
  open_sessions: number;
};

/** Why these two leads can't be merged, or null. Pure. */
export function mergeProblem(keep: MergeRow | undefined, merge: MergeRow | undefined, ids: { keep: string; merge: string }): string | null {
  if (ids.keep === ids.merge) return "A lead can't be merged into itself.";
  if (!keep) return `No lead with id ${ids.keep}.`;
  if (!merge) return `No lead with id ${ids.merge}.`;
  if (merge.email || merge.consent_at) return `${merge.id} has its own email address or consent: only the owner can merge that one, in Crusonia.`;
  for (const l of [keep, merge]) {
    if (l.stage === "unsubscribed") return `${l.id} unsubscribed: it stays as it is.`;
    if (l.open_sessions > 0) return `An agent is working on ${l.id}; merge after it finishes.`;
  }
  if (merge.open_approvals > 0) return `${merge.id} has an email waiting for the owner's approval.`;
  return null;
}

export async function mergeLeads(sql: Sql, ws: string, input: { keepLeadId: string; mergeLeadId: string; actor: string }) {
  const rows = (await sql`
    select l.id, l.stage, l.email, l.consent_at, l.excluded_at,
      (select count(*)::int from approvals a where a.lead_id = l.id and a.status = 'pending' and a.expires_at > now()) as open_approvals,
      (select count(*)::int from naive_sessions s where s.lead_id = l.id and s.status in ('running', 'idle')) as open_sessions
    from leads l where l.workspace_id = ${ws} and l.id = any(${[input.keepLeadId, input.mergeLeadId]}::text[])`) as MergeRow[];
  const keep = rows.find((r) => r.id === input.keepLeadId);
  const merge = rows.find((r) => r.id === input.mergeLeadId);
  const problem = mergeProblem(keep, merge, { keep: input.keepLeadId, merge: input.mergeLeadId });
  if (problem) throw new ServiceError("invalid", problem);

  const k = input.keepLeadId;
  const m = input.mergeLeadId;
  await sql.transaction([
    sql`update evidence set lead_id = ${k} where workspace_id = ${ws} and lead_id = ${m}`,
    sql`update lookalikes set lead_id = ${k} where workspace_id = ${ws} and lead_id = ${m}`,
    sql`update approvals set lead_id = ${k} where workspace_id = ${ws} and lead_id = ${m}`,
    sql`update messages set lead_id = ${k} where workspace_id = ${ws} and lead_id = ${m}`,
    sql`update naive_sessions set lead_id = ${k} where workspace_id = ${ws} and lead_id = ${m}`,
    sql`update drafts set lead_id = ${k}, version = version + (select coalesce(max(version), 0) from drafts where lead_id = ${k})
        where workspace_id = ${ws} and lead_id = ${m}`,
    sql`update events set lead_id = ${k} where workspace_id = ${ws} and lead_id = ${m}`,
    sql`update lead_notes set lead_id = ${k} where workspace_id = ${ws} and lead_id = ${m}`,
    sql`delete from workflow_run_leads rl where rl.lead_id = ${m}
        and exists (select 1 from workflow_run_leads o where o.run_id = rl.run_id and o.lead_id = ${k})`,
    sql`update workflow_run_leads set lead_id = ${k} where lead_id = ${m}`,
    sql`delete from crm_sync_queue where lead_id = ${m}`,
    // Contacts and links are merged by name and URL. Facts fill gaps only; email, consent and stage stay the keeper's.
    sql`update leads k set
          contacts = k.contacts || coalesce((select jsonb_agg(c) from jsonb_array_elements(x.contacts) c
            where not exists (select 1 from jsonb_array_elements(k.contacts) o where lower(o->>'name') = lower(c->>'name'))), '[]'::jsonb),
          links = k.links || coalesce((select jsonb_agg(c) from jsonb_array_elements(x.links) c
            where not exists (select 1 from jsonb_array_elements(k.links) o where o->>'url' = c->>'url')), '[]'::jsonb),
          name = coalesce(k.name, x.name), title = coalesce(k.title, x.title), company = coalesce(k.company, x.company),
          domain = coalesce(k.domain, x.domain), website = coalesce(k.website, x.website),
          linkedin_url = coalesce(k.linkedin_url, x.linkedin_url), why_summary = coalesce(k.why_summary, x.why_summary),
          excluded_at = coalesce(k.excluded_at, x.excluded_at), excluded_reason = coalesce(k.excluded_reason, x.excluded_reason),
          hubspot_id = coalesce(k.hubspot_id, x.hubspot_id), hubspot_company_id = coalesce(k.hubspot_company_id, x.hubspot_company_id),
          notion_page_id = coalesce(k.notion_page_id, x.notion_page_id), updated_at = now()
        from leads x where k.workspace_id = ${ws} and k.id = ${k} and x.id = ${m}`,
    sql`insert into events (workspace_id, lead_id, kind, data)
        values (${ws}, ${k}, 'lead_merged', ${JSON.stringify({ merged_lead_id: m, reason: "agent", actor: input.actor })}::jsonb)`,
    sql`delete from leads where workspace_id = ${ws} and id = ${m}`,
  ]);
  return { lead_id: k, merged_lead_id: m };
}
