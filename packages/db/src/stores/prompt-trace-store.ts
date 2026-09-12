import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { promptTraces, promptTraceChunks, promptTraceChunkRefs } from '../db-schema.js';
import type { ActivatedLoreDetail, ProviderResponseTrace } from '@vibe-tavern/domain';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';
import { deflateTraceValue, inflateTraceValue, type TraceChunk } from '../trace-chunking.js';

// ─── Return type ──────────────────────────────────────────────────────────────

/**
 * Store-level PromptTrace — domain PromptTrace projected from a DB row.
 * JSON columns are parsed into structured types.
 */
export interface PromptTrace {
  id: string;
  chatId: string;
  branchId: string;
  messageId: string;
  model: string;
  presetName: string;
  assembledLayers: unknown[];
  tokenAccounting: Record<string, number>;
  finalPayload: Record<string, unknown>;
  activatedLoreEntries: string[];
  activatedLoreDetail: ActivatedLoreDetail[];
  retrievedMemories: Array<Record<string, unknown>>;
  scriptInjections: Array<Record<string, unknown>>;
  latencyMs: number;
  createdAt: string;
  prefill?: string | null;
  compactionSummary?: string | null;
  sentConfig?: {
    systemRole: string | undefined;
    samplerConfig: Record<string, unknown>;
    messageCount: number;
    visionDescriptions?: Array<{
      attachmentId: string;
      name: string;
      type: "image" | "video" | "audio";
      description: string;
      }>
  } | null;
  providerResponse?: ProviderResponseTrace | null;
}

// ─── Input type ───────────────────────────────────────────────────────────────

export interface SaveTraceData {
  chatId: string;
  branchId: string;
  messageId: string;
  model: string;
  presetName: string;
  assembledLayers: unknown[];
  tokenAccounting: Record<string, number>;
  finalPayload?: Record<string, unknown>;
  activatedLoreEntries: string[];
  activatedLoreDetail: ActivatedLoreDetail[];
  retrievedMemories: Array<Record<string, unknown>>;
  scriptInjections: Array<Record<string, unknown>>;
  latencyMs: number;
  prefill?: string | null;
  compactionSummary?: string | null;
  sentConfig?: {
    systemRole: string | undefined;
    samplerConfig: Record<string, unknown>;
    messageCount: number;
    visionDescriptions?: Array<{
      attachmentId: string;
      name: string;
      type: "image" | "video" | "audio";
      description: string;
      }>
  } | null;
  providerResponse?: ProviderResponseTrace | null;
}

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Prompt-trace CRUD.
 *
 * Extracted from ChatStore (CHAT_STORE_SPLIT_PLAN.md, Wave B, 2026-06-20).
 * Method bodies, signatures, and return types are preserved verbatim — this
 * is a move, not a rewrite. Consumers reach this via `stores.traces.*`
 * through the StoreContainer facade.
 */
export class PromptTraceStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  // ─── Prompt traces ────────────────────────────────────────────────────────

  async saveTrace(data: SaveTraceData): Promise<PromptTrace> {
    const id = this.idGen.next('trace');
    const now = this.clock.now();

    // The three payload columns are stored as chunk-referencing skeletons
    // (trace-chunking.ts): every string ≥ TRACE_CHUNK_THRESHOLD moves into
    // prompt_trace_chunks keyed by its sha256, so the chat history shared by
    // every later trace in a chat is stored once instead of per-trace.
    const layers = deflateTraceValue(data.assembledLayers);
    const final = deflateTraceValue(data.finalPayload ?? {});
    const response = data.providerResponse ? deflateTraceValue(data.providerResponse) : null;
    const chunks = dedupeChunks([layers, final, ...(response ? [response] : [])]);
    const refPairs: Array<{ traceId: string; chunkId: string }> = [];
    for (const deflated of [layers, final, ...(response ? [response] : [])]) {
      for (const chunk of deflated.chunks) refPairs.push({ traceId: id, chunkId: chunk.id });
    }

    this.db.transaction((tx) => {
      if (chunks.length > 0) {
        tx.insert(promptTraceChunks)
          .values(chunks.map((chunk) => ({ id: chunk.id, byteSize: chunk.content.length, content: chunk.content })))
          .onConflictDoNothing()
          .run();
      }
      if (refPairs.length > 0) {
        tx.insert(promptTraceChunkRefs)
          .values(refPairs)
          .onConflictDoNothing()
          .run();
      }
      tx.insert(promptTraces)
        .values({
          id,
          chatId: data.chatId,
          branchId: data.branchId,
          messageId: data.messageId,
          model: data.model,
          presetName: data.presetName,
          assembledLayersJson: JSON.stringify(layers.skeleton),
          tokenAccountingJson: JSON.stringify(data.tokenAccounting),
          finalPayloadJson: JSON.stringify(final.skeleton),
          activatedLoreEntriesJson: JSON.stringify(data.activatedLoreEntries),
          activatedLoreDetailJson: JSON.stringify(data.activatedLoreDetail ?? []),
          retrievedMemoriesJson: JSON.stringify(data.retrievedMemories),
          scriptInjectionsJson: JSON.stringify(data.scriptInjections),
          prefill: data.prefill ?? null,
          compactionSummary: data.compactionSummary ?? null,
          sentConfigJson: data.sentConfig ? JSON.stringify(data.sentConfig) : null,
          providerResponseJson: response ? JSON.stringify(response.skeleton) : null,
          latencyMs: data.latencyMs,
          createdAt: now,
        })
        .run();
    });

    const row = await this.db
      .select()
      .from(promptTraces)
      .where(eq(promptTraces.id, id))
      .get();
    return this.mapRowTrace(row!, await this.hydrateChunkMap([row!]));
  }

  async getTrace(id: string): Promise<PromptTrace | null> {
    const row = await this.db
      .select()
      .from(promptTraces)
      .where(eq(promptTraces.id, id))
      .get();
    if (!row) return null;
    return this.mapRowTrace(row, await this.hydrateChunkMap([row]));
  }

  async getTracesByChat(chatId: string, branchId?: string, messageId?: string): Promise<PromptTrace[]> {
    const conditions = [eq(promptTraces.chatId, chatId)];
    if (branchId) conditions.push(eq(promptTraces.branchId, branchId));
    if (messageId) conditions.push(eq(promptTraces.messageId, messageId));

    const rows = await this.db
      .select()
      .from(promptTraces)
      .where(and(...conditions))
      // Secondary sort on id (monotonic per-prefix via IncrementingStoreIdGenerator)
      // so traces sharing the same createdAt millisecond have a deterministic
      // order: the most-recently-inserted id surfaces first. Without this,
      // three traces saved in quick succession can tie on createdAt and return
      // in arbitrary order (flaky `list-prompt-traces` test).
      .orderBy(desc(promptTraces.createdAt), desc(promptTraces.id))
      .all();
    const chunkMap = await this.hydrateChunkMap(rows);
    return rows.map((row) => this.mapRowTrace(row, chunkMap));
  }

  // ─── Chunk maintenance ────────────────────────────────────────────────

  /**
   * Reclaim chunks referenced only by traces that no longer exist. Traces
   * are removed exclusively via FK cascades (chat/branch/message deletion),
   * so the runtime calls this right after those operations. Chunks shared
   * with surviving traces stay — content addressing keeps them valid across
   * chats.
   */
  async sweepOrphanedChunks(): Promise<void> {
    try {
      this.db.transaction((tx) => {
        tx.run(sql`DELETE FROM prompt_trace_chunk_refs WHERE trace_id NOT IN (SELECT id FROM prompt_traces)`);
        tx.run(sql`DELETE FROM prompt_trace_chunks WHERE id NOT IN (SELECT chunk_id FROM prompt_trace_chunk_refs)`);
      });
    } catch (error: unknown) {
      // Best-effort reclamation of already-orphaned rows; never break the
      // user-visible delete operation that triggered the sweep.
      console.warn(`[db] prompt-trace chunk sweep skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ─── Chunk hydration ─────────────────────────────────────────────────────

  /**
   * Batch-load every chunk referenced by the given rows' skeleton columns.
   * Chunk ids are harvested without a full JSON walk (raw substring scan for
   * the marker), then fetched via SELECT … IN in bounded batches. A referenced
   * chunk missing from the store makes the subsequent inflate throw —
   * chunks and rows commit in one transaction, so that is corruption, not a
   * race, and must surface loudly.
   */
  private async hydrateChunkMap(rows: Array<typeof promptTraces.$inferSelect>): Promise<Map<string, string>> {
    const ids = new Set<string>();
    const marker = '"$vtchunk"';
    for (const row of rows) {
      for (const column of [row.assembledLayersJson, row.finalPayloadJson, row.providerResponseJson]) {
        if (column && column.includes(marker)) {
          for (const id of collectMarkerIds(column)) ids.add(id);
        }
      }
    }
    const map = new Map<string, string>();
    const idList = [...ids];
    const BATCH = 500; // keep the IN clause inside SQLite variable limits
    for (let i = 0; i < idList.length; i += BATCH) {
      const slice = idList.slice(i, i + BATCH);
      const found = await this.db
        .select({ id: promptTraceChunks.id, content: promptTraceChunks.content })
        .from(promptTraceChunks)
        .where(inArray(promptTraceChunks.id, slice))
        .all();
      for (const chunk of found) map.set(chunk.id, chunk.content);
    }
    return map;
  }

  // ─── Row mappers ──────────────────────────────────────────────────────────

  private mapRowTrace(row: typeof promptTraces.$inferSelect, chunkMap: Map<string, string>): PromptTrace {
    const lookup = (id: string): string | undefined => chunkMap.get(id);
    return {
      id: row.id,
      chatId: row.chatId,
      branchId: row.branchId,
      messageId: row.messageId,
      model: row.model,
      presetName: row.presetName,
      assembledLayers: inflateTraceValue(JSON.parse(row.assembledLayersJson), lookup),
      tokenAccounting: JSON.parse(row.tokenAccountingJson),
      finalPayload: inflateTraceValue(JSON.parse(row.finalPayloadJson), lookup),
      activatedLoreEntries: JSON.parse(row.activatedLoreEntriesJson),
      activatedLoreDetail: row.activatedLoreDetailJson ? JSON.parse(row.activatedLoreDetailJson) : [],
      retrievedMemories: JSON.parse(row.retrievedMemoriesJson),
      scriptInjections: JSON.parse(row.scriptInjectionsJson),
      latencyMs: row.latencyMs,
      prefill: row.prefill ?? null,
      compactionSummary: row.compactionSummary ?? null,
      sentConfig: row.sentConfigJson ? JSON.parse(row.sentConfigJson) : null,
      providerResponse: row.providerResponseJson ? inflateTraceValue(JSON.parse(row.providerResponseJson), lookup) : null,
      createdAt: row.createdAt,
    };
  }
}

function dedupeChunks(deflated: Array<{ chunks: TraceChunk[] }>): TraceChunk[] {
  const byId = new Map<string, TraceChunk>();
  for (const d of deflated) {
    for (const chunk of d.chunks) if (!byId.has(chunk.id)) byId.set(chunk.id, chunk);
  }
  return [...byId.values()];
}

/** Extract the 64-hex ids from `"$vtchunk":"<id>"` occurrences in a skeleton string. */
function collectMarkerIds(skeletonJson: string): string[] {
  const ids: string[] = [];
  const re = /"\$vtchunk":"([0-9a-f]{64})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(skeletonJson)) !== null) ids.push(m[1]);
  return ids;
}
