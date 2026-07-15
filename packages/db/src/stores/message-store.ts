import { eq, and, desc, asc, inArray } from 'drizzle-orm';
import { messages, messageVariants, sceneBackfillRuns } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';
import { extractThinkingTags } from '@vibe-tavern/domain';

// ─── Return types ─────────────────────────────────────────────────────────────

/**
 * Store-level Message — domain Message projected from a DB row.
 * Uses plain `string` IDs (brands are applied at the API boundary).
 */
export interface Message {
  id: string;
  chatId: string;
  branchId: string;
  role: string;
  authorType: string;
  position: number;
  content: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  attachmentsJson?: string | null;
  toolCalls?: Array<{ id: string; name: string; args: unknown; providerOptions?: unknown }> | null;
  toolCallId?: string | null;
}

/**
 * Store-level MessageVariant — domain MessageVariant projected from a DB row.
 */
export interface MessageVariant {
  id: string;
  messageId: string;
  variantIndex: number;
  content: string;
  isSelected: boolean;
  finishReason: string | null;
  reasoning: string | null;
  reasoningDurationMs: number | null;
  modelId: string | null;
  presetId: string | null;
  createdAt: string;
  coauthorModuleId?: string | null;
  coauthorSkillId?: string | null;
  toolCalls?: Array<{ id: string; name: string; args: unknown; providerOptions?: unknown }> | null;
  toolCallId?: string | null;
  /** Canonical per-variant Scene record; null when the variant has none yet
   *  (just created, or cleared on content edit). Owned by this variant's
   *  immutable id. Parsed from scene_tracker_json at this boundary. */
  sceneTracker: MessageVariantSceneRecord | null;
}

/**
 * Store-level Scene record — the plain-string mirror of the domain
 * SceneTrackerRecord. Brands are applied at the API boundary (like Message /
 * MessageVariant ids). One record per immutable variant, stored as JSON in
 * message_variants.scene_tracker_json.
 */
export interface MessageVariantSceneRecord {
  /** The immutable variant this record was generated for (ownership identity). */
  variantId: string;
  /** The config schemaHash captured at generation time. */
  schemaHash: string;
  /** The config revision captured at generation time. */
  configRevision: number;
  /** Hash of the variant source content captured at generation time. */
  sourceHash: string;
  /** The validated scene state, matching the then-current schema. */
  sceneState: Record<string, unknown>;
  /** The model that produced this record (for trace). */
  modelId: string | null;
  generatedAt: string;
}

/**
 * The active branch's latest assistant message + its selected variant's raw
 * Scene record — the source for the derived current-Scene cache (SCN-6).
 * Null when the branch has no assistant message, the latest assistant has no
 * selected variant, or that variant has no record. See {@link MessageStore.getCurrentSceneTarget}.
 */
export interface CurrentSceneTarget {
  messageId: string;
  variantId: string;
  record: MessageVariantSceneRecord;
}

/**
 * Store-level Scene backfill run — durable job state for history backfill
 * (SCENE_TRACKER_PLAN Wave 7). Tracks the JOB only (ownership / frozen
 * manifest / cursor / status / per-item errors / cancel / summary); it is
 * NEVER authoritative for Scene data, which lives on message_variants.
 */
export interface SceneBackfillRun {
  id: string;
  chatId: string;
  mode: string;
  status: string;
  manifestJson: string;
  totalItems: number;
  cursor: number;
  errorsJson: string;
  cancelRequested: boolean;
  summaryJson: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Message + variant (swipe) CRUD.
 *
 * Extracted from ChatStore (CHAT_STORE_SPLIT_PLAN.md, Wave A, 2026-06-20).
 * Method bodies, signatures, and return types are preserved verbatim — this
 * is a move, not a rewrite. Consumers reach this via `stores.messages.*`
 * through the StoreContainer facade.
 */
export class MessageStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  // ─── Messages ──────────────────────────────────────────────────────────────

  async getMessageById(id: string): Promise<Message | null> {
    const row = await this.db
      .select()
      .from(messages)
      .where(eq(messages.id, id))
      .get();
    return row ? this.mapRowMessage(row) : null;
  }

  async getMessages(branchId: string): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.branchId, branchId))
      .orderBy(asc(messages.position))
      .all();
    return rows.map((row) => this.mapRowMessage(row));
  }

  async addMessage(data: {
    chatId: string; branchId: string; role: string; authorType: string; content: string;
    reasoning?: string; reasoningDurationMs?: number;
    modelId?: string | null;
    /** Prompt preset used for THIS message. Recorded on the selected variant
     *  (the field the message footer reads) so every reply — send, continue,
     *  regenerate, queue — carries its preset, not only the queue/variant path. */
    presetId?: string | null;
    variants?: string[];
    selectedVariantIndex?: number;
    attachmentsJson?: string | null;
    toolCallsJson?: string | null;
    toolCallId?: string | null;
    coauthorModuleId?: string | null;
    coauthorSkillId?: string | null;
  }): Promise<Message> {
    const id = this.idGen.next('msg');
    const now = this.clock.now();
    const lastMsg = await this.db.select({ position: messages.position }).from(messages)
      .where(eq(messages.branchId, data.branchId))
      .orderBy(desc(messages.position)).limit(1).get();
    const nextPosition = (lastMsg?.position ?? -1) + 1;

    const variantContents = data.variants?.length ? data.variants : [data.content];
    const selectedVariantIndex = Math.min(
      Math.max(data.selectedVariantIndex ?? 0, 0),
      variantContents.length - 1,
    );
    const selectedContent = variantContents[selectedVariantIndex] ?? data.content;

    await this.db.transaction(async (tx) => {
      await tx.insert(messages).values({
        id, chatId: data.chatId, branchId: data.branchId,
        role: data.role, authorType: data.authorType,
        position: nextPosition, content: selectedContent,
        state: 'complete', createdAt: now, updatedAt: now,
        attachmentsJson: data.attachmentsJson ?? null,
        toolCallsJson: data.toolCallsJson ?? null,
        toolCallId: data.toolCallId ?? null,
      }).run();
      await tx.insert(messageVariants).values(variantContents.map((content, variantIndex) => ({
        id: this.idGen.next('mvar'), messageId: id, variantIndex,
        content, isSelected: variantIndex === selectedVariantIndex ? 1 : 0, finishReason: null,
        reasoning: variantIndex === selectedVariantIndex ? data.reasoning ?? null : null,
        reasoningDurationMs: variantIndex === selectedVariantIndex ? data.reasoningDurationMs ?? null : null,
        modelId: variantIndex === selectedVariantIndex ? data.modelId ?? null : null,
        presetId: variantIndex === selectedVariantIndex ? data.presetId ?? null : null,
        toolCallsJson: variantIndex === selectedVariantIndex ? data.toolCallsJson ?? null : null,
        toolCallId: variantIndex === selectedVariantIndex ? data.toolCallId ?? null : null,
        coauthorModuleId: variantIndex === selectedVariantIndex ? data.coauthorModuleId ?? null : null,
        coauthorSkillId: variantIndex === selectedVariantIndex ? data.coauthorSkillId ?? null : null,
        createdAt: now,
      }))).run();
    });

    // SELECT outside tx is fine — row is committed
    const row = await this.db.select().from(messages).where(eq(messages.id, id)).get();
    return this.mapRowMessage(row!);
  }

  /**
   * Bulk-insert many messages (each with its own variants) in a SINGLE
   * transaction. Purpose: chat import — collapses O(N) per-message transactions
   * (each its own fsync) into O(1) per batch. For a 600-message chat this turns
   * ~1800 statements across ~1800 implicit transactions into ~1800 statements
   * across ONE transaction (one fsync).
   *
   * Position is assigned sequentially per branchId, starting from the current
   * max+1 (queried ONCE per branch, not per message). messages.content is set
   * to the selected variant's content for read consistency, exactly as the
   * single-message addMessage + selectVariant path does.
   *
   * The selected variant per message = the one with isSelected=true, else
   * index 0. Per-variant reasoning is preserved (used by ST import, which
   * extracts <thinking> tags into variant.reasoning).
   *
   * Insert statements are chunked INSIDE the transaction to respect the SQLite
   * host-parameter limit (32766 on modern builds, 999 on old ones). Chunking
   * only splits individual INSERT statements — the transaction boundary (and
   * thus the single fsync) is unaffected.
   *
   * Not surfaced: streaming state (all 'complete'), attachments/toolCalls/coauthor
   * (import has none). Extend the item shape if a future importer needs them —
   * do not regress to per-message addMessage calls.
   */
  async addMessagesBatch(items: {
    chatId: string;
    branchId: string;
    role: string;
    authorType: string;
    variants: { content: string; reasoning?: string; isSelected?: boolean }[];
  }[]): Promise<void> {
    if (items.length === 0) return;
    const now = this.clock.now();

    // Group by branch so position stays sequential within each branch.
    const byBranch = new Map<string, typeof items>();
    for (const item of items) {
      const arr = byBranch.get(item.branchId);
      if (arr) arr.push(item);
      else byBranch.set(item.branchId, [item]);
    }

    const messageRows: (typeof messages.$inferInsert)[] = [];
    const variantRows: (typeof messageVariants.$inferInsert)[] = [];

    for (const [branchId, branchItems] of byBranch) {
      const lastMsg = await this.db.select({ position: messages.position }).from(messages)
        .where(eq(messages.branchId, branchId))
        .orderBy(desc(messages.position)).limit(1).get();
      let position = (lastMsg?.position ?? -1) + 1;

      for (const item of branchItems) {
        const msgId = this.idGen.next('msg');
        const variants = item.variants.length > 0
          ? item.variants
          : [{ content: '', isSelected: true }];
        let selectedIndex = variants.findIndex((v) => v.isSelected);
        if (selectedIndex < 0) selectedIndex = 0;
        const selectedContent = variants[selectedIndex]!.content;

        messageRows.push({
          id: msgId,
          chatId: item.chatId,
          branchId,
          role: item.role,
          authorType: item.authorType,
          position: position++,
          content: selectedContent,
          state: 'complete',
          attachmentsJson: null,
          toolCallsJson: null,
          toolCallId: null,
          createdAt: now,
          updatedAt: now,
        });

        for (let vi = 0; vi < variants.length; vi++) {
          const v = variants[vi]!;
          variantRows.push({
            id: this.idGen.next('mvar'),
            messageId: msgId,
            variantIndex: vi,
            content: v.content,
            isSelected: vi === selectedIndex ? 1 : 0,
            finishReason: null,
            reasoning: v.reasoning ?? null,
            reasoningDurationMs: null,
            modelId: null,
            presetId: null,
            toolCallsJson: null,
            toolCallId: null,
            coauthorModuleId: null,
            coauthorSkillId: null,
            createdAt: now,
          });
        }
      }
    }

    await this.db.transaction(async (tx) => {
      // Chunk to respect SQLite's host-parameter limit. messages has 12 cols
      // (chunk at 80 → 960 params, safe even for the legacy 999 limit),
      // messageVariants has 16 cols (chunk at 60 → 960 params).
      for (let i = 0; i < messageRows.length; i += 80) {
        await tx.insert(messages).values(messageRows.slice(i, i + 80)).run();
      }
      for (let i = 0; i < variantRows.length; i += 60) {
        await tx.insert(messageVariants).values(variantRows.slice(i, i + 60)).run();
      }
    });
  }

  async addStreamingMessage(data: {
    chatId: string;
    branchId: string;
    role: string;
    authorType: string;
  }): Promise<Message> {
    const id = this.idGen.next('msg');
    const now = this.clock.now();

    // Auto-increment position
    const lastMsg = await this.db
      .select({ position: messages.position })
      .from(messages)
      .where(eq(messages.branchId, data.branchId))
      .orderBy(desc(messages.position))
      .limit(1)
      .get();
    const nextPosition = (lastMsg?.position ?? -1) + 1;

    const [row] = await this.db
      .insert(messages)
      .values({
        id,
        chatId: data.chatId,
        branchId: data.branchId,
        role: data.role,
        authorType: data.authorType,
        position: nextPosition,
        content: '',
        state: 'streaming',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // Do NOT create a variant yet — variant is created when streaming completes
    return this.mapRowMessage(row!);
  }

  async completeStreamingMessage(id: string, content: string, reasoning?: string, reasoningDurationMs?: number): Promise<Message> {
    const now = this.clock.now();

    await this.db.transaction(async (tx) => {
      await tx
        .update(messages)
        .set({ content, state: 'complete', updatedAt: now })
        .where(eq(messages.id, id))
        .run();

      // Create initial variant if none exists
      const existingVariants = await tx
        .select()
        .from(messageVariants)
        .where(eq(messageVariants.messageId, id))
        .all();

      if (existingVariants.length === 0) {
        await tx
          .insert(messageVariants)
          .values({
            id: this.idGen.next('mvar'),
            messageId: id,
            variantIndex: 0,
            content,
            isSelected: 1,
            finishReason: null,
            reasoning: reasoning ?? null,
            reasoningDurationMs: reasoningDurationMs ?? null,
            createdAt: now,
          })
          .run();
      }
    });

    const row = await this.db.select().from(messages).where(eq(messages.id, id)).get();
    return this.mapRowMessage(row!);
  }

  async updateMessageAttachments(id: string, attachmentsJson: string | null): Promise<void> {
    const now = this.clock.now();
    await this.db
      .update(messages)
      .set({ attachmentsJson, updatedAt: now })
      .where(eq(messages.id, id))
      .run();
  }

  async editMessage(id: string, content: string): Promise<Message> {
    const now = this.clock.now();

    // Extract thinking tags from edited content
    const { mainContent, reasoning: extractedReasoning } = extractThinkingTags(content);

    await this.db.transaction(async (tx) => {
      await tx
        .update(messages)
        .set({ content: mainContent, state: 'edited', updatedAt: now })
        .where(eq(messages.id, id))
        .run();

      // Also update the selected variant content + reasoning.
      // A content edit invalidates that variant's Scene record (its sourceHash
      // no longer matches the new content), so clear it in the same tx. Only the
      // edited variant is affected — sibling variants keep their own records.
      const variantUpdate: Record<string, unknown> = {
        content: mainContent,
        sceneTrackerJson: null,
      };
      if (extractedReasoning !== undefined) {
        variantUpdate.reasoning = extractedReasoning;
      }
      await tx
        .update(messageVariants)
        .set(variantUpdate)
        .where(
          and(eq(messageVariants.messageId, id), eq(messageVariants.isSelected, 1)),
        )
        .run();
    });

    const editRow = await this.db.select().from(messages).where(eq(messages.id, id)).get();
    return this.mapRowMessage(editRow!);
  }

  async deleteMessage(id: string): Promise<void> {
    await this.db.delete(messages).where(eq(messages.id, id)).run();
  }

  async getLastMessage(branchId: string): Promise<Message | null> {
    const row = await this.db
      .select()
      .from(messages)
      .where(eq(messages.branchId, branchId))
      .orderBy(desc(messages.position))
      .limit(1)
      .get();
    return row ? this.mapRowMessage(row) : null;
  }

  // ─── Variants (swipes) ────────────────────────────────────────────────────

  async addVariant(
    messageId: string,
    content: string,
    finishReason?: string,
    reasoning?: string,
    reasoningDurationMs?: number,
    modelId?: string | null,
    presetId?: string | null,
    toolCallsJson?: string | null,
    toolCallId?: string | null,
    coauthorModuleId?: string | null,
    coauthorSkillId?: string | null,
  ): Promise<MessageVariant> {
    // Find max variantIndex
    const lastVariant = await this.db
      .select({ variantIndex: messageVariants.variantIndex })
      .from(messageVariants)
      .where(eq(messageVariants.messageId, messageId))
      .orderBy(desc(messageVariants.variantIndex))
      .limit(1)
      .get();

    const nextIndex = (lastVariant?.variantIndex ?? -1) + 1;
    const id = this.idGen.next('mvar');
    const now = this.clock.now();

    // Transaction: deselect all existing variants, insert new as selected,
    // and sync messages.content so reads are consistent.
    await this.db.transaction(async (tx) => {
      await tx
        .update(messageVariants)
        .set({ isSelected: 0 })
        .where(eq(messageVariants.messageId, messageId))
        .run();

      await tx
        .insert(messageVariants)
        .values({
          id,
          messageId,
          variantIndex: nextIndex,
          content,
          isSelected: 1,
          finishReason: finishReason ?? null,
          reasoning: reasoning ?? null,
          reasoningDurationMs: reasoningDurationMs ?? null,
          modelId: modelId ?? null,
          presetId: presetId ?? null,
          toolCallsJson: toolCallsJson ?? null,
          toolCallId: toolCallId ?? null,
          coauthorModuleId: coauthorModuleId ?? null,
          coauthorSkillId: coauthorSkillId ?? null,
          createdAt: now,
        })
        .run();

      // Keep messages.content in sync with the active variant
      await tx
        .update(messages)
        .set({ content, updatedAt: now })
        .where(eq(messages.id, messageId))
        .run();
    });

    const row = await this.db
      .select()
      .from(messageVariants)
      .where(eq(messageVariants.id, id))
      .get();
    return this.mapRowVariant(row!);
  }

  async selectVariant(messageId: string, variantIndex: number): Promise<void> {
    const target = await this.db.select({ content: messageVariants.content })
      .from(messageVariants)
      .where(and(eq(messageVariants.messageId, messageId), eq(messageVariants.variantIndex, variantIndex)))
      .get();
    if (!target) return;

    await this.db.transaction(async (tx) => {
      // Clear all selections for this message
      await tx.update(messageVariants).set({ isSelected: 0 })
        .where(eq(messageVariants.messageId, messageId)).run();
      // Select target variant
      await tx.update(messageVariants).set({ isSelected: 1 })
        .where(and(eq(messageVariants.messageId, messageId), eq(messageVariants.variantIndex, variantIndex)))
        .run();
      // Sync messages.content with selected variant content (invariant)
      await tx.update(messages).set({ content: target.content, updatedAt: this.clock.now() })
        .where(eq(messages.id, messageId)).run();
    });
  }

  async getVariants(messageId: string): Promise<MessageVariant[]> {
    const rows = await this.db
      .select()
      .from(messageVariants)
      .where(eq(messageVariants.messageId, messageId))
      .orderBy(asc(messageVariants.variantIndex))
      .all();
    return rows.map((row) => this.mapRowVariant(row));
  }

  async getVariantsByBranch(branchId: string): Promise<Map<string, MessageVariant[]>> {
    const rows = await this.db
      .select()
      .from(messageVariants)
      .innerJoin(messages, eq(messageVariants.messageId, messages.id))
      .where(eq(messages.branchId, branchId))
      .orderBy(asc(messageVariants.messageId), asc(messageVariants.variantIndex))
      .all();
    const map = new Map<string, MessageVariant[]>();
    for (const row of rows) {
      const variant = this.mapRowVariant(row.message_variants);
      const list = map.get(row.message_variants.messageId);
      if (list) list.push(variant);
      else map.set(row.message_variants.messageId, [variant]);
    }
    return map;
  }

  async getSelectedVariant(messageId: string): Promise<MessageVariant | null> {
    const row = await this.db
      .select()
      .from(messageVariants)
      .where(
        and(
          eq(messageVariants.messageId, messageId),
          eq(messageVariants.isSelected, 1),
        ),
      )
      .get();
    return row ? this.mapRowVariant(row) : null;
  }

  async deleteVariant(messageId: string, variantIndex: number): Promise<void> {
    const allVariants = await this.db
      .select()
      .from(messageVariants)
      .where(eq(messageVariants.messageId, messageId))
      .orderBy(asc(messageVariants.variantIndex))
      .all();

    // Cannot delete the only variant.
    if (allVariants.length <= 1) return;

    const targetPosition = allVariants.findIndex((v) => v.variantIndex === variantIndex);
    const target = targetPosition >= 0 ? allVariants[targetPosition] : null;
    if (!target) return;

    const remaining = allVariants.filter((variant) => variant.id !== target.id);
    const selectedBeforeDelete = allVariants.find((variant) => variant.isSelected === 1) ?? null;
    const selectedAfterDelete =
      target.isSelected === 1
        ? remaining[Math.max(0, targetPosition - 1)] ?? remaining[0] ?? null
        : selectedBeforeDelete && selectedBeforeDelete.id !== target.id
          ? selectedBeforeDelete
          : remaining[0] ?? null;
    const now = this.clock.now();

    await this.db.transaction(async (tx) => {
      await tx
        .delete(messageVariants)
        .where(
          and(
            eq(messageVariants.messageId, messageId),
            eq(messageVariants.variantIndex, variantIndex),
          ),
        )
        .run();

      // Keep variant_index contiguous after deletion. The UI intentionally uses
      // variantIndex as the API selector; sparse indexes caused counters like
      // "6/5" and wrong swipes after a snapshot refresh.
      for (let nextIndex = 0; nextIndex < remaining.length; nextIndex++) {
        const variant = remaining[nextIndex];
        await tx
          .update(messageVariants)
          .set({
            variantIndex: nextIndex,
            isSelected: selectedAfterDelete?.id === variant.id ? 1 : 0,
          })
          .where(eq(messageVariants.id, variant.id))
          .run();
      }

      if (selectedAfterDelete) {
        await tx
          .update(messages)
          .set({ content: selectedAfterDelete.content, updatedAt: now })
          .where(eq(messages.id, messageId))
          .run();
      }
    });
  }

  // ─── Scene records (per immutable variant) ────────────────────────────────
  // Scene data is owned by the immutable variant id, never by variantIndex.
  // variantIndex is display order only and is recompacted on deletion, so any
  // index-keyed Scene read would retarget the wrong record after a delete;
  // the id is stable for the variant's lifetime. (SCENE_TRACKER_PLAN, SCN-3.)

  async getSceneRecord(variantId: string): Promise<MessageVariantSceneRecord | null> {
    const row = await this.db.select({ sceneTrackerJson: messageVariants.sceneTrackerJson })
      .from(messageVariants)
      .where(eq(messageVariants.id, variantId))
      .get();
    return row?.sceneTrackerJson ? JSON.parse(row.sceneTrackerJson) : null;
  }

  async setSceneRecord(variantId: string, record: MessageVariantSceneRecord): Promise<void> {
    await this.db.update(messageVariants)
      .set({ sceneTrackerJson: JSON.stringify(record) })
      .where(eq(messageVariants.id, variantId))
      .run();
  }

  async clearSceneRecord(variantId: string): Promise<void> {
    await this.db.update(messageVariants)
      .set({ sceneTrackerJson: null })
      .where(eq(messageVariants.id, variantId))
      .run();
  }

  /**
   * The active branch's latest assistant message + its selected variant's raw
   * Scene record — the source for the derived current-Scene cache (SCN-6).
   * LATEST-assistant-only (no fallback): the cache mirrors the CURRENT
   * selection, so a not-yet-tracked latest reply yields null rather than a
   * stale earlier scene. The record is RAW — no freshness filter here; the
   * cache layer validates schemaHash/configRevision against the live config.
   */
  async getCurrentSceneTarget(branchId: string): Promise<CurrentSceneTarget | null> {
    const branchMessages = await this.getMessages(branchId);
    for (let index = branchMessages.length - 1; index >= 0; index -= 1) {
      const message = branchMessages[index];
      if (!message || message.role !== "assistant") continue;
      const selected = await this.getSelectedVariant(message.id);
      if (!selected) return null;
      const record = await this.getSceneRecord(selected.id);
      if (!record) return null;
      return { messageId: message.id, variantId: selected.id, record };
    }
    return null;
  }

  /**
   * The latest assistant message's currently SELECTED variant (record-agnostic),
   * for the Scene auto-start/wait path (SCENE_TRACKER_PLAN SCN-8). Unlike
   * {@link getCurrentSceneTarget} this returns the target even when the variant
   * has NO scene record yet — the common auto-generate case (a freshly committed
   * assistant reply is record-less until the background job lands). null only
   * when the branch has no assistant message with a selected variant.
   */
  async getLatestSelectedVariant(branchId: string): Promise<{ messageId: string; variantId: string } | null> {
    const branchMessages = await this.getMessages(branchId);
    for (let index = branchMessages.length - 1; index >= 0; index -= 1) {
      const message = branchMessages[index];
      if (!message || message.role !== "assistant") continue;
      const selected = await this.getSelectedVariant(message.id);
      if (!selected) continue;
      return { messageId: message.id, variantId: selected.id };
    }
    return null;
  }

  /**
   * Scene Tracker history for main-model injection (SCENE_TRACKER_PLAN SCN-7).
   * Walks the branch's assistant messages newest→oldest, up to `scanLimit`
   * assistants, and returns the RAW scene record of each one's currently
   * SELECTED variant (when it has one). Newest-first. The caller applies the
   * freshness filter (`isSceneRecordCurrent`) and takes the last `injectLastN`
   * valid entries — the store deliberately returns raw records so one freshness
   * rule governs both this path and the SCN-6 cache.
   */
  async getSelectedSceneHistory(branchId: string, scanLimit: number): Promise<CurrentSceneTarget[]> {
    const branchMessages = await this.getMessages(branchId);
    const out: CurrentSceneTarget[] = [];
    let scanned = 0;
    for (let index = branchMessages.length - 1; index >= 0 && scanned < scanLimit; index -= 1) {
      const message = branchMessages[index];
      if (!message || message.role !== "assistant") continue;
      scanned += 1;
      const selected = await this.getSelectedVariant(message.id);
      if (!selected) continue;
      const record = await this.getSceneRecord(selected.id);
      if (!record) continue;
      out.push({ messageId: message.id, variantId: selected.id, record });
    }
    return out;
  }

  // ─── Scene backfill runs (durable job state) ──────────────────────────────
  // Tracks the backfill JOB only; never authoritative for Scene data. The run
  // row lets Wave 7 resume/retry/report progress across reload and restart.

  async createSceneBackfillRun(input: {
    chatId: string;
    mode?: string;
    manifestJson: string;
    totalItems: number;
  }): Promise<SceneBackfillRun> {
    const id = this.idGen.next('sbr');
    const now = this.clock.now();
    await this.db.insert(sceneBackfillRuns).values({
      id,
      chatId: input.chatId,
      mode: input.mode ?? 'fill-missing',
      status: 'pending',
      manifestJson: input.manifestJson,
      totalItems: input.totalItems,
      cursor: 0,
      errorsJson: '[]',
      cancelRequested: 0,
      summaryJson: null,
      createdAt: now,
      updatedAt: now,
    }).run();
    const row = await this.db.select().from(sceneBackfillRuns)
      .where(eq(sceneBackfillRuns.id, id)).get();
    return this.mapRowBackfillRun(row!);
  }

  async getSceneBackfillRun(id: string): Promise<SceneBackfillRun | null> {
    const row = await this.db.select().from(sceneBackfillRuns)
      .where(eq(sceneBackfillRuns.id, id)).get();
    return row ? this.mapRowBackfillRun(row) : null;
  }

  /** The chat's most recent non-terminal (pending/running) backfill run, or null
   *  (SCN-14). Start uses this to reattach to an in-flight run instead of
   *  starting a duplicate; status uses it for reload reattachment. A run that
   *  crashed mid-flight is still 'running' here — the service detects stale
   *  'running' (no in-memory handle) and resumes it. */
  async getActiveSceneBackfillRun(chatId: string): Promise<SceneBackfillRun | null> {
    const row = await this.db.select().from(sceneBackfillRuns)
      .where(and(
        eq(sceneBackfillRuns.chatId, chatId),
        inArray(sceneBackfillRuns.status, ['pending', 'running']),
      ))
      .orderBy(desc(sceneBackfillRuns.createdAt))
      .limit(1).get();
    return row ? this.mapRowBackfillRun(row) : null;
  }

  async updateSceneBackfillRun(id: string, patch: {
    status?: string;
    cursor?: number;
    errorsJson?: string;
    cancelRequested?: boolean;
    summaryJson?: string | null;
  }): Promise<void> {
    const update: Record<string, unknown> = { updatedAt: this.clock.now() };
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.cursor !== undefined) update.cursor = patch.cursor;
    if (patch.errorsJson !== undefined) update.errorsJson = patch.errorsJson;
    if (patch.cancelRequested !== undefined) update.cancelRequested = patch.cancelRequested ? 1 : 0;
    if (patch.summaryJson !== undefined) update.summaryJson = patch.summaryJson;
    await this.db.update(sceneBackfillRuns).set(update)
      .where(eq(sceneBackfillRuns.id, id)).run();
  }

  // ─── Row mappers ──────────────────────────────────────────────────────────

  private mapRowMessage(row: typeof messages.$inferSelect): Message {
    return {
      id: row.id,
      chatId: row.chatId,
      branchId: row.branchId,
      role: row.role,
      authorType: row.authorType,
      position: row.position,
      content: row.content,
      state: row.state,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      attachmentsJson: row.attachmentsJson,
      toolCalls: row.toolCallsJson ? JSON.parse(row.toolCallsJson) : null,
      toolCallId: row.toolCallId,
    };
  }

  private mapRowVariant(row: typeof messageVariants.$inferSelect): MessageVariant {
    return {
      id: row.id,
      messageId: row.messageId,
      variantIndex: row.variantIndex,
      content: row.content,
      isSelected: row.isSelected === 1,
      finishReason: row.finishReason,
      reasoning: row.reasoning,
      reasoningDurationMs: row.reasoningDurationMs,
      modelId: row.modelId,
      presetId: row.presetId,
      coauthorModuleId: row.coauthorModuleId,
      coauthorSkillId: row.coauthorSkillId,
      toolCalls: row.toolCallsJson ? JSON.parse(row.toolCallsJson) : null,
      toolCallId: row.toolCallId,
      sceneTracker: row.sceneTrackerJson ? JSON.parse(row.sceneTrackerJson) : null,
      createdAt: row.createdAt,
    };
  }

  private mapRowBackfillRun(row: typeof sceneBackfillRuns.$inferSelect): SceneBackfillRun {
    return {
      id: row.id,
      chatId: row.chatId,
      mode: row.mode,
      status: row.status,
      manifestJson: row.manifestJson,
      totalItems: row.totalItems,
      cursor: row.cursor,
      errorsJson: row.errorsJson,
      cancelRequested: row.cancelRequested === 1,
      summaryJson: row.summaryJson,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
