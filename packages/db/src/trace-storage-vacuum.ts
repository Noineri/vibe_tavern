import type { AppDb } from './db-connection.js';
import { isTraceStorageConversionRunning, TRACE_STORAGE_CONVERSION_MARKER } from './trace-storage-converter.js';

export const TRACE_STORAGE_VACUUM_MARKER = 'trace-storage-v2-vacuumed';

/** Claim the one-shot compaction as done WITHOUT running VACUUM — for
 * databases whose conversion pass was a no-op and freed no pages (fresh
 * installs). Keeps the marker write owned by this module so the constant
 * and its writer never drift apart. Idempotent. */
export function markTraceStorageVacuumed(db: AppDb): void {
  db.$client.query('INSERT OR IGNORE INTO app_data_migrations(name, applied_at) VALUES (?, ?)').run(TRACE_STORAGE_VACUUM_MARKER, new Date().toISOString());
}

export interface TraceStorageVacuumOptions {
  /** Wall-clock source for the measured duration (injectable for tests). */
  readonly now?: () => number;
  /** Fires right before VACUUM starts; skip boots fire nothing. */
  readonly onStart?: () => void;
  /** Fires after the success marker is written, carrying the wall time. */
  readonly onDone?: (durationMs: number) => void;
}

/** Run at the NEXT boot, before readiness, after the background pass finished.
 * No request/transaction can be active in this single-process startup phase.
 * Mark only after VACUUM/checkpoint succeeds: an error or interruption retries
 * on a later boot, never silently claims that the file was compacted.
 * Console visibility stays with the caller — this module only measures and
 * reports through the options hooks. */
export function vacuumTraceStorageOnce(db: AppDb, options: TraceStorageVacuumOptions = {}): boolean {
  const client = db.$client;
  const marker = client.query('SELECT name FROM app_data_migrations WHERE name = ?');
  if (!marker.get(TRACE_STORAGE_CONVERSION_MARKER) || marker.get(TRACE_STORAGE_VACUUM_MARKER) || isTraceStorageConversionRunning(db)) return false;
  const now = options.now ?? Date.now;
  options.onStart?.();
  const startedAt = now();
  client.exec('VACUUM');
  client.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  markTraceStorageVacuumed(db);
  options.onDone?.(now() - startedAt);
  return true;
}
