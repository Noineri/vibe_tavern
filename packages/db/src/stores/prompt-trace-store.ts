import { eq, and, desc } from 'drizzle-orm';
import { promptTraces } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

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
      type: "image" | "video";
      description: string;
    }>;
  } | null;
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
      type: "image" | "video";
      description: string;
    }>;
  } | null;
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

    await this.db
      .insert(promptTraces)
      .values({
        id,
        chatId: data.chatId,
        branchId: data.branchId,
        messageId: data.messageId,
        model: data.model,
        presetName: data.presetName,
        assembledLayersJson: JSON.stringify(data.assembledLayers),
        tokenAccountingJson: JSON.stringify(data.tokenAccounting),
        finalPayloadJson: JSON.stringify(data.finalPayload ?? {}),
        activatedLoreEntriesJson: JSON.stringify(data.activatedLoreEntries),
        retrievedMemoriesJson: JSON.stringify(data.retrievedMemories),
        scriptInjectionsJson: JSON.stringify(data.scriptInjections),
        prefill: data.prefill ?? null,
        compactionSummary: data.compactionSummary ?? null,
        sentConfigJson: data.sentConfig ? JSON.stringify(data.sentConfig) : null,
        latencyMs: data.latencyMs,
        createdAt: now,
      })
      .run();

    const row = await this.db
      .select()
      .from(promptTraces)
      .where(eq(promptTraces.id, id))
      .get();
    return this.mapRowTrace(row!);
  }

  async getTrace(id: string): Promise<PromptTrace | null> {
    const row = await this.db
      .select()
      .from(promptTraces)
      .where(eq(promptTraces.id, id))
      .get();
    return row ? this.mapRowTrace(row) : null;
  }

  async getTracesByChat(chatId: string, branchId?: string): Promise<PromptTrace[]> {
    const conditions = branchId
      ? and(eq(promptTraces.chatId, chatId), eq(promptTraces.branchId, branchId))
      : eq(promptTraces.chatId, chatId);

    const rows = await this.db
      .select()
      .from(promptTraces)
      .where(conditions)
      .orderBy(desc(promptTraces.createdAt))
      .all();
    return rows.map((row) => this.mapRowTrace(row));
  }

  // ─── Row mappers ──────────────────────────────────────────────────────────

  private mapRowTrace(row: typeof promptTraces.$inferSelect): PromptTrace {
    return {
      id: row.id,
      chatId: row.chatId,
      branchId: row.branchId,
      messageId: row.messageId,
      model: row.model,
      presetName: row.presetName,
      assembledLayers: JSON.parse(row.assembledLayersJson),
      tokenAccounting: JSON.parse(row.tokenAccountingJson),
      finalPayload: JSON.parse(row.finalPayloadJson),
      activatedLoreEntries: JSON.parse(row.activatedLoreEntriesJson),
      retrievedMemories: JSON.parse(row.retrievedMemoriesJson),
      scriptInjections: JSON.parse(row.scriptInjectionsJson),
      latencyMs: row.latencyMs,
      prefill: row.prefill ?? null,
      compactionSummary: row.compactionSummary ?? null,
      sentConfig: row.sentConfigJson ? JSON.parse(row.sentConfigJson) : null,
      createdAt: row.createdAt,
    };
  }
}
