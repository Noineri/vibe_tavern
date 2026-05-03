import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Database } from "bun:sqlite";
import * as schema from "./_drizzle-schema-legacy.js";

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

export function createDrizzleDb(database: Database): DrizzleDb {
  return drizzle(database, { schema });
}

export { schema };
