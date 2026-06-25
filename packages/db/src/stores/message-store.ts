import { eq, and, desc, asc } from 'drizzle-orm';
import { messages, messageVariants } from '../db-schema.js';
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
      }).run();
      await tx.insert(messageVariants).values(variantContents.map((content, variantIndex) => ({
        id: this.idGen.next('mvar'), messageId: id, variantIndex,
        content, isSelected: variantIndex === selectedVariantIndex ? 1 : 0, finishReason: null,
        reasoning: variantIndex === selectedVariantIndex ? data.reasoning ?? null : null,
        reasoningDurationMs: variantIndex === selectedVariantIndex ? data.reasoningDurationMs ?? null : null,
        modelId: variantIndex === selectedVariantIndex ? data.modelId ?? null : null,
        presetId: variantIndex === selectedVariantIndex ? data.presetId ?? null : null,
        createdAt: now,
      }))).run();
    });

    // SELECT outside tx is fine — row is committed
    const row = await this.db.select().from(messages).where(eq(messages.id, id)).get();
    return this.mapRowMessage(row!);
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

      // Also update the selected variant content + reasoning
      const variantUpdate: Record<string, unknown> = { content: mainContent };
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
      createdAt: row.createdAt,
    };
  }
}
