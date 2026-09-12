import type { Database } from 'bun:sqlite';
import { deflateTraceValue, collectTraceChunkIds, TRACE_CHUNK_MARKER } from './trace-chunking.js';

/**
 * One-time data migration: rewrite every prompt-trace payload column into
 * chunk-referencing skeletons (see trace-chunking.ts).
 *
 * This is a JS pass, not a drizzle SQL migration, because chunking needs
 * sha256 + a JSON walk — impossible in SQL. It runs after `migrate()` in
 * `createDb()`, once the `prompt_trace_chunks` table exists (migration 0061).
 *
 * Safety properties:
 * - **Idempotent / crash-resumable.** Rows are processed in batches, one
 *   transaction per batch (chunk inserts + refs + row UPDATE commit together,
 *   so a referenced chunk can never be absent). A crash mid-pass leaves some
 *   rows rewritten and some not; the pass has no completion marker yet, so the
 *   next boot re-runs it — already-rewritten rows deflate to an identical
 *   string and are skipped without a write. The marker is only set after the
 *   full pass, and VACUUM only runs after a non-empty rewrite.
 * - **Behavior-preserving.** The skeleton inflates back to a deep-equal value
 *   (see the trace-chunking roundtrip tests and the migration test that pins
 *   read-path identity on a fixture DB).
 */

const MARKER_TABLE = 'app_data_migrations';
const MIGRATION_NAME = 'prompt_trace_chunk_dedupe_v1';
const BATCH_SIZE = 200;

export interface TraceDedupeStats {
  traces: number;
  rewritten: number;
  chunksStored: number;
  freedBytesEstimate: number;
  vacuumed: boolean;
}

function tableExists(sqlite: Database, name: string): boolean {
  // bun:sqlite returns null (not undefined) when no row matches.
  const row = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return row !== undefined && row !== null;
}

export function isTraceDedupeApplied(sqlite: Database): boolean {
  try {
    if (!tableExists(sqlite, MARKER_TABLE)) return false;
    const row = sqlite.prepare(`SELECT name FROM ${MARKER_TABLE} WHERE name = ?`).get(MIGRATION_NAME);
    return row !== undefined && row !== null;
  } catch {
    return false;
  }
}

interface BatchPlan {
  id: string;
  layers: string;
  final: string;
  response: string | null;
  changed: boolean;
}

/**
 * Rewrite pre-chunking trace rows into skeleton form. Returns null when the
 * pass already completed (marker present) or the prompt_traces table does not
 * exist (fresh/legacy DB being healed by earlier boot phases).
 */
export function dedupePromptTracePayloads(sqlite: Database): TraceDedupeStats | null {
  if (!tableExists(sqlite, 'prompt_traces') || !tableExists(sqlite, 'prompt_trace_chunks')) return null;

  sqlite.exec(`CREATE TABLE IF NOT EXISTS ${MARKER_TABLE} (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  if (isTraceDedupeApplied(sqlite)) return null;

  const stats: TraceDedupeStats = { traces: 0, rewritten: 0, chunksStored: 0, freedBytesEstimate: 0, vacuumed: false };
  const chunkInsert = sqlite.prepare('INSERT OR IGNORE INTO prompt_trace_chunks (id, byte_size, content) VALUES (?, ?, ?)');
  const refInsert = sqlite.prepare('INSERT OR IGNORE INTO prompt_trace_chunk_refs (trace_id, chunk_id) VALUES (?, ?)');
  const updateStmt = sqlite.prepare('UPDATE prompt_traces SET assembled_layers_json = ?, final_payload_json = ?, provider_response_json = ? WHERE id = ?');

  let cursor: string | null = null;
  // Batched scan by primary key so the rewrite never holds the whole table in
  // one transaction — the WAL stays bounded and a crash loses at most one
  // batch of work (re-done idempotently on the next boot).
  for (;;) {
    const rows = (cursor === null
      ? sqlite.prepare('SELECT id, assembled_layers_json AS layers, final_payload_json AS final, provider_response_json AS response FROM prompt_traces ORDER BY id LIMIT ?').all(BATCH_SIZE)
      : sqlite.prepare('SELECT id, assembled_layers_json AS layers, final_payload_json AS final, provider_response_json AS response FROM prompt_traces WHERE id > ? ORDER BY id LIMIT ?').all(cursor, BATCH_SIZE)
    ) as Array<{ id: string; layers: string; final: string; response: string | null }>;
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    stats.traces += rows.length;

    // Per-batch dedup of chunk contents; keyed by id so two rows referencing
    // the same text insert it once.
    const chunkValues = new Map<string, string>();
    // Chunk ids each row references — from the POST-rewrite column strings.
    const rowRefs: Array<{ traceId: string; chunkIds: string[] }> = [];
    const plans: BatchPlan[] = [];

    for (const row of rows) {
      const plan: BatchPlan = { id: row.id, layers: row.layers, final: row.final, response: row.response, changed: false };
      const traceRefIds: string[] = [];
      const deflateColumn = (original: string | null): { text: string | null; refIds: string[] } => {
        if (original === null) return { text: null, refIds: [] };
        const { skeleton, chunks } = deflateTraceValue(JSON.parse(original));
        for (const chunk of chunks) {
          if (!chunkValues.has(chunk.id)) chunkValues.set(chunk.id, chunk.content);
        }
        const rewritten = JSON.stringify(skeleton);
        if (rewritten !== original) {
          plan.changed = true;
          stats.freedBytesEstimate += original.length - rewritten.length;
        }
        // Fresh rewrite: the chunk ids ARE the deflated refs. Already-skeleton
        // column (partial prior run): harvest markers by parsing the skeleton.
        // Cheap pre-filter: markers serialize as `{"$vtchunk":"…"}`.
        const refIds = chunks.length > 0
          ? chunks.map((c) => c.id)
          : rewritten.includes(TRACE_CHUNK_MARKER)
            ? collectTraceChunkIds(JSON.parse(rewritten))
            : [];
        return { text: rewritten, refIds };
      };

      const layersOut = deflateColumn(row.layers);
      const finalOut = deflateColumn(row.final);
      const responseOut = deflateColumn(row.response);
      plan.layers = layersOut.text!;
      plan.final = finalOut.text!;
      plan.response = responseOut.text;
      traceRefIds.push(...layersOut.refIds, ...finalOut.refIds, ...responseOut.refIds);
      if (plan.changed) { stats.rewritten++; plans.push(plan); }
      if (traceRefIds.length > 0) rowRefs.push({ traceId: row.id, chunkIds: traceRefIds });
    }

    sqlite.transaction(() => {
      for (const [id, content] of chunkValues) chunkInsert.run(id, content.length, content);
      for (const { traceId, chunkIds } of rowRefs) {
        for (const chunkId of chunkIds) refInsert.run(traceId, chunkId);
      }
      for (const plan of plans) updateStmt.run(plan.layers, plan.final, plan.response, plan.id);
    })();
    stats.chunksStored += chunkValues.size;
    // The stored chunk contents are paid once against the freed estimate.
    // (freedBytesEstimate was accumulated as Σ original−skeleton above.)

    if (rows.length < BATCH_SIZE) break;
  }

  sqlite.prepare(`INSERT OR REPLACE INTO ${MARKER_TABLE} (name, applied_at) VALUES (?, ?)`).run(MIGRATION_NAME, new Date().toISOString());

  if (stats.rewritten > 0) {
    // Reclaim the freed pages so the file size actually shrinks. Must run
    // outside any transaction; the boot phase is single-connection. Skipped
    // when nothing changed (fresh DBs, marker-only re-runs). The VACUUM's own
    // WAL frames are checkpointed right after so the -wal file doesn't carry
    // hundreds of MB until the autocheckpoint drains them.
    sqlite.exec('VACUUM');
    sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    stats.vacuumed = true;
    // Accurate count of what the table now holds (INSERT OR IGNORE across
    // batches makes per-batch sizes double-count).
    const chunkCount = sqlite.prepare('SELECT COUNT(*) AS n FROM prompt_trace_chunks').get() as { n: number } | null;
    if (chunkCount !== null && chunkCount !== undefined) stats.chunksStored = chunkCount.n;
  }

  return stats;
}
