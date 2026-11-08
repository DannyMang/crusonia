// Webhook idempotency: claim a provider event id before acting on it, release it if processing fails so
// the provider's retry is processed instead of being dropped as a duplicate.
import type { Sql } from "../db.ts";

/** True if this call claimed the event; false if it was already processed (or is being processed). */
export async function claimWebhookEvent(sql: Sql, source: string, eventId: string): Promise<boolean> {
  const rows = await sql`
    insert into webhook_events (event_id, source) values (${eventId}, ${source})
    on conflict (event_id) do nothing
    returning event_id`;
  return rows.length > 0;
}

export async function releaseWebhookEvent(sql: Sql, eventId: string): Promise<void> {
  await sql`delete from webhook_events where event_id = ${eventId}`;
}
