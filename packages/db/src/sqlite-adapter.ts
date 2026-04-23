export type SqliteValue = string | number | null;
export type SqliteRow = Record<string, SqliteValue>;

export interface SqliteDatabaseAdapter {
  execute(sql: string, params?: SqliteValue[]): void;
  queryAll<T extends SqliteRow>(sql: string, params?: SqliteValue[]): T[];
  queryOne<T extends SqliteRow>(sql: string, params?: SqliteValue[]): T | null;
  transaction<T>(callback: () => T): T;
}
