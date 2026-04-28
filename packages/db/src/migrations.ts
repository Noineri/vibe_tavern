import { INITIAL_SCHEMA_SQL } from "./schema.js";

export interface Migration {
  version: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: "0001_initial_schema",
    sql: INITIAL_SCHEMA_SQL,
  },
];

export function getLatestMigrationVersion(): string {
  return migrations[migrations.length - 1]?.version ?? "none";
}
