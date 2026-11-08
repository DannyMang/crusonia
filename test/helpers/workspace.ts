// Throwaway workspaces for integration tests on a shared dev database: each suite works in its own workspaces,
// so it never touches the owner workspace's data (or another agent's), and deletes everything in them afterwards.
import type { Sql } from "../../src/db.ts";
import { createApiKey } from "../../src/services/api-keys.ts";

/** A new workspace `ws_it_<label>_<random>`. */
export async function createTestWorkspace(sql: Sql, label: string, opts: { clerkUserId?: string } = {}): Promise<string> {
  const id = `ws_it_${label}_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
  await sql`insert into workspaces (id, name) values (${id}, ${`Test ${label}`})`;
  if (opts.clerkUserId) await sql`insert into workspace_members (workspace_id, clerk_user_id) values (${id}, ${opts.clerkUserId})`;
  return id;
}

/** A user API key for a workspace (the full key). */
export async function testKey(sql: Sql, ws: string, name = "test key"): Promise<string> {
  return (await createApiKey(sql, ws, name, "test")).key;
}

/**
 * Deletes every row of the given workspaces, then the workspaces (the ledger delete is allowed in this transaction
 * only). Never the owner workspace.
 */
export async function deleteTestWorkspaces(sql: Sql, ids: string[]): Promise<void> {
  const ws = ids.filter((id) => id && id !== "ws_owner");
  if (!ws.length) return;
  await sql.transaction([
    sql`select set_config('crusonia.allow_ledger_delete', 'on', true)`,
    sql`delete from crm_sync_queue where workspace_id = any(${ws}::text[])`,
    sql`delete from naive_session_events where workspace_id = any(${ws}::text[])`,
    sql`delete from approvals where workspace_id = any(${ws}::text[])`,
    sql`delete from messages where workspace_id = any(${ws}::text[])`,
    sql`delete from drafts where workspace_id = any(${ws}::text[])`,
    sql`delete from evidence where workspace_id = any(${ws}::text[])`,
    sql`delete from lookalikes where workspace_id = any(${ws}::text[])`,
    sql`delete from naive_sessions where workspace_id = any(${ws}::text[])`,
    sql`delete from events where workspace_id = any(${ws}::text[])`,
    sql`delete from suppressions where workspace_id = any(${ws}::text[])`,
    sql`delete from leads where workspace_id = any(${ws}::text[])`,
    sql`delete from api_keys where workspace_id = any(${ws}::text[])`,
    sql`delete from company_summary_versions where workspace_id = any(${ws}::text[])`,
    sql`delete from credit_ledger where workspace_id = any(${ws}::text[])`,
    sql`delete from billing_accounts where workspace_id = any(${ws}::text[])`,
    sql`delete from workspace_members where workspace_id = any(${ws}::text[])`,
    sql`delete from workspaces where id = any(${ws}::text[])`,
  ]);
}
