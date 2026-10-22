import type { Database } from 'bun:sqlite';
import { dedupePromptTracePayloads } from './trace-chunk-migration.js';
import { backfillTraceVariants } from './trace-variant-backfill.js';

/**
 * One-time JS data passes that run at the end of `createDb()`, after every
 * schema pass (migrate + repair + rebuild), so all tables/columns exist.
 * Each pass is idempotent and crash-resumable and carries its own
 * `app_data_migrations` marker, so a crash mid-pass just re-runs it on the
 * next boot — see the individual modules for their safety properties.
 */
export function runBootDataPasses(sqlite: Database): void {
  // Trace payload dedup (see trace-chunk-migration.ts). On large legacy DBs
  // this rewrites every prompt_traces row once and then VACUUMs — expect a
  // one-time slower boot with a smaller DB file afterwards.
  const dedupeStats = dedupePromptTracePayloads(sqlite);
  if (dedupeStats && dedupeStats.rewritten > 0) {
    console.log(`[db] Trace chunk dedup: ${dedupeStats.rewritten}/${dedupeStats.traces} traces rewritten, ${dedupeStats.chunksStored} unique chunks stored (~${(dedupeStats.freedBytesEstimate / 1048576).toFixed(0)} MB of payload moved off rows)${dedupeStats.vacuumed ? ', VACUUM complete' : ''}.`);
  }

  // SC-23b pass: link legacy prompt traces to the swipe that produced them
  // (see trace-variant-backfill.ts). Structural + idempotent; anything the
  // structural rules cannot resolve stays NULL (unknown producer).
  const backfillStats = backfillTraceVariants(sqlite);
  if (backfillStats && backfillStats.linked > 0) {
    console.log(`[db] Trace variant backfill: ${backfillStats.linked}/${backfillStats.traces} legacy traces linked, ${backfillStats.leftNull} left null (unknown producer).`);
  }
}
