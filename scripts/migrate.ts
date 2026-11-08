// Applies src/schema.sql to Neon. Safe to re-run: the schema is idempotent.
//   bun run migrate            (DATABASE_URL from the environment or .dev.vars)
//
// OWNER_CLERK_USER_ID (optional, environment or .dev.vars): the Clerk user who owns the instance. The migration
// makes them the member of the owner workspace ('ws_owner'), which holds every row that existed before workspaces.
// It is passed as a session setting, so the id never has to be written into the repo. Without it the owner joins
// the owner workspace on their first sign-in, as long as the Worker has OWNER_CLERK_USER_ID set.
//
// Uses the WebSocket `Client` (not the HTTP `neon()` function, which runs one statement per call).
// A parameterless query goes over Postgres' simple query protocol, which accepts the whole file at
// once and runs it as one implicit transaction: either every statement applies or none do.
import { Client } from "@neondatabase/serverless";
import { ROOT, getVar, requireVar } from "./lib/env.ts";

const databaseUrl = requireVar("DATABASE_URL", "Get it from the Neon console (Connect > connection string) and add it to .dev.vars.");
const ownerClerkUserId = getVar("OWNER_CLERK_USER_ID")?.trim() ?? "";
const schema = await Bun.file(`${ROOT}src/schema.sql`).text();

const client = new Client(databaseUrl);
try {
  await client.connect();
  // Session-level (not local): it must outlive this statement and be visible to the schema run below.
  await client.query("select set_config('crusonia.owner_clerk_user_id', $1, false)", [ownerClerkUserId]);
  await client.query(schema);
  const { rows } = await client.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
  );
  console.log(`Schema applied. Tables: ${rows.map((r) => r.table_name).join(", ")}`);
  const { rows: ws } = await client.query<{ workspaces: number; owner_members: number; billing_accounts: number; signup_grants: number }>(
    `select (select count(*)::int from workspaces) as workspaces,
            (select count(*)::int from workspace_members where workspace_id = 'ws_owner') as owner_members,
            (select count(*)::int from billing_accounts where workspace_id = 'ws_owner') as billing_accounts,
            (select count(*)::int from credit_ledger where workspace_id = 'ws_owner' and reason = 'grant' and source like 'signup:%') as signup_grants`,
  );
  const s = ws[0]!;
  console.log(
    `Workspaces: ${s.workspaces}. Owner workspace: ${s.owner_members} member(s), ${s.billing_accounts} billing account(s), ${s.signup_grants} free-sample grant(s).`,
  );
  if (!s.owner_members) {
    console.log(
      ownerClerkUserId
        ? "Note: OWNER_CLERK_USER_ID is already a member of another workspace, so it was not added to the owner workspace."
        : "Note: OWNER_CLERK_USER_ID is not set, so the owner workspace has no member yet (set it on the Worker; the owner joins on first sign-in).",
    );
  }
} catch (err) {
  console.error("Migration failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await client.end();
}
