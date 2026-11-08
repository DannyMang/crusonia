// creditsForUsage (./plans.ts) as a SQL expression. Apart from plans.ts because the web bundle imports that file, and it
// stays free of imports.
import type { Sql } from "../db.ts";
import { MICRO_USD_PER_CREDIT, USAGE_MARKUP_BPS } from "./plans.ts";

/** ceil(micro-USD x bps / (10,000 x micro-USD per credit)). `column` is a trusted column name, never user input. */
export const creditsSql = (sql: Sql, column: string) =>
  sql.unsafe(`ceil(${column}::numeric * ${USAGE_MARKUP_BPS} / ${10_000 * MICRO_USD_PER_CREDIT})::bigint`);
