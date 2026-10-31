import { runTraceStorageConversion, type AppDb, type TraceStorageConversionOptions } from '@vibe-tavern/db';

/** Fire-and-forget after readiness, joined/cancelled on runtime shutdown.
 * A failure leaves the completion marker absent for the next boot to resume;
 * it never turns a healthy API into a startup failure. */
export function startTraceStorageConversion(db: AppDb, options: Omit<TraceStorageConversionOptions, 'signal'> & {
  log?: (message: string) => void;
  onError?: (error: unknown) => void;
} = {}) {
  const abort = new AbortController();
  const completed = runTraceStorageConversion(db, { ...options, signal: abort.signal }).then((stats) => {
    if (!stats.skippedByMarker) (options.log ?? console.log)(`[db] Trace storage v2: ${stats.chunksCompressed} legacy chunks compressed, ${stats.tracesConverted} traces converted; complete.`);
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
