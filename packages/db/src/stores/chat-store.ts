import { eq, and, desc, asc, lte, sql } from 'drizzle-orm';
import { chats, chatBranches, messages, messageVariants, promptTraces } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

// ─── Return types ─────────────────────────────────────────────────────────────

export interface Chat {
  id: string;
  characterId: string;
  personaId: string | null;
  title: string;
  summary: string;
  messageHistoryLimit: number;
  status: 'active' | 'archived';
  activeBranchId: string;
  promptPresetId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatBranch {
  id: string;
  chatId: string;
  parentBranchId: string | null;
  forkedFromMessageId: string | null;
  label: string;
  createdAt: string;
}

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

export interface MessageVariant {
  id: string;
  messageId: string;
  variantIndex: number;
  content: string;
  isSelected: boolean;
  finishReason: string | null;
  createdAt: string;
}

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
  latencyMs: number;
  createdAt: string;
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
  latencyMs: number;
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
          status: 'active',
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
    const rows = await this.db.select().from(chats).all();
    return rows.map((row) => this.mapRow(row));
  }

  async updateTitle(id: string, title: string): Promise<Chat> {
    const now = this.clock.now();
    await this.db
      .update(chats)
      .set({ title, updatedAt: now })
      .where(eq(chats.id, id))
      .run();

    const row = await this.db.select().from(chats).where(eq(chats.id, id)).get();
    if (!row) throw new Error(`Chat '${id}' not found after title update`);
    return this.mapRow(row);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(chats).where(eq(chats.id, id)).run();
  }

  async archive(id: string): Promise<Chat> {
    const now = this.clock.now();
    await this.db
      .update(chats)
      .set({ status: 'archived', updatedAt: now })
      .where(eq(chats.id, id))
      .run();

    const row = await this.db.select().from(chats).where(eq(chats.id, id)).get();
    if (!row) throw new Error(`Chat '${id}' not found after archive`);
    return this.mapRow(row);
  }

  async unarchive(id: string): Promise<Chat> {
    const now = this.clock.now();
    await this.db
      .update(chats)
      .set({ status: 'active', updatedAt: now })
      .where(eq(chats.id, id))
      .run();

    const row = await this.db.select().from(chats).where(eq(chats.id, id)).get();
    if (!row) throw new Error(`Chat '${id}' not found after unarchive`);
    return this.mapRow(row);
  }

  async updateSummary(id: string, summary: string): Promise<Chat> {
    const now = this.clock.now();
    await this.db
      .update(chats)
      .set({ summary, updatedAt: now })
      .where(eq(chats.id, id))
      .run();

    const row = await this.db.select().from(chats).where(eq(chats.id, id)).get();
    if (!row) throw new Error(`Chat '${id}' not found after summary update`);
    return this.mapRow(row);
  }

  async setMessageHistoryLimit(id: string, limit: number): Promise<Chat> {
    const now = this.clock.now();
    await this.db
      .update(chats)
      .set({ messageHistoryLimit: limit, updatedAt: now })
      .where(eq(chats.id, id))
      .run();

    const row = await this.db.select().from(chats).where(eq(chats.id, id)).get();
    if (!row) throw new Error(`Chat '${id}' not found after limit update`);
    return this.mapRow(row);
  }

  async setPersona(id: string, personaId: string | null): Promise<Chat> {
    const now = this.clock.now();
    await this.db
      .update(chats)
      .set({ personaId, updatedAt: now })
      .where(eq(chats.id, id))
      .run();

    const row = await this.db.select().from(chats).where(eq(chats.id, id)).get();
    if (!row) throw new Error(`Chat '${id}' not found after persona update`);
    return this.mapRow(row);
  }

  async setPromptPreset(id: string, promptPresetId: string): Promise<Chat> {
    const now = this.clock.now();
    await this.db
      .update(chats)
      .set({ promptPresetId, updatedAt: now })
      .where(eq(chats.id, id))
      .run();

    const row = await this.db.select().from(chats).where(eq(chats.id, id)).get();
    if (!row) throw new Error(`Chat '${id}' not found after prompt preset update`);
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
    await this.db
      .update(chats)
      .set({ activeBranchId: branchId, updatedAt: now })
      .where(eq(chats.id, chatId))
      .run();

    const row = await this.db.select().from(chats).where(eq(chats.id, chatId)).get();
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

      for (const msg of msgsToCopy) {
        const newMsgId = this.idGen.next('msg');
        await tx.insert(messages).values({
          id: newMsgId, chatId, branchId, role: msg.role, authorType: msg.authorType,
          position: msg.position, content: msg.content, state: msg.state,
          createdAt: now, updatedAt: now,
        }).run();
        // Copy ALL messageVariants for this message
        const variants = await tx.select().from(messageVariants)
          .where(eq(messageVariants.messageId, msg.id)).all();
        for (const v of variants) {
          await tx.insert(messageVariants).values({
            id: this.idGen.next('mvar'), messageId: newMsgId, variantIndex: v.variantIndex,
            content: v.content, isSelected: v.isSelected, finishReason: v.finishReason, createdAt: now,
          }).run();
        }
      }
    });

    const row = await this.db.select().from(chatBranches).where(eq(chatBranches.id, branchId)).get();
    return this.mapRowBranch(row!);
  }

  async renameBranch(branchId: string, label: string): Promise<ChatBranch> {
    await this.db
      .update(chatBranches)
      .set({ label })
      .where(eq(chatBranches.id, branchId))
      .run();

    const row = await this.db
      .select()
      .from(chatBranches)
      .where(eq(chatBranches.id, branchId))
      .get();
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

    await this.db.delete(chatBranches).where(eq(chatBranches.id, branchId)).run();
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
  }): Promise<Message> {
    const id = this.idGen.next('msg');
    const now = this.clock.now();
    const lastMsg = await this.db.select({ position: messages.position }).from(messages)
      .where(eq(messages.branchId, data.branchId))
      .orderBy(desc(messages.position)).limit(1).get();
    const nextPosition = (lastMsg?.position ?? -1) + 1;

    await this.db.transaction(async (tx) => {
      await tx.insert(messages).values({
        id, chatId: data.chatId, branchId: data.branchId,
        role: data.role, authorType: data.authorType,
        position: nextPosition, content: data.content,
        state: 'complete', createdAt: now, updatedAt: now,
      }).run();
      // Create initial variant (index 0, selected) — addMessage always creates a first variant
      await tx.insert(messageVariants).values({
        id: this.idGen.next('mvar'), messageId: id, variantIndex: 0,
        content: data.content, isSelected: 1, finishReason: null, createdAt: now,
      }).run();
    });

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

    await this.db
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
      .run();

    // Do NOT create a variant yet — variant is created when streaming completes
    const row = await this.db.select().from(messages).where(eq(messages.id, id)).get();
    return this.mapRowMessage(row!);
  }

  async completeStreamingMessage(id: string, content: string): Promise<Message> {
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

    const row = await this.db.select().from(messages).where(eq(messages.id, id)).get();
    return this.mapRowMessage(row!);
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

    await this.db
      .insert(messageVariants)
      .values({
        id,
        messageId,
        variantIndex: nextIndex,
        content,
        isSelected: 0,
        finishReason: finishReason ?? null,
        createdAt: now,
      })
      .run();

    const row = await this.db
      .select()
      .from(messageVariants)
      .where(eq(messageVariants.id, id))
      .get();
    return this.mapRowVariant(row!);
  }

  async selectVariant(messageId: string, variantIndex: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Clear all selections for this message
      await tx.update(messageVariants).set({ isSelected: 0 })
        .where(eq(messageVariants.messageId, messageId)).run();
      // Select target variant and get its content
      const target = await tx.update(messageVariants).set({ isSelected: 1 })
        .where(and(eq(messageVariants.messageId, messageId), eq(messageVariants.variantIndex, variantIndex)))
        .returning().get();
      // Sync messages.content with selected variant content (invariant)
      if (target) {
        await tx.update(messages).set({ content: target.content, updatedAt: this.clock.now() })
          .where(eq(messages.id, messageId)).run();
      }
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

  // ─── mapRow helpers ──────────────────────────────────────────────────────────

  private mapRow(row: typeof chats.$inferSelect): Chat {
    return {
      id: row.id,
      characterId: row.characterId,
      personaId: row.personaId,
      title: row.title,
      summary: row.summary,
      messageHistoryLimit: row.messageHistoryLimit,
      status: row.status as Chat['status'],
      activeBranchId: row.activeBranchId,
      promptPresetId: row.promptPresetId,
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
      latencyMs: row.latencyMs,
      createdAt: row.createdAt,
    };
  }
}
