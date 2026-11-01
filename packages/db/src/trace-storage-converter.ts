import type { AppDb } from './db-connection.js';
import { collectTraceChunkIds, deflateTraceValue, inflateTraceValue } from './trace-chunking.js';
import { compressTraceText, decodeTraceText, isCompressedTraceText, type StoredTraceText } from './trace-storage-codec.js';

export const TRACE_STORAGE_CONVERSION_MARKER = 'trace-storage-v2';
const RUNNING_MARKER = 'trace-storage-v2-running';
const SLICE_BUDGET_MS = 15;
const PROGRESS_ROW_INTERVAL = 500;
const PROGRESS_TIME_INTERVAL_MS = 5000;

export interface TraceStorageConversionOptions {
  readonly clock?: { now(): number };
  readonly yieldToEventLoop?: () => Promise<void>;
  readonly signal?: AbortSignal;
  /** Console-free progress channel. Counts are trace rows walked this pass
   * (rows a previous pass already converted included, so a resumed pass still
   * reaches total) over the trace-table size at pass start. Throttled to one
   * emission per 500 rows or 5 s of logical clock time, whichever comes first,
   * plus exactly one final emission when the pass completes. Never called
   * when there is nothing to convert. */
  readonly onProgress?: (converted: number, total: number) => void;
}

export interface TraceStorageConversionStats {
  skippedByMarker: boolean;
  chunksCompressed: number;
  tracesConverted: number;
  sliceDurationsMs: number[];
}

interface StoredTraceRow {
  id: string;
  layers: StoredTraceText;
  final: StoredTraceText;
  response: StoredTraceText | null;
}

/** Row-atomic, restartable conversion. No await can bisect a row transaction.
 * Old chunks are compressed under their OLD plaintext ids first, so v1 refs
 * stay readable while later traces are converted to lists of new block ids.
 * Each trace replaces its refs atomically. Historical forks may have NO refs,
 * so reclamation is deferred until EVERY skeleton's refs have been rebuilt.
 * A single atomic row may exceed 15 ms; no further unit starts before yielding.
 */
export async function runTraceStorageConversion(
  db: AppDb,
  options: TraceStorageConversionOptions = {},
): Promise<TraceStorageConversionStats> {
  const client = db.$client;
  client.exec('CREATE TABLE IF NOT EXISTS app_data_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const stats: TraceStorageConversionStats = { skippedByMarker: false, chunksCompressed: 0, tracesConverted: 0, sliceDurationsMs: [] };
  if (client.query('SELECT name FROM app_data_migrations WHERE name = ?').get(TRACE_STORAGE_CONVERSION_MARKER)) {
    stats.skippedByMarker = true;
    return stats;
  }
  const clock = options.clock ?? { now: () => performance.now() };
  const yieldToEventLoop = options.yieldToEventLoop ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const checkAbort = (): void => { options.signal?.throwIfAborted(); };
  checkAbort();
  client.query('INSERT OR IGNORE INTO app_data_migrations(name, applied_at) VALUES (?, ?)').run(RUNNING_MARKER, new Date().toISOString());
  // Start on a macrotask: even an empty first pass must not run inside the
  // synchronous prefix of the ready/handler-swap call stack.
  await yieldToEventLoop();
  let sliceStart = clock.now();
  const afterUnit = async (): Promise<void> => {
    const duration = clock.now() - sliceStart;
    if (duration >= SLICE_BUDGET_MS) {
      stats.sliceDurationsMs.push(duration);
      await yieldToEventLoop();
      sliceStart = clock.now();
    }
    checkAbort();
  };

  // Progress is throttled here, not by the caller: at most one emission per
  // PROGRESS_ROW_INTERVAL walked trace rows or PROGRESS_TIME_INTERVAL_MS of
  // logical clock time, whichever comes first, plus one final emission.
  const onProgress = options.onProgress;
  let progressEmitted = false;
  let progressRowMark = 0;
  let progressTimeMark = clock.now();
  let tracesWalked = 0;
  let traceTotal = 0;
  const reportProgress = (final: boolean): void => {
    if (!onProgress || (final && !progressEmitted)) return;
    const timestamp = clock.now();
    if (!final && progressEmitted && tracesWalked - progressRowMark < PROGRESS_ROW_INTERVAL && timestamp - progressTimeMark < PROGRESS_TIME_INTERVAL_MS) return;
    progressEmitted = true;
    progressRowMark = tracesWalked;
    progressTimeMark = timestamp;
    onProgress(tracesWalked, traceTotal);
  };

  const nextChunk = client.query<{ id: string; content: StoredTraceText }, [string]>(
    'SELECT id, content FROM prompt_trace_chunks WHERE id > ? ORDER BY id LIMIT 1',
  );
  const updateChunk = client.query('UPDATE prompt_trace_chunks SET content = ?, byte_size = ? WHERE id = ?');
  let cursor = '';
  for (;;) {
    checkAbort();
    const row = nextChunk.get(cursor);
    if (!row) break;
    cursor = row.id;
    if (!isCompressedTraceText(row.content)) {
      const compressed = compressTraceText(decodeTraceText(row.content));
      updateChunk.run(compressed, compressed.byteLength, row.id);
      stats.chunksCompressed++;
    }
    await afterUnit();
  }

  const nextTrace = client.query<StoredTraceRow, [string]>(
    'SELECT id, assembled_layers_json AS layers, final_payload_json AS final, provider_response_json AS response FROM prompt_traces WHERE id > ? ORDER BY id LIMIT 1',
  );
  const getChunk = client.query<{ content: StoredTraceText }, [string]>('SELECT content FROM prompt_trace_chunks WHERE id = ?');
  const insertChunk = client.query('INSERT OR IGNORE INTO prompt_trace_chunks(id, byte_size, content) VALUES (?, ?, ?)');
  const deleteRefs = client.query('DELETE FROM prompt_trace_chunk_refs WHERE trace_id = ?');
  const insertRef = client.query('INSERT OR IGNORE INTO prompt_trace_chunk_refs(trace_id, chunk_id) VALUES (?, ?)');
  const updateTrace = client.query('UPDATE prompt_traces SET assembled_layers_json = ?, final_payload_json = ?, provider_response_json = ? WHERE id = ?');
  const reclaimChunk = client.query('DELETE FROM prompt_trace_chunks WHERE id = ? AND NOT EXISTS (SELECT 1 FROM prompt_trace_chunk_refs WHERE chunk_id = prompt_trace_chunks.id)');

  const convertRow = client.transaction((row: StoredTraceRow): void => {
    const columns = [row.layers, row.final, row.response];
    const deflated = columns.map((column) => {
      if (column === null) return null;
      const skeleton: unknown = JSON.parse(decodeTraceText(column));
      const chunks = new Map<string, string>();
      for (const id of new Set(collectTraceChunkIds(skeleton))) {
        const stored = getChunk.get(id);
        if (stored) chunks.set(id, decodeTraceText(stored.content));
      }
      return deflateTraceValue(inflateTraceValue(skeleton, (id) => chunks.get(id)), 2);
    });
    const seen = new Set<string>();
    for (const value of deflated) {
      for (const chunk of value?.chunks ?? []) {
        if (seen.has(chunk.id)) continue;
        seen.add(chunk.id);
        const compressed = compressTraceText(chunk.content);
        insertChunk.run(chunk.id, compressed.byteLength, compressed);
      }
    }
    deleteRefs.run(row.id);
    for (const id of seen) insertRef.run(row.id, id);
    updateTrace.run(...deflated.map((value) => value === null ? null : compressTraceText(JSON.stringify(value.skeleton))), row.id);
  });

  // Total is the trace-table size at pass start; walked rows include rows a
  // previous pass already converted, so a resumed pass still reaches total.
  traceTotal = onProgress
    ? client.query<{ n: number }, []>('SELECT count(*) AS n FROM prompt_traces').get()!.n
    : 0;
  cursor = '';
  for (;;) {
    checkAbort();
    const row = nextTrace.get(cursor);
    if (!row) break;
    cursor = row.id;
    const columns = [row.layers, row.final, row.response];
    // Our per-row transaction writes all columns together; a resumed pass
    // skips it. Also recognize compressed v1 markers, not only TEXT v1 rows.
    const complete = columns.every((column) => column === null || (isCompressedTraceText(column) && !decodeTraceText(column).includes('"$vtchunk"')));
    if (!complete) {
      convertRow(row);
      stats.tracesConverted++;
    }
    tracesWalked++;
    reportProgress(false);
    await afterUnit();
  }
  // Every surviving skeleton now owns correct refs. Sweep in bounded atomic
  // units, not a synchronous table-wide anti-join, and resume safely if stopped.
  const nextRefOwner = client.query<{ id: string }, [string]>('SELECT trace_id AS id FROM prompt_trace_chunk_refs WHERE trace_id > ? ORDER BY trace_id LIMIT 1');
  const deleteDeadRefs = client.query('DELETE FROM prompt_trace_chunk_refs WHERE trace_id = ? AND NOT EXISTS (SELECT 1 FROM prompt_traces WHERE id = prompt_trace_chunk_refs.trace_id)');
  cursor = '';
  for (;;) {
    checkAbort();
    const row = nextRefOwner.get(cursor);
    if (!row) break;
    cursor = row.id;
    deleteDeadRefs.run(row.id);
    await afterUnit();
  }
  const nextChunkId = client.query<{ id: string }, [string]>('SELECT id FROM prompt_trace_chunks WHERE id > ? ORDER BY id LIMIT 1');
  cursor = '';
  for (;;) {
    checkAbort();
    const row = nextChunkId.get(cursor);
    if (!row) break;
    cursor = row.id;
    reclaimChunk.run(row.id);
    await afterUnit();
  }
  checkAbort();
  client.transaction(() => {
    client.query('INSERT INTO app_data_migrations(name, applied_at) VALUES (?, ?)').run(TRACE_STORAGE_CONVERSION_MARKER, new Date().toISOString());
    client.query('DELETE FROM app_data_migrations WHERE name = ?').run(RUNNING_MARKER);
  })();
  reportProgress(true);
  return stats;
}

/** While legacy refs are being repaired (including after an interrupted boot),
 * normal deletions may finish but must leave chunk reclamation to the pass. */
export function isTraceStorageConversionRunning(db: AppDb): boolean {
  return !!db.$client.query('SELECT name FROM app_data_migrations WHERE name = ?').get(RUNNING_MARKER);
}
