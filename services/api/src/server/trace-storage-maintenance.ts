import { isTraceStorageConversionRunning, markTraceStorageVacuumed, runTraceStorageConversion, vacuumTraceStorageOnce, type AppDb, type TraceStorageConversionOptions } from '@vibe-tavern/db';

/** Fire-and-forget after readiness, joined/cancelled on runtime shutdown.
 * A failure leaves the completion marker absent for the next boot to resume;
 * it never turns a healthy API into a startup failure.
 * All trace-storage console lines render here — packages/db stays console-free.
 * A no-op pass (fresh install, empty trace table) renders nothing and marks
 * the compaction done so later boots stay silent too. */
export function startTraceStorageConversion(db: AppDb, options: Omit<TraceStorageConversionOptions, 'signal' | 'onProgress'> & {
  log?: (message: string) => void;
  onError?: (error: unknown) => void;
} = {}) {
  const log = options.log ?? console.log;
  // A still-present running marker means the previous pass was interrupted
  // mid-way and this boot resumes it; say so before the first progress line.
  if (isTraceStorageConversionRunning(db)) log('[trace-storage] resuming trace conversion');
  const abort = new AbortController();
  let tracesTotal = 0;
  const completed = runTraceStorageConversion(db, {
    ...options,
    signal: abort.signal,
    onProgress: (converted, total) => {
      tracesTotal = total;
      log(`[trace-storage] converting legacy traces: ${converted}/${total} (${Math.min(100, Math.round((converted / total) * 100))}%)`);
    },
  }).then((stats) => {
    if (!stats.skippedByMarker && stats.wasNoOp) {
      // A no-op pass freed no pages, so the next boot's one-shot compaction
      // would reclaim nothing: mark it done (idempotent on later boots) and
      // log nothing — fresh installs boot silent like every completed DB.
      markTraceStorageVacuumed(db);
    } else if (!stats.skippedByMarker) {
      log(`[trace-storage] conversion complete: ${tracesTotal > 0 ? tracesTotal : stats.tracesConverted} traces`);
    }
    return stats;
  }).catch((error: unknown) => {
    if (!abort.signal.aborted) (options.onError ?? ((cause: unknown) => console.error('[db] Trace storage v2 conversion paused; will resume on next boot:', cause)))(error);
    return null;
  });
  return {
    completed,
    stop: async (): Promise<void> => { abort.abort(); await completed; },
  };
}

/** The one-shot marker-gated VACUUM at shared startup, before readiness.
 * One line before it starts, one with the measured wall time after it
 * succeeds; boots that skip the compaction log nothing. */
export function compactTraceStorageOnce(db: AppDb, log: (message: string) => void = console.log): boolean {
  return vacuumTraceStorageOnce(db, {
    onStart: () => log('[trace-storage] compacting the database (one-time; the server becomes ready in a moment)'),
    onDone: (durationMs) => log(`[trace-storage] compaction done in ${(durationMs / 1000).toFixed(1)}s`),
  });
}
