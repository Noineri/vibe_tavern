import { eq, and, desc, asc, lte, sql } from 'drizzle-orm';
import { chats, chatBranches, characters, messages, messageVariants, promptTraces } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

// ─── Return types ─────────────────────────────────────────────────────────────

/**
 * Store-level Chat — domain Chat projected from a DB row.
 * Uses plain `string` IDs (brands are applied at the API boundary).
 * Includes DB-specific denormalized fields (summary, loreActivationState, scriptState, etc.).
 */
export interface Chat {
  id: string;
  characterId: string;
  personaId: string | null;
  title: string;
  summary: string;
  messageHistoryLimit: number;
  autoSummaryConfig: Record<string, unknown>;
  status: 'active' | 'archived';
  selectedGreetingIndex: number;
  activeBranchId: string;
  promptPresetId: string;
  lastAccessedAt: string;
  loreActivationState: Record<string, unknown>;
  scriptState: Record<string, Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Store-level ChatBranch — domain ChatBranch projected from a DB row.
 */
export interface ChatBranch {
  id: string;
  chatId: string;
  parentBranchId: string | null;
  forkedFromMessageId: string | null;
  label: string;
  createdAt: string;
}

/**
 * Store-level Message — domain Message projected from a DB row.
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
  createdAt: string;
}

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
}

// ─── Input types ──────────────────────────────────────────────────────────────

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
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class ChatStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  // ─── Chat lifecycle ────────────────────────────────────────────────────────

  async createChat(data: {
    characterId: string;
    personaId?: string;
    title: string;
    promptPresetId: string;
  }): Promise<Chat> {
    const chatId = this.idGen.next('chat');
    const branchId = this.idGen.next('brnch');
    const now = this.clock.now();

    await this.db.transaction(async (tx) => {
      await tx
        .insert(chats)
        .values({
          id: chatId,
          characterId: data.characterId,
          personaId: data.personaId ?? null,
          activeBranchId: branchId,
          promptPresetId: data.promptPresetId,
          title: data.title,
          summary: '',
          messageHistoryLimit: 0,
          autoSummaryConfigJson: '{"enabled":false,"everyN":20,"useChatModel":true}',
          status: 'active',
          lastAccessedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      await tx
        .insert(chatBranches)
        .values({
          id: branchId,
          chatId,
          parentBranchId: null,
          forkedFromMessageId: null,
          label: data.title,
          createdAt: now,
        })
        .run();
    });

    return (await this.getById(chatId))!;
  }

  async getById(id: string): Promise<Chat | null> {
    const row = await this.db.select().from(chats).where(eq(chats.id, id)).get();
    return row ? this.mapRow(row) : null;
  }

  async listByCharacter(characterId: string): Promise<Chat[]> {
    const rows = await this.db
      .select()
      .from(chats)
      .where(eq(chats.characterId, characterId))
      .all();
    return rows.map((row) => this.mapRow(row));
  }

  async listAll(): Promise<Chat[]> {
    const rows = await this.db.select().from(chats).orderBy(desc(chats.updatedAt)).all();
    return rows.map((row) => this.mapRow(row));
  }

  async touchLastAccessed(id: string): Promise<void> {
    const now = this.clock.now();
    await this.db
      .update(chats)
      .set({ lastAccessedAt: now })
      .where(eq(chats.id, id))
      .run();
  }

  async updateTitle(id: string, title: string): Promise<Chat> {
    const now = this.clock.now();
    const [row] = await this.db
      .update(chats)
      .set({ title, updatedAt: now })
      .where(eq(chats.id, id))
      .returning();
    if (!row) throw new Error(`Chat '${id}' not found after title update`);
    return this.mapRow(row);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(chats).where(eq(chats.id, id)).run();
  }

  async archive(id: string): Promise<Chat> {
    const now = this.clock.now();
    const [row] = await this.db
      .update(chats)
      .set({ status: 'archived', updatedAt: now })
      .where(eq(chats.id, id))
      .returning();
    if (!row) throw new Error(`Chat '${id}' not found after archive`);
    return this.mapRow(row);
  }

  async unarchive(id: string): Promise<Chat> {
    const now = this.clock.now();
    const [row] = await this.db
      .update(chats)
      .set({ status: 'active', updatedAt: now })
      .where(eq(chats.id, id))
      .returning();
    if (!row) throw new Error(`Chat '${id}' not found after unarchive`);
    return this.mapRow(row);
  }

  async updateSummary(id: string, summary: string): Promise<Chat> {
    const now = this.clock.now();
    const [row] = await this.db
      .update(chats)
      .set({ summary, updatedAt: now })
      .where(eq(chats.id, id))
      .returning();
    if (!row) throw new Error(`Chat '${id}' not found after summary update`);
    return this.mapRow(row);
  }

  async setMessageHistoryLimit(id: string, limit: number): Promise<Chat> {
    const now = this.clock.now();
    const [row] = await this.db
      .update(chats)
      .set({ messageHistoryLimit: limit, updatedAt: now })
      .where(eq(chats.id, id))
      .returning();
    if (!row) throw new Error(`Chat '${id}' not found after limit update`);
    return this.mapRow(row);
  }

  async updateMemorySettings(id: string, input: { messageHistoryLimit?: number; autoSummaryConfig?: Record<string, unknown> }): Promise<Chat> {
    const now = this.clock.now();
    const values: Partial<typeof chats.$inferInsert> = { updatedAt: now };
    if (input.messageHistoryLimit !== undefined) values.messageHistoryLimit = Math.max(0, Math.floor(input.messageHistoryLimit));
    if (input.autoSummaryConfig !== undefined) values.autoSummaryConfigJson = JSON.stringify(input.autoSummaryConfig);
    const [row] = await this.db
      .update(chats)
      .set(values)
      .where(eq(chats.id, id))
      .returning();
    if (!row) throw new Error(`Chat '${id}' not found after memory settings update`);
    return this.mapRow(row);
  }

  async setPersona(id: string, personaId: string | null): Promise<Chat> {
    const now = this.clock.now();
    const [row] = await this.db
      .update(chats)
      .set({ personaId, updatedAt: now })
      .where(eq(chats.id, id))
      .returning();
    if (!row) throw new Error(`Chat '${id}' not found after persona update`);
    return this.mapRow(row);
  }

  async setPromptPreset(id: string, promptPresetId: string): Promise<Chat> {
    const now = this.clock.now();
    const [row] = await this.db
      .update(chats)
      .set({ promptPresetId, updatedAt: now })
      .where(eq(chats.id, id))
      .returning();
    if (!row) throw new Error(`Chat '${id}' not found after prompt preset update`);
    return this.mapRow(row);
  }

  async setSelectedGreetingIndex(id: string, index: number): Promise<Chat> {
    const now = this.clock.now();
    const [row] = await this.db
      .update(chats)
      .set({ selectedGreetingIndex: index, updatedAt: now })
      .where(eq(chats.id, id))
      .returning();
    if (!row) throw new Error(`Chat '${id}' not found after greeting index update`);
    return this.mapRow(row);
  }

  // ─── Branches ──────────────────────────────────────────────────────────────

  async getBranches(chatId: string): Promise<ChatBranch[]> {
    const rows = await this.db
      .select()
      .from(chatBranches)
      .where(eq(chatBranches.chatId, chatId))
      .all();
    return rows.map((row) => this.mapRowBranch(row));
  }

  async getActiveBranch(chatId: string): Promise<ChatBranch | null> {
    const chat = await this.getById(chatId);
    if (!chat) return null;

    const row = await this.db
      .select()
      .from(chatBranches)
      .where(eq(chatBranches.id, chat.activeBranchId))
      .get();
    return row ? this.mapRowBranch(row) : null;
  }

  async activateBranch(chatId: string, branchId: string): Promise<Chat> {
    const now = this.clock.now();
    const [row] = await this.db
      .update(chats)
      .set({ activeBranchId: branchId, updatedAt: now })
      .where(eq(chats.id, chatId))
      .returning();
    if (!row) throw new Error(`Chat '${chatId}' not found after branch activation`);
    return this.mapRow(row);
  }

  async forkBranch(chatId: string, fromMessageId: string, label?: string): Promise<ChatBranch> {
    const sourceMsg = await this.db.select().from(messages)
      .where(eq(messages.id, fromMessageId)).get();
    if (!sourceMsg) throw new Error(`Message ${fromMessageId} not found`);

    const existingBranches = await this.db.select().from(chatBranches)
      .where(eq(chatBranches.chatId, chatId)).all();
    const forkLabel = label ?? `Fork ${existingBranches.length}`;
    const branchId = this.idGen.next('brnch');
    const now = this.clock.now();

    // forkBranch copies messages AND their messageVariants into the new branch
    await this.db.transaction(async (tx) => {
      await tx.insert(chatBranches).values({
        id: branchId, chatId, parentBranchId: sourceMsg.branchId,
        forkedFromMessageId: fromMessageId, label: forkLabel, createdAt: now,
      }).run();

      const msgsToCopy = await tx.select().from(messages)
        .where(and(eq(messages.branchId, sourceMsg.branchId), lte(messages.position, sourceMsg.position)))
        .orderBy(asc(messages.position)).all();

      // Batch: collect all new messages and variants, then insert in two bulk queries
      const newMessages: typeof messages.$inferInsert[] = [];
      const newVariants: typeof messageVariants.$inferInsert[] = [];

      for (const msg of msgsToCopy) {
        const newMsgId = this.idGen.next('msg');
        newMessages.push({
          id: newMsgId, chatId, branchId, role: msg.role, authorType: msg.authorType,
          position: msg.position, content: msg.content, state: msg.state,
          createdAt: now, updatedAt: now,
        });
        const variants = await tx.select().from(messageVariants)
          .where(eq(messageVariants.messageId, msg.id)).all();
        for (const v of variants) {
          newVariants.push({
            id: this.idGen.next('mvar'), messageId: newMsgId, variantIndex: v.variantIndex,
            content: v.content, isSelected: v.isSelected, finishReason: v.finishReason,
            reasoning: v.reasoning, reasoningDurationMs: v.reasoningDurationMs, createdAt: now,
          });
        }
      }

      if (newMessages.length > 0) {
        await tx.insert(messages).values(newMessages).run();
      }
      if (newVariants.length > 0) {
        await tx.insert(messageVariants).values(newVariants).run();
      }
    });

    const row = await this.db.select().from(chatBranches).where(eq(chatBranches.id, branchId)).get();
    return this.mapRowBranch(row!);
  }

  async renameBranch(branchId: string, label: string): Promise<ChatBranch> {
    const [row] = await this.db
      .update(chatBranches)
      .set({ label })
      .where(eq(chatBranches.id, branchId))
      .returning();
    if (!row) throw new Error(`Branch '${branchId}' not found after rename`);
    return this.mapRowBranch(row);
  }

  async deleteBranch(branchId: string): Promise<void> {
    // Get the branch to find its chatId
    const branch = await this.db
      .select()
      .from(chatBranches)
      .where(eq(chatBranches.id, branchId))
      .get();
    if (!branch) return;

    // Cannot delete the last branch of a chat
    const countRow = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(chatBranches)
      .where(eq(chatBranches.chatId, branch.chatId))
      .get();

    if (countRow && countRow.count <= 1) {
      throw new Error('Cannot delete the last branch');
    }

    const chat = await this.db.select().from(chats).where(eq(chats.id, branch.chatId)).get();

    await this.db.transaction(async (tx) => {
      await tx.delete(chatBranches).where(eq(chatBranches.id, branchId)).run();

      // If the deleted branch was the active one, reassign to the root branch
      // (or any remaining branch if root was somehow deleted)
      if (chat && chat.activeBranchId === branchId) {
        const remaining = await tx
          .select()
          .from(chatBranches)
          .where(eq(chatBranches.chatId, branch.chatId))
          .all();
        const fallback = remaining.find((b) => b.parentBranchId === null) ?? remaining[0];
        if (fallback) {
          const now = this.clock.now();
          await tx
            .update(chats)
            .set({ activeBranchId: fallback.id, updatedAt: now })
            .where(eq(chats.id, branch.chatId))
            .run();
        }
      }
    });
  }

  // ─── Messages ──────────────────────────────────────────────────────────────

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
    variants?: string[];
    selectedVariantIndex?: number;
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
      }).run();
      await tx.insert(messageVariants).values(variantContents.map((content, variantIndex) => ({
        id: this.idGen.next('mvar'), messageId: id, variantIndex,
        content, isSelected: variantIndex === selectedVariantIndex ? 1 : 0, finishReason: null,
        reasoning: variantIndex === selectedVariantIndex ? data.reasoning ?? null : null,
        reasoningDurationMs: variantIndex === selectedVariantIndex ? data.reasoningDurationMs ?? null : null,
        modelId: variantIndex === selectedVariantIndex ? data.modelId ?? null : null,
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

  async editMessage(id: string, content: string): Promise<Message> {
    const now = this.clock.now();

    await this.db.transaction(async (tx) => {
      await tx
        .update(messages)
        .set({ content, state: 'edited', updatedAt: now })
        .where(eq(messages.id, id))
        .run();

      // Also update the selected variant
      await tx
        .update(messageVariants)
        .set({ content })
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
    // Get all variants for this message
    const allVariants = await this.db
      .select()
      .from(messageVariants)
      .where(eq(messageVariants.messageId, messageId))
      .all();

    // Cannot delete the only variant
    if (allVariants.length <= 1) return;

    // Find the variant to delete
    const target = allVariants.find((v) => v.variantIndex === variantIndex);
    if (!target) return;

    const wasSelected = target.isSelected === 1;

    await this.db
      .delete(messageVariants)
      .where(
        and(
          eq(messageVariants.messageId, messageId),
          eq(messageVariants.variantIndex, variantIndex),
        ),
      )
      .run();

    // If the deleted variant was selected, select another one
    if (wasSelected) {
      const previousIndex = variantIndex > 0 ? variantIndex - 1 : 0;
      // Try to select the previous variant, or the first available
      const remaining = await this.db
        .select()
        .from(messageVariants)
        .where(eq(messageVariants.messageId, messageId))
        .orderBy(asc(messageVariants.variantIndex))
        .all();

      // Find the best candidate: previous index if it exists, otherwise first
      const candidate =
        remaining.find((v) => v.variantIndex === previousIndex) ?? remaining[0];

      if (candidate) {
        await this.selectVariant(messageId, candidate.variantIndex);
      }
    }
  }

  /**
   * One-time compatibility migration for the old greeting model.
   *
   * Previously, chats stored alternate greetings only as character-level strings
   * plus chats.selectedGreetingIndex. The first assistant message had only the
   * main greeting as a real DB variant. This backfills card alternate greetings
   * as chat-local variants on every branch's first assistant message. If the
   * legacy selected greeting was an alternate and the DB content differs from the
   * card's first_mes, copy that content into the selected alternate too — that
   * preserves edits made through the formerly broken alt-greeting edit flow.
   */
  async migrateGreetingVariants(): Promise<number> {
    const chatRows = await this.db
      .select({
        id: chats.id,
        selectedGreetingIndex: chats.selectedGreetingIndex,
        firstMessage: characters.firstMessage,
        alternateGreetingsJson: characters.alternateGreetingsJson,
      })
      .from(chats)
      .innerJoin(characters, eq(chats.characterId, characters.id))
      .all();

    let migrated = 0;
    const parseAlternates = (json: string): string[] => {
      try {
        const parsed = JSON.parse(json || '[]') as unknown;
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
      } catch {
        return [];
      }
    };

    for (const chat of chatRows) {
      const alternates = parseAlternates(chat.alternateGreetingsJson);
      if (alternates.length === 0 && chat.selectedGreetingIndex <= 0) continue;

      const branches = await this.db
        .select({ id: chatBranches.id })
        .from(chatBranches)
        .where(eq(chatBranches.chatId, chat.id))
        .all();

      for (const branch of branches) {
        const firstAssistant = await this.db
          .select()
          .from(messages)
          .where(and(eq(messages.branchId, branch.id), eq(messages.role, 'assistant')))
          .orderBy(asc(messages.position))
          .limit(1)
          .get();
        if (!firstAssistant) continue;

        const existing = await this.db
          .select()
          .from(messageVariants)
          .where(eq(messageVariants.messageId, firstAssistant.id))
          .orderBy(asc(messageVariants.variantIndex))
          .all();

        let changed = false;
        await this.db.transaction(async (tx) => {
          let currentVariants = existing;

          if (currentVariants.length === 0) {
            await tx.insert(messageVariants).values({
              id: this.idGen.next('mvar'),
              messageId: firstAssistant.id,
              variantIndex: 0,
              content: firstAssistant.content,
              isSelected: 1,
              finishReason: null,
              reasoning: null,
              reasoningDurationMs: null,
              modelId: null,
              createdAt: this.clock.now(),
            }).run();
            currentVariants = [{
              id: '',
              messageId: firstAssistant.id,
              variantIndex: 0,
              content: firstAssistant.content,
              isSelected: 1,
              finishReason: null,
              reasoning: null,
              reasoningDurationMs: null,
              modelId: null,
              createdAt: this.clock.now(),
            }];
            changed = true;
          }

          if (currentVariants.length === 1 && alternates.length > 0) {
            const now = this.clock.now();
            const legacySelectedAlternateIndex = chat.selectedGreetingIndex - 1;
            const currentLooksLikeEditedSelectedGreeting =
              chat.selectedGreetingIndex > 0 &&
              (!chat.firstMessage || firstAssistant.content !== chat.firstMessage);
            const migratedAlternates = alternates.map((content, index) =>
              currentLooksLikeEditedSelectedGreeting && index === legacySelectedAlternateIndex
                ? firstAssistant.content
                : content,
            );

            await tx.insert(messageVariants).values(migratedAlternates.map((content, index) => ({
              id: this.idGen.next('mvar'),
              messageId: firstAssistant.id,
              variantIndex: index + 1,
              content,
              isSelected: 0,
              finishReason: null,
              reasoning: null,
              reasoningDurationMs: null,
              modelId: null,
              createdAt: now,
            }))).run();
            currentVariants = [
              currentVariants[0],
              ...migratedAlternates.map((content, index) => ({
                id: '',
                messageId: firstAssistant.id,
                variantIndex: index + 1,
                content,
                isSelected: 0,
                finishReason: null,
                reasoning: null,
                reasoningDurationMs: null,
                modelId: null,
                createdAt: now,
              })),
            ];
            changed = true;
          }

          if (chat.selectedGreetingIndex > 0) {
            const target = currentVariants.find((variant) => variant.variantIndex === chat.selectedGreetingIndex);
            if (target) {
              await tx.update(messageVariants).set({ isSelected: 0 })
                .where(eq(messageVariants.messageId, firstAssistant.id)).run();
              await tx.update(messageVariants).set({ isSelected: 1 })
                .where(and(
                  eq(messageVariants.messageId, firstAssistant.id),
                  eq(messageVariants.variantIndex, chat.selectedGreetingIndex),
                )).run();
              await tx.update(messages).set({ content: target.content, updatedAt: this.clock.now() })
                .where(eq(messages.id, firstAssistant.id)).run();
              changed = true;
            }
          }
        });

        if (changed) migrated++;
      }

      // Convert the legacy chat-level selector into message-level selected variants once.
      // Leaving it non-zero would re-apply stale card-level selection on every startup
      // and could overwrite later chat-local greeting switches.
      if (chat.selectedGreetingIndex > 0) {
        await this.db.update(chats)
          .set({ selectedGreetingIndex: 0 })
          .where(eq(chats.id, chat.id))
          .run();
      }
    }

    if (migrated > 0) {
      console.log(`[greeting-migration] Backfilled greeting variants for ${migrated} first assistant message(s).`);
    }
    return migrated;
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

  // ─── Lore/Script state persistence ───────────────────────────────────────

  async updateLoreActivationState(chatId: string, state: Record<string, unknown>): Promise<void> {
    await this.db
      .update(chats)
      .set({ loreActivationStateJson: JSON.stringify(state) })
      .where(eq(chats.id, chatId))
      .run();
  }

  async updateScriptState(chatId: string, state: Record<string, Record<string, unknown>>): Promise<void> {
    await this.db
      .update(chats)
      .set({ scriptStateJson: JSON.stringify(state) })
      .where(eq(chats.id, chatId))
      .run();
  }

  // ─── Row mappers ──────────────────────────────────────────────────────────

  // ─── mapRow helpers ──────────────────────────────────────────────────────────

  private mapRow(row: typeof chats.$inferSelect): Chat {
    return {
      id: row.id,
      characterId: row.characterId,
      personaId: row.personaId,
      title: row.title,
      summary: row.summary,
      messageHistoryLimit: row.messageHistoryLimit,
      autoSummaryConfig: safeParseJson(row.autoSummaryConfigJson),
      status: row.status as Chat['status'],
      selectedGreetingIndex: row.selectedGreetingIndex,
      activeBranchId: row.activeBranchId,
      promptPresetId: row.promptPresetId,
      lastAccessedAt: row.lastAccessedAt,
      loreActivationState: safeParseJson(row.loreActivationStateJson),
      scriptState: safeParseScriptState(row.scriptStateJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapRowBranch(row: typeof chatBranches.$inferSelect): ChatBranch {
    return {
      id: row.id,
      chatId: row.chatId,
      parentBranchId: row.parentBranchId,
      forkedFromMessageId: row.forkedFromMessageId,
      label: row.label,
      createdAt: row.createdAt,
    };
  }

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
      createdAt: row.createdAt,
    };
  }

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
      createdAt: row.createdAt,
    };
  }
}

function safeParseJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

function safeParseScriptState(text: string): Record<string, Record<string, unknown>> {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}
