import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  BunSqliteDatabaseAdapter,
  InMemoryChatSessionStore,
  SqliteChatSessionStore,
  applySqliteMigrations,
  type ChatSessionStore,
} from "@rp-platform/db";

export function createDefaultSessionStore(): ChatSessionStore {
  const storeMode = (process.env.RP_PLATFORM_CHAT_STORE ?? "sqlite").toLowerCase();
  if (storeMode === "memory" || storeMode === "in-memory") {
    return new InMemoryChatSessionStore();
  }

  const dbPath = resolve(process.cwd(), process.env.RP_PLATFORM_DB_PATH ?? "data/app.sqlite");
  mkdirSync(dirname(dbPath), {
    recursive: true,
  });

  const adapter = new BunSqliteDatabaseAdapter(dbPath);
  applySqliteMigrations(adapter);
  const store = new SqliteChatSessionStore(adapter);
  const report = store.syncCharactersOnStartup();
  const total =
    report.synced + report.imported + report.renamed +
    report.missing + report.malformed + report.duplicate + report.conflict;
  if (total > 0) {
    console.log("[character-sync]", JSON.stringify(report));
  }
  return store;
}
