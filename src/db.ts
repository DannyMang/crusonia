import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { ServiceError } from "./services/errors.ts";

// HTTP driver: one statement per call, no connection to manage, safe to use per request on Workers.
// For interactive transactions use `Pool`/`Client` inside a single request and close them before returning.
export type Sql = NeonQueryFunction<false, false>;

export function getSql(databaseUrl: string | undefined): Sql {
  if (!databaseUrl) {
    throw new ServiceError(
      "config_missing",
      "DATABASE_URL is not set. Add the Neon connection string to .dev.vars (local) or upload it with `bun run secrets` (Worker), then run `bun run migrate`.",
    );
  }
  return neon(databaseUrl);
}

export type Lead = {
  id: string;
  // Lowercased. Null for agent-found leads without a known email (deduped by domain + name instead).
  email: string | null;
  name: string | null;
  title: string | null;
  company: string | null;
  domain: string | null;
  website: string | null;
  linkedin_url: string | null;
  sells: string | null;
  best_customers: string | null;
  source: string;
  source_url: string | null;
  consent_text: string | null;
  consent_at: Date | null;
  variant: "A" | "B";
  stage: string;
  score: number | null;
  qualified: boolean | null;
  rationale: string | null;
  review_question: string | null;
  reply_label: string | null;
  // HubSpot contact id (a person lead) and company id; set by the HubSpot import and sync.
  hubspot_id: string | null;
  hubspot_company_id?: string | null;
  hubspot_state?: Record<string, unknown>;
  hubspot_synced_at?: Date | null;
  notion_page_id?: string | null;
  notion_hash?: string | null;
  notion_synced_at?: Date | null;
  // Experiment the lead is enrolled in (its arm is `variant`).
  experiment_id?: string | null;
  // Named people and links found on public pages the agent read (src/services/leads.ts Contact, Link).
  contacts?: { name: string; title: string | null; linkedin_url: string | null; x_url: string | null; github_url: string | null; source_url: string; found_at: string }[];
  links?: { kind: string; url: string; source_url: string; found_at: string }[];
  // The agent's "why we picked this" (2-4 sentences citing evidence by number) and suggested next step.
  why_summary?: string | null;
  next_step?: string | null;
  // The owner excluded the company: future runs skip it until un-excluded.
  excluded_at?: Date | null;
  excluded_reason?: string | null;
  created_at: Date;
  updated_at: Date;
};

export type Draft = {
  id: string;
  lead_id: string;
  version: number;
  variant: string;
  subject: string;
  body: string;
  status: string;
  provider_message_id: string | null;
  provider_thread_id: string | null;
  error: string | null;
  // Set when the lead's experiment was running at draft time; the draft counts toward that experiment.
  experiment_id?: string | null;
  // email (AgentMail, approval) | email_manual | linkedin | x | intro (manual tasks; see src/services/channels.ts).
  channel?: string;
  // Manual tasks: the profile the owner opens to send it.
  target_url?: string | null;
  // Factual phrases in the body and the saved evidence behind them: [{ text, source_url }].
  citations?: { text: string; source_url: string }[];
  // Manual tasks: when the owner marked it sent or skipped.
  closed_at?: Date | null;
  created_at: Date;
};

export type Approval = {
  code: string;
  kind: "send" | "tool" | "question";
  lead_id: string | null;
  draft_id: string | null;
  naive_session_id: string | null;
  tool_call_id: string | null;
  summary: string;
  status: string;
  answer: string | null;
  decided_via: string | null;
  expires_at: Date;
  decided_at: Date | null;
  created_at: Date;
};

export async function getLead(sql: Sql, id: string): Promise<Lead | undefined> {
  const rows = await sql`select * from leads where id = ${id}`;
  return rows[0] as Lead | undefined;
}

export async function logEvent(sql: Sql, leadId: string | null, kind: string, data: Record<string, unknown> = {}) {
  await sql`insert into events (lead_id, kind, data) values (${leadId}, ${kind}, ${JSON.stringify(data)}::jsonb)`;
}
