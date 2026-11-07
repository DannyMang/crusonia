// Applies src/schema.sql to Neon. Safe to re-run: the schema is idempotent.
//   bun run migrate            (DATABASE_URL from the environment or .dev.vars)
//
// Uses the WebSocket `Client` (not the HTTP `neon()` function, which runs one statement per call).
// A parameterless query goes over Postgres' simple query protocol, which accepts the whole file at
// once and runs it as one implicit transaction: either every statement applies or none do.
import { Client } from "@neondatabase/serverless";
import { ROOT, requireVar } from "./lib/env.ts";

const databaseUrl = requireVar("DATABASE_URL", "Get it from the Neon console (Connect > connection string) and add it to .dev.vars.");
const schema = await Bun.file(`${ROOT}src/schema.sql`).text();

const client = new Client(databaseUrl);
try {
  await client.connect();
  await client.query(schema);
  const { rows } = await client.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
  );
  console.log(`Schema applied. Tables: ${rows.map((r) => r.table_name).join(", ")}`);
} catch (err) {
  console.error("Migration failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await client.end();
}
