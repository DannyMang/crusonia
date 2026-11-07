import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

// HTTP driver: one statement per call, no connection to manage, safe to use per request on Workers.
// For interactive transactions use `Pool`/`Client` inside a single request and close them before returning.
export type Sql = NeonQueryFunction<false, false>;

export function getSql(databaseUrl: string | undefined): Sql {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  return neon(databaseUrl);
}

export type Lead = {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  website: string | null;
  sells: string | null;
  best_customers: string | null;
  source: string;
  consent_text: string | null;
  consent_at: Date | null;
  variant: "A" | "B";
  stage: string;
  score: number | null;
  qualified: boolean | null;
  rationale: string | null;
  review_question: string | null;
  reply_label: string | null;
  hubspot_id: string | null;
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
