import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  InMemoryChatSessionStore,
  NodeSqliteDatabaseAdapter,
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

  const adapter = new NodeSqliteDatabaseAdapter(dbPath);
  applySqliteMigrations(adapter);
  return new SqliteChatSessionStore(adapter);
}
