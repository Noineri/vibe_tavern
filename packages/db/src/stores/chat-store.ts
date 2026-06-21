import { eq, and, desc, asc, lte, count } from 'drizzle-orm';
import { chats, chatBranches, characters, messages, messageVariants } from '../db-schema.js';
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
  promptPresetId: string | null;
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
  messageCount?: number;
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
    promptPresetId: string | null;
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

  async listByPreset(promptPresetId: string): Promise<Chat[]> {
    const rows = await this.db
      .select()
      .from(chats)
      .where(eq(chats.promptPresetId, promptPresetId))
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

  async getBranchMessageCounts(chatId: string): Promise<Map<string, number>> {
    const rows = await this.db
      .select({
        branchId: messages.branchId,
        count: count(),
      })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .groupBy(messages.branchId)
      .all();
    return new Map(rows.map((r) => [r.branchId, r.count]));
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
      .select({ count: count() })
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
