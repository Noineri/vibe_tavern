/**
 * One-shot diagnostic: compares CREATE TABLE names in INITIAL_SCHEMA_SQL
 * against sqliteTable declarations in drizzle-schema.ts.
 *
 * Usage: bun run packages/db/scripts/check-drizzle-parity.ts
 * Exit 0 = parity, 1 = mismatch.
 */

import { INITIAL_SCHEMA_SQL } from "../src/schema.js";
import * as schema from "../src/drizzle-schema.js";

// Parse table names from CREATE TABLE statements.
const sqlTables = new Set<string>();
for (const match of INITIAL_SCHEMA_SQL.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)) {
  sqlTables.add(match[1]!);
}

// Collect Drizzle table names by inspecting exported sqliteTable objects.
const drizzleTables = new Set<string>();
for (const [key, value] of Object.entries(schema)) {
  // drizzle sqliteTable objects have a Symbol for the table name.
  if (value && typeof value === "object" && Symbol.for("drizzle:Name") in (value as object)) {
    const name = (value as Record<symbol, string>)[Symbol.for("drizzle:Name")];
    drizzleTables.add(name);
  }
}

const onlyInSql = [...sqlTables].filter((t) => !drizzleTables.has(t));
const onlyInDrizzle = [...drizzleTables].filter((t) => !sqlTables.has(t));

if (onlyInSql.length > 0) {
  console.error("Tables in SQL but missing from Drizzle schema:", onlyInSql);
}
if (onlyInDrizzle.length > 0) {
  console.error("Tables in Drizzle schema but missing from SQL:", onlyInDrizzle);
}

if (onlyInSql.length === 0 && onlyInDrizzle.length === 0) {
  console.log(`Parity OK: ${sqlTables.size} tables match.`);
  process.exit(0);
} else {
  process.exit(1);
}
