/// <reference path="./bun-sqlite.d.ts" />
import { Database } from "bun:sqlite";
import type { SqliteDatabaseAdapter, SqliteRow, SqliteValue } from "./sqlite-adapter.js";

export interface NodeSqliteDatabaseAdapterOptions {
  timeoutMs?: number;
}

export class NodeSqliteDatabaseAdapter implements SqliteDatabaseAdapter {
  private readonly db: Database;
  private inTransaction = false;

  constructor(path: string, options: NodeSqliteDatabaseAdapterOptions = {}) {
    this.db = new Database(path);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`PRAGMA busy_timeout = ${options.timeoutMs ?? 5000};`);
  }

  execute(sql: string, params: SqliteValue[] = []): void {
    if (params.length === 0) {
      this.db.exec(sql);
      return;
    }

    this.db.prepare(sql).run(...params);
  }

  queryAll<T extends SqliteRow>(sql: string, params: SqliteValue[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  queryOne<T extends SqliteRow>(sql: string, params: SqliteValue[] = []): T | null {
    return (this.db.prepare(sql).get(...params) as T | undefined) ?? null;
  }

  transaction<T>(callback: () => T): T {
    if (this.inTransaction) {
      return callback();
    }

    this.inTransaction = true;
    this.db.exec("BEGIN");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      this.inTransaction = false;
      return result;
    } catch (error) {
      this.inTransaction = false;
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures and rethrow the original error.
      }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
