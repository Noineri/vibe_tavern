import type { AppDb } from './db-connection.js';
import { isTraceStorageConversionRunning, TRACE_STORAGE_CONVERSION_MARKER } from './trace-storage-converter.js';

export const TRACE_STORAGE_VACUUM_MARKER = 'trace-storage-v2-vacuumed';

/** Run at the NEXT boot, before readiness, after the background pass finished.
 * No request/transaction can be active in this single-process startup phase.
 * Mark only after VACUUM/checkpoint succeeds: an error or interruption retries
 * on a later boot, never silently claims that the file was compacted. */
export function vacuumTraceStorageOnce(db: AppDb): boolean {
  const client = db.$client;
  const marker = client.query('SELECT name FROM app_data_migrations WHERE name = ?');
  if (!marker.get(TRACE_STORAGE_CONVERSION_MARKER) || marker.get(TRACE_STORAGE_VACUUM_MARKER) || isTraceStorageConversionRunning(db)) return false;
  client.exec('VACUUM');
  client.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  client.query('INSERT INTO app_data_migrations(name, applied_at) VALUES (?, ?)').run(TRACE_STORAGE_VACUUM_MARKER, new Date().toISOString());
  return true;
}
