import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../src/db-connection.js';
import { vacuumTraceStorageOnce, TRACE_STORAGE_VACUUM_MARKER } from '../src/trace-storage-vacuum.js';

test('VACUUM is gated by completed conversion, not by a partial running pass', async () => {
  const db = await createDb(':memory:');
  expect(vacuumTraceStorageOnce(db)).toBe(false);
  db.$client.exec("INSERT INTO app_data_migrations(name,applied_at) VALUES ('trace-storage-v2-running','now')");
  expect(vacuumTraceStorageOnce(db)).toBe(false);
  db.$client.exec("INSERT INTO app_data_migrations(name,applied_at) VALUES ('trace-storage-v2','now')");
  expect(vacuumTraceStorageOnce(db)).toBe(false);
  db.$client.exec("DELETE FROM app_data_migrations WHERE name='trace-storage-v2-running'");
  expect(vacuumTraceStorageOnce(db)).toBe(true);
  expect(db.$client.query('SELECT name FROM app_data_migrations WHERE name=?').get(TRACE_STORAGE_VACUUM_MARKER)).not.toBeNull();
  expect(vacuumTraceStorageOnce(db)).toBe(false);
});

test('real file pages are reclaimed once; a later boot does not VACUUM again', async () => {
  // createDb registers this handle and the standard preload sweeps the private
  // run's prefixed temporary directory after closing all SQLite handles.
  const root = await mkdtemp(join(tmpdir(), 'vibe-tavern-trace-vacuum-'));
  const path = join(root, 'fixture.db');
  const db = await createDb(path);
  const client = db.$client;
  client.exec(`CREATE TABLE vacuum_fixture(body BLOB);
    INSERT INTO vacuum_fixture VALUES (zeroblob(1048576));
    DELETE FROM vacuum_fixture;
    INSERT INTO app_data_migrations(name,applied_at) VALUES ('trace-storage-v2','now');
    PRAGMA wal_checkpoint(TRUNCATE);`);
  const before = Bun.file(path).size;
  expect(vacuumTraceStorageOnce(db)).toBe(true);
  expect(Bun.file(path).size).toBeLessThan(before);
  client.exec('INSERT INTO vacuum_fixture VALUES (zeroblob(1048576)); DELETE FROM vacuum_fixture;');
  const freePages = () => client.query<{ freelist_count: number }, []>('PRAGMA freelist_count').get()!.freelist_count;
  const free = freePages();
  expect(free).toBeGreaterThan(0);
  expect(vacuumTraceStorageOnce(db)).toBe(false);
  expect(freePages()).toBe(free);
});

test('a failed VACUUM never claims success and can retry', async () => {
  const db = await createDb(':memory:');
  db.$client.exec("INSERT INTO app_data_migrations(name,applied_at) VALUES ('trace-storage-v2','now'); BEGIN;");
  try {
    expect(() => vacuumTraceStorageOnce(db)).toThrow(/transaction/i);
  } finally {
    db.$client.exec('ROLLBACK');
  }
  expect(db.$client.query('SELECT name FROM app_data_migrations WHERE name=?').get(TRACE_STORAGE_VACUUM_MARKER)).toBeNull();
  expect(vacuumTraceStorageOnce(db)).toBe(true);
});

test('visibility hooks fire with measured wall time only on the vacuum boot', async () => {
  const db = await createDb(':memory:');
  const events: string[] = [];
  let time = 0;
  const hooks = {
    now: () => (time += 1000),
    onStart: () => events.push('start'),
    onDone: (durationMs: number) => events.push(`done:${durationMs}`),
  };
  expect(vacuumTraceStorageOnce(db, hooks)).toBe(false);
  expect(events).toEqual([]);
  db.$client.exec("INSERT INTO app_data_migrations(name,applied_at) VALUES ('trace-storage-v2','now')");
  expect(vacuumTraceStorageOnce(db, hooks)).toBe(true);
  expect(events).toEqual(['start', 'done:1000']);
  expect(vacuumTraceStorageOnce(db, hooks)).toBe(false);
  expect(events).toEqual(['start', 'done:1000']);
});
