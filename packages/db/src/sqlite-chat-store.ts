import type { Chat, ChatBranch, ChatBranchId, ChatId, Message, MessageId, MessageVariant, MessageVariantId, PersonaId, PromptTrace, PromptTraceId, SummaryMemorySnapshot, SummaryMemorySnapshotId } from "@rp-platform/domain";
import { ENTITY_ID_NAMESPACE } from "@rp-platform/domain";

import type { AppendChatMessageInput, ChatBranchState, CreateChatSessionInput, CreateChatSessionResult, CreateMessageVariantInput, CreatePromptTraceInput, ForkChatBranchInput, ForkChatBranchResult, ListPromptTracesInput, RecordSummarySnapshotInput } from "./chat-session-store.js";
import type { StoreClock, StoreIdGenerator } from "./persistence.js";
import type { SqliteDatabaseAdapter, SqliteRow } from "./sqlite-adapter.js";
import { type ChatBranchRow, type ChatRow, type MessageRow, type MessageVariantRow, type PositionRow, type PromptTraceRow, type SummaryRow, mapBranch, mapChat, mapMessage, mapMessageVariant, mapPromptTrace, mapSummary } from "./sqlite-chat-session-mappers.js";

export class SqliteChatStore {
  constructor(
    private readonly db: SqliteDatabaseAdapter,
    private readonly clock: StoreClock,
    private readonly idGenerator: StoreIdGenerator,
  ) {}

  updateChatPersona(chatId: ChatId, personaId: PersonaId): void {
    this.db.transaction(() => {
      this.requireChat(chatId);
      const timestamp = this.clock.now();
      const personaExists = this.db.queryOne(`SELECT 1 FROM personas WHERE id = ?`, [personaId]);
      if (!personaExists) {
        throw new Error(`Persona '${personaId}' was not found.`);
      }
      this.db.execute(`UPDATE chats SET persona_id = ?, updated_at = ? WHERE id = ?`, [
        personaId,
        timestamp,
        chatId,
      ]);
      this.touchChat(chatId, timestamp);
    });
  }

  createChat(input: CreateChatSessionInput): CreateChatSessionResult {
    return this.db.transaction(() => {
      const timestamp = input.createdAt ?? this.clock.now();
      const chatId = this.idGenerator.next(ENTITY_ID_NAMESPACE.chat) as ChatId;
      const rootBranchId = this.idGenerator.next(ENTITY_ID_NAMESPACE.chatBranch) as ChatBranchId;

      this.db.execute(
        `INSERT INTO chats (
          id, character_id, persona_id, title, status, active_branch_id,
          prompt_preset_id, tool_profile_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          chatId,
          input.characterId,
          input.personaId,
          input.title,
          "active",
          rootBranchId,
          input.promptPresetId,
          input.toolProfileId,
          timestamp,
          timestamp,
        ],
      );

      this.db.execute(
        `INSERT INTO chat_branches (
          id, chat_id, parent_branch_id, forked_from_message_id, label, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [rootBranchId, chatId, null, null, "main", timestamp],
      );

      const chat = this.requireChat(chatId);
      const rootBranch = this.requireBranch(chatId, rootBranchId);

      return {
        chat,
        rootBranch,
      };
    });
  }

  listChats(): Chat[] {
    return this.db
      .queryAll<ChatRow>(
        `SELECT id, character_id, persona_id, title, status, active_branch_id,
                prompt_preset_id, tool_profile_id, created_at, updated_at
         FROM chats
         ORDER BY created_at ASC, id ASC`,
      )
      .map(mapChat);
  }

  getChat(chatId: ChatId): Chat | null {
    const row = this.db.queryOne<ChatRow>(
      `SELECT id, character_id, persona_id, title, status, active_branch_id,
              prompt_preset_id, tool_profile_id, created_at, updated_at
       FROM chats
       WHERE id = ?`,
      [chatId],
    );
    return row ? mapChat(row) : null;
  }

  listBranches(chatId: ChatId): ChatBranch[] {
    this.requireChat(chatId);
    return this.db
      .queryAll<ChatBranchRow>(
        `SELECT id, chat_id, parent_branch_id, forked_from_message_id, label, created_at
         FROM chat_branches
         WHERE chat_id = ?
         ORDER BY created_at ASC, id ASC`,
        [chatId],
      )
      .map(mapBranch);
  }

  getBranchState(chatId: ChatId, branchId: ChatBranchId): ChatBranchState | null {
    const branch = this.getBranch(branchId);
    if (!branch || branch.chatId !== chatId) {
      return null;
    }

    return {
      branch,
      messages: this.listMessagesForBranch(branchId),
      summaries: this.listSummariesForBranch(branchId),
    };
  }

  appendMessage(input: AppendChatMessageInput): Message {
    return this.db.transaction(() => {
      const chat = this.requireChat(input.chatId);
      this.requireBranch(input.chatId, input.branchId);

      const timestamp = input.createdAt ?? this.clock.now();
      const messageId = this.idGenerator.next(ENTITY_ID_NAMESPACE.message) as MessageId;
      const position = this.nextMessagePosition(input.branchId);

      this.db.execute(
        `INSERT INTO messages (
          id, chat_id, branch_id, role, author_type, position, content, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          messageId,
          input.chatId,
          input.branchId,
          input.role,
          input.authorType,
          position,
          input.content,
          input.state ?? "complete",
          timestamp,
          timestamp,
        ],
      );

      if (input.role === "assistant") {
        this.db.execute(
          `INSERT INTO message_variants (
            id, message_id, variant_index, content, is_selected, finish_reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            this.idGenerator.next(ENTITY_ID_NAMESPACE.messageVariant) as MessageVariantId,
            messageId,
            0,
            input.content,
            1,
            null,
            timestamp,
          ],
        );
      }

      this.touchChat(chat.id, timestamp);
      return this.requireMessage(messageId);
    });
  }

  updateMessage(messageId: MessageId, content: string): Message {
    return this.db.transaction(() => {
      const message = this.requireMessage(messageId);
      this.ensureDefaultAssistantVariant(message);
      const timestamp = this.clock.now();
      this.db.execute(
        `UPDATE messages SET content = ?, updated_at = ? WHERE id = ?`,
        [content, timestamp, messageId]
      );
      if (message.role === "assistant") {
        this.db.execute(
          `UPDATE message_variants SET content = ? WHERE message_id = ? AND is_selected = 1`,
          [content, messageId],
        );
      }
      this.touchChat(message.chatId, timestamp);
      return this.requireMessage(messageId);
    });
  }

  createMessageVariant(input: CreateMessageVariantInput): MessageVariant {
    return this.db.transaction(() => {
      const message = this.requireMessage(input.messageId);
      if (message.role !== "assistant") {
        throw new Error(`Message '${input.messageId}' does not support variants.`);
      }
      this.ensureDefaultAssistantVariant(message);

      const timestamp = input.createdAt ?? this.clock.now();
      const indexRow = this.db.queryOne<SqliteRow & { max_index: number | null }>(
        `SELECT MAX(variant_index) AS max_index FROM message_variants WHERE message_id = ?`,
        [input.messageId],
      );
      const variantId = this.idGenerator.next(ENTITY_ID_NAMESPACE.messageVariant) as MessageVariantId;
      const variantIndex = (indexRow?.max_index ?? -1) + 1;
      const isSelected = input.isSelected ?? true;

      if (isSelected) {
        this.db.execute(`UPDATE message_variants SET is_selected = 0 WHERE message_id = ?`, [input.messageId]);
      }

      this.db.execute(
        `INSERT INTO message_variants (
          id, message_id, variant_index, content, is_selected, finish_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          variantId,
          input.messageId,
          variantIndex,
          input.content,
          isSelected ? 1 : 0,
          input.finishReason ?? null,
          timestamp,
        ],
      );

      if (isSelected) {
        this.db.execute(`UPDATE messages SET content = ?, updated_at = ? WHERE id = ?`, [
          input.content,
          timestamp,
          input.messageId,
        ]);
      }

      this.touchChat(message.chatId, timestamp);
      return this.requireMessageVariant(variantId);
    });
  }

  listMessageVariants(messageId: MessageId): MessageVariant[] {
    const message = this.requireMessage(messageId);
    this.ensureDefaultAssistantVariant(message);
    return this.db
      .queryAll<MessageVariantRow>(
        `SELECT id, message_id, variant_index, content, is_selected, finish_reason, created_at
         FROM message_variants
         WHERE message_id = ?
         ORDER BY variant_index ASC, created_at ASC, id ASC`,
        [messageId],
      )
      .map(mapMessageVariant);
  }

  selectMessageVariant(messageId: MessageId, variantIndex: number): Message {
    return this.db.transaction(() => {
      const message = this.requireMessage(messageId);
      this.ensureDefaultAssistantVariant(message);
      const timestamp = this.clock.now();
      const variant = this.db.queryOne<MessageVariantRow>(
        `SELECT id, message_id, variant_index, content, is_selected, finish_reason, created_at
         FROM message_variants
         WHERE message_id = ? AND variant_index = ?`,
        [messageId, variantIndex],
      );
      if (!variant) {
        throw new Error(`Variant '${variantIndex}' was not found for message '${messageId}'.`);
      }
      this.db.execute(`UPDATE message_variants SET is_selected = 0 WHERE message_id = ?`, [messageId]);
      this.db.execute(`UPDATE message_variants SET is_selected = 1 WHERE id = ?`, [variant.id]);
      this.db.execute(`UPDATE messages SET content = ?, updated_at = ? WHERE id = ?`, [
        variant.content,
        timestamp,
        messageId,
      ]);
      this.touchChat(message.chatId, timestamp);
      return this.requireMessage(messageId);
    });
  }

  deleteMessage(messageId: MessageId): void {
    this.db.transaction(() => {
      const message = this.requireMessage(messageId);
      const timestamp = this.clock.now();

      this.db.execute(`DELETE FROM messages WHERE id = ?`, [messageId]);

      // Update positions for subsequent messages
      this.db.execute(
        `UPDATE messages
         SET position = position - 1
         WHERE branch_id = ? AND position > ?`,
        [message.branchId, message.position]
      );

      this.touchChat(message.chatId, timestamp);
    });
  }

  forkBranch(input: ForkChatBranchInput): ForkChatBranchResult {
    return this.db.transaction(() => {
      const chat = this.requireChat(input.chatId);
      const sourceState = this.requireBranchState(input.chatId, input.sourceBranchId);
      const timestamp = input.createdAt ?? this.clock.now();
      const branchId = this.idGenerator.next(ENTITY_ID_NAMESPACE.chatBranch) as ChatBranchId;

      const forkIndex = resolveForkIndex(
        sourceState.messages,
        input.forkedFromMessageId ?? null,
      );
      const copiedSourceMessages = sourceState.messages.slice(0, forkIndex + 1);
      const copiedMessageIds = new Map<MessageId, MessageId>();

      this.db.execute(
        `INSERT INTO chat_branches (
          id, chat_id, parent_branch_id, forked_from_message_id, label, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          branchId,
          input.chatId,
          input.sourceBranchId,
          copiedSourceMessages.length > 0
            ? copiedSourceMessages[copiedSourceMessages.length - 1]?.id ?? null
            : null,
          input.label,
          timestamp,
        ],
      );

      copiedSourceMessages.forEach((message, index) => {
        const nextId = this.idGenerator.next(ENTITY_ID_NAMESPACE.message) as MessageId;
        copiedMessageIds.set(message.id, nextId);
        this.db.execute(
          `INSERT INTO messages (
            id, chat_id, branch_id, role, author_type, position, content, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            nextId,
            input.chatId,
            branchId,
            message.role,
            message.authorType,
            index,
            message.content,
            message.state,
            timestamp,
            timestamp,
          ],
        );

        this.listMessageVariants(message.id).forEach((variant) => {
          this.db.execute(
            `INSERT INTO message_variants (
              id, message_id, variant_index, content, is_selected, finish_reason, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              this.idGenerator.next(ENTITY_ID_NAMESPACE.messageVariant) as MessageVariantId,
              nextId,
              variant.variantIndex,
              variant.content,
              variant.isSelected ? 1 : 0,
              variant.finishReason,
              timestamp,
            ],
          );
        });
      });

      sourceState.summaries
        .filter((summary) =>
          copiedSourceMessages.some(
            (message) => message.id === summary.coversThroughMessageId,
          ),
        )
        .forEach((summary) => {
          const remappedMessageId = copiedMessageIds.get(summary.coversThroughMessageId);
          if (!remappedMessageId) {
            throw new Error(
              `Cannot remap summary '${summary.id}' while forking branch '${input.sourceBranchId}'.`,
            );
          }

          this.db.execute(
            `INSERT INTO summary_memory_snapshots (
              id, chat_id, branch_id, kind, summary, covers_through_message_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              this.idGenerator.next(ENTITY_ID_NAMESPACE.summaryMemory) as SummaryMemorySnapshotId,
              input.chatId,
              branchId,
              summary.kind,
              summary.summary,
              remappedMessageId,
              timestamp,
            ],
          );
        });

      if (input.activateFork ?? true) {
        this.db.execute(`UPDATE chats SET active_branch_id = ?, updated_at = ? WHERE id = ?`, [
          branchId,
          timestamp,
          chat.id,
        ]);
      } else {
        this.touchChat(chat.id, timestamp);
      }

      return {
        branch: this.requireBranch(input.chatId, branchId),
        copiedMessageCount: copiedSourceMessages.length,
      };
    });
  }

  activateBranch(chatId: ChatId, branchId: ChatBranchId): Chat {
    this.requireBranch(chatId, branchId);
    this.touchChat(chatId);
    this.db.execute(`UPDATE chats SET active_branch_id = ? WHERE id = ?`, [branchId, chatId]);
    return this.requireChat(chatId);
  }

  recordSummarySnapshot(
    input: RecordSummarySnapshotInput,
  ): SummaryMemorySnapshot {
    return this.db.transaction(() => {
      const chat = this.requireChat(input.chatId);
      const branchState = this.requireBranchState(input.chatId, input.branchId);
      const timestamp = input.createdAt ?? this.clock.now();

      if (
        !branchState.messages.some(
          (message) => message.id === input.coversThroughMessageId,
        )
      ) {
        throw new Error(
          `Cannot record summary for missing message '${input.coversThroughMessageId}' in branch '${input.branchId}'.`,
        );
      }

      const summaryId = this.idGenerator.next(ENTITY_ID_NAMESPACE.summaryMemory) as SummaryMemorySnapshotId;
      this.db.execute(
        `INSERT INTO summary_memory_snapshots (
          id, chat_id, branch_id, kind, summary, covers_through_message_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          summaryId,
          input.chatId,
          input.branchId,
          input.kind,
          input.summary,
          input.coversThroughMessageId,
          timestamp,
        ],
      );

      this.touchChat(chat.id, timestamp);
      return this.requireSummary(summaryId);
    });
  }

  sleepBranch(input: RecordSummarySnapshotInput): SummaryMemorySnapshot {
    return this.recordSummarySnapshot(input);
  }

  createPromptTrace(input: CreatePromptTraceInput): PromptTrace {
    return this.db.transaction(() => {
      const chat = this.requireChat(input.chatId);
      const branchState = this.requireBranchState(input.chatId, input.branchId);
      const timestamp = input.createdAt ?? this.clock.now();

      if (!branchState.messages.some((message) => message.id === input.messageId)) {
        throw new Error(
          `Cannot record prompt trace for missing message '${input.messageId}' in branch '${input.branchId}'.`,
        );
      }

      const traceId = this.idGenerator.next(ENTITY_ID_NAMESPACE.promptTrace) as PromptTraceId;
      this.db.execute(
        `INSERT INTO prompt_traces (
          id, chat_id, branch_id, message_id, model, preset_name,
          assembled_layers_json, token_accounting_json, activated_lore_entries_json,
          retrieved_memories_json, final_payload_json, latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          traceId,
          input.chatId,
          input.branchId,
          input.messageId,
          input.model,
          input.presetName,
          JSON.stringify(input.assembledLayers),
          JSON.stringify(input.tokenAccounting),
          JSON.stringify(input.activatedLoreEntries),
          JSON.stringify(input.retrievedMemories),
          JSON.stringify(input.finalPayload),
          input.latencyMs,
          timestamp,
        ],
      );

      this.touchChat(chat.id, timestamp);
      return this.requirePromptTrace(traceId);
    });
  }

  getLatestPromptTrace(chatId: ChatId, branchId?: ChatBranchId): PromptTrace | null {
    return this.listPromptTraces({
      chatId,
      branchId,
      limit: 1,
    })[0] ?? null;
  }

  listPromptTraces(input: ListPromptTracesInput): PromptTrace[] {
    this.requireChat(input.chatId);
    if (input.branchId) {
      this.requireBranch(input.chatId, input.branchId);
    }

    const clauses = ["chat_id = ?"];
    const params: Array<string | number> = [input.chatId];

    if (input.branchId) {
      clauses.push("branch_id = ?");
      params.push(input.branchId);
    }

    let sql = `SELECT id, chat_id, branch_id, message_id, model, preset_name,
                      assembled_layers_json, token_accounting_json, activated_lore_entries_json,
                      retrieved_memories_json, final_payload_json, latency_ms, created_at
               FROM prompt_traces
               WHERE ${clauses.join(" AND ")}
               ORDER BY created_at DESC, id DESC`;

    if (typeof input.limit === "number") {
      sql += ` LIMIT ?`;
      params.push(input.limit);
    }

    return this.db.queryAll<PromptTraceRow>(sql, params).map(mapPromptTrace);
  }

  deleteChat(chatId: ChatId): void {
    this.db.transaction(() => {
      this.db.execute(`DELETE FROM prompt_traces WHERE chat_id = ?`, [chatId]);
      this.db.execute(
        `DELETE FROM message_variants WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)`,
        [chatId],
      );
      this.db.execute(`DELETE FROM messages WHERE chat_id = ?`, [chatId]);
      this.db.execute(`DELETE FROM summary_memory_snapshots WHERE chat_id = ?`, [chatId]);
      this.db.execute(`DELETE FROM chat_branches WHERE chat_id = ?`, [chatId]);
      this.db.execute(`DELETE FROM retrieved_memory_hits WHERE chat_id = ?`, [chatId]);
      this.db.execute(`DELETE FROM chat_capabilities WHERE chat_id = ?`, [chatId]);
      this.db.execute(`DELETE FROM chat_lorebooks WHERE chat_id = ?`, [chatId]);
      this.db.execute(`DELETE FROM chats WHERE id = ?`, [chatId]);
    });
  }

  renameChat(chatId: ChatId, title: string): void {
    const timestamp = this.clock.now();
    this.db.execute(
      `UPDATE chats SET title = ?, updated_at = ? WHERE id = ?`,
      [title, timestamp, chatId],
    );
  }

  deleteBranch(chatId: ChatId, branchId: ChatBranchId): { activeBranchId: ChatBranchId; deletedBranchId: ChatBranchId } {
    return this.db.transaction(() => {
      const chat = this.requireChat(chatId);
      const branch = this.requireBranch(chatId, branchId);

      if (branch.parentBranchId === null) {
        throw new Error("Cannot delete the root/main branch.");
      }

      const branchCount = this.db.queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM chat_branches WHERE chat_id = ?`,
        [chatId],
      );
      if ((branchCount?.n ?? 0) <= 1) {
        throw new Error("Cannot delete the last branch.");
      }

      const fallbackBranch = this.db.queryOne<ChatBranchRow>(
        `SELECT id, chat_id, parent_branch_id, forked_from_message_id, label, created_at
         FROM chat_branches
         WHERE chat_id = ? AND parent_branch_id IS NULL
         LIMIT 1`,
        [chatId],
      );
      if (!fallbackBranch) {
        throw new Error("Could not resolve fallback root branch.");
      }
      const fallbackBranchId = fallbackBranch.id as ChatBranchId;

      if (chat.activeBranchId === branchId) {
        this.db.execute(
          `UPDATE chats SET active_branch_id = ?, updated_at = ? WHERE id = ?`,
          [fallbackBranchId, this.clock.now(), chatId],
        );
      }

      this.db.execute(
        `UPDATE chat_branches SET parent_branch_id = ? WHERE chat_id = ? AND parent_branch_id = ?`,
        [branch.parentBranchId, chatId, branchId],
      );

      this.db.execute(
        `DELETE FROM prompt_traces WHERE branch_id = ? AND chat_id = ?`,
        [branchId, chatId],
      );

      const messageIds = this.db.queryAll<{ id: string }>(
        `SELECT id FROM messages WHERE branch_id = ?`,
        [branchId],
      ).map((r) => r.id);

      for (const messageId of messageIds) {
        this.db.execute(`DELETE FROM message_variants WHERE message_id = ?`, [messageId]);
      }

      this.db.execute(`DELETE FROM messages WHERE branch_id = ?`, [branchId]);
      this.db.execute(`DELETE FROM summary_memory_snapshots WHERE branch_id = ? AND chat_id = ?`, [branchId, chatId]);
      this.db.execute(`DELETE FROM chat_branches WHERE id = ?`, [branchId]);

      this.touchChat(chatId);

      const updatedChat = this.requireChat(chatId);
      return {
        activeBranchId: updatedChat.activeBranchId,
        deletedBranchId: branchId,
      };
    });
  }

  cloneChat(chatId: ChatId, title?: string): CreateChatSessionResult {
    return this.db.transaction(() => {
      const sourceChat = this.requireChat(chatId);
      const sourceBranchState = this.requireBranchState(chatId, sourceChat.activeBranchId);
      const timestamp = this.clock.now();
      const newChatId = this.idGenerator.next(ENTITY_ID_NAMESPACE.chat) as ChatId;
      const newRootBranchId = this.idGenerator.next(ENTITY_ID_NAMESPACE.chatBranch) as ChatBranchId;

      this.db.execute(
        `INSERT INTO chats (
          id, character_id, persona_id, title, status, active_branch_id,
          prompt_preset_id, tool_profile_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newChatId,
          sourceChat.characterId,
          sourceChat.personaId,
          title ?? `${sourceChat.title} (copy)`,
          "active",
          newRootBranchId,
          sourceChat.promptPresetId,
          sourceChat.toolProfileId,
          timestamp,
          timestamp,
        ],
      );

      this.db.execute(
        `INSERT INTO chat_branches (
          id, chat_id, parent_branch_id, forked_from_message_id, label, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [newRootBranchId, newChatId, null, null, "main", timestamp],
      );

      const copiedMessageIds = new Map<MessageId, MessageId>();
      sourceBranchState.messages.forEach((message, index) => {
        const nextId = this.idGenerator.next(ENTITY_ID_NAMESPACE.message) as MessageId;
        copiedMessageIds.set(message.id, nextId);
        this.db.execute(
          `INSERT INTO messages (
            id, chat_id, branch_id, role, author_type, position, content, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            nextId,
            newChatId,
            newRootBranchId,
            message.role,
            message.authorType,
            index,
            message.content,
            message.state,
            timestamp,
            timestamp,
          ],
        );

        this.listMessageVariants(message.id).forEach((variant) => {
          this.db.execute(
            `INSERT INTO message_variants (
              id, message_id, variant_index, content, is_selected, finish_reason, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              this.idGenerator.next(ENTITY_ID_NAMESPACE.messageVariant) as MessageVariantId,
              nextId,
              variant.variantIndex,
              variant.content,
              variant.isSelected ? 1 : 0,
              variant.finishReason,
              timestamp,
            ],
          );
        });
      });

      const chat = this.requireChat(newChatId);
      const rootBranch = this.requireBranch(newChatId, newRootBranchId);
      return { chat, rootBranch };
    });
  }

  getPromptTrace(promptTraceId: PromptTraceId): PromptTrace | null {
    const row = this.db.queryOne<PromptTraceRow>(
      `SELECT id, chat_id, branch_id, message_id, model, preset_name,
              assembled_layers_json, token_accounting_json, activated_lore_entries_json,
              retrieved_memories_json, final_payload_json, latency_ms, created_at
       FROM prompt_traces
       WHERE id = ?`,
      [promptTraceId],
    );
    return row ? mapPromptTrace(row) : null;
  }

  private getBranch(branchId: ChatBranchId): ChatBranch | null {
    const row = this.db.queryOne<ChatBranchRow>(
      `SELECT id, chat_id, parent_branch_id, forked_from_message_id, label, created_at
       FROM chat_branches
       WHERE id = ?`,
      [branchId],
    );
    return row ? mapBranch(row) : null;
  }

  private listMessagesForBranch(branchId: ChatBranchId): Message[] {
    return this.db
      .queryAll<MessageRow>(
        `SELECT id, chat_id, branch_id, role, author_type, position, content, state, created_at, updated_at
         FROM messages
         WHERE branch_id = ?
         ORDER BY position ASC, created_at ASC`,
        [branchId],
      )
      .map(mapMessage);
  }

  private listSummariesForBranch(branchId: ChatBranchId): SummaryMemorySnapshot[] {
    return this.db
      .queryAll<SummaryRow>(
        `SELECT id, chat_id, branch_id, kind, summary, covers_through_message_id, created_at
         FROM summary_memory_snapshots
         WHERE branch_id = ?
         ORDER BY created_at ASC, id ASC`,
        [branchId],
      )
      .map(mapSummary);
  }

  private nextMessagePosition(branchId: ChatBranchId): number {
    const row = this.db.queryOne<PositionRow>(
      `SELECT MAX(position) AS max_position
       FROM messages
       WHERE branch_id = ?`,
      [branchId],
    );
    const lastPosition = row?.max_position;
    return typeof lastPosition === "number" ? lastPosition + 1 : 0;
  }

  private touchChat(chatId: ChatId, timestamp: string = this.clock.now()): void {
    this.db.execute(`UPDATE chats SET updated_at = ? WHERE id = ?`, [timestamp, chatId]);
  }

  private requireChat(chatId: ChatId): Chat {
    const chat = this.getChat(chatId);
    if (!chat) {
      throw new Error(`Chat '${chatId}' was not found.`);
    }
    return chat;
  }

  private requireBranch(chatId: ChatId, branchId: ChatBranchId): ChatBranch {
    const branch = this.getBranch(branchId);
    if (!branch || branch.chatId !== chatId) {
      throw new Error(`Branch '${branchId}' was not found for chat '${chatId}'.`);
    }
    return branch;
  }

  private requireBranchState(chatId: ChatId, branchId: ChatBranchId): ChatBranchState {
    const branchState = this.getBranchState(chatId, branchId);
    if (!branchState) {
      throw new Error(`Branch '${branchId}' was not found for chat '${chatId}'.`);
    }
    return branchState;
  }

  private requireMessage(messageId: MessageId): Message {
    const row = this.db.queryOne<MessageRow>(
      `SELECT id, chat_id, branch_id, role, author_type, position, content, state, created_at, updated_at
       FROM messages
       WHERE id = ?`,
      [messageId],
    );
    if (!row) {
      throw new Error(`Message '${messageId}' was not found.`);
    }
    return mapMessage(row);
  }


  private requireMessageVariant(variantId: MessageVariantId): MessageVariant {
    const row = this.db.queryOne<MessageVariantRow>(
      `SELECT id, message_id, variant_index, content, is_selected, finish_reason, created_at
       FROM message_variants
       WHERE id = ?`,
      [variantId],
    );
    if (!row) {
      throw new Error(`Message variant '${variantId}' was not found.`);
    }
    return mapMessageVariant(row);
  }

  private requireSummary(summaryId: string): SummaryMemorySnapshot {
    const row = this.db.queryOne<SummaryRow>(
      `SELECT id, chat_id, branch_id, kind, summary, covers_through_message_id, created_at
       FROM summary_memory_snapshots
       WHERE id = ?`,
      [summaryId],
    );
    if (!row) {
      throw new Error(`Summary '${summaryId}' was not found.`);
    }
    return mapSummary(row);
  }

  private requirePromptTrace(traceId: string): PromptTrace {
    const row = this.db.queryOne<PromptTraceRow>(
      `SELECT id, chat_id, branch_id, message_id, model, preset_name,
              assembled_layers_json, token_accounting_json, activated_lore_entries_json,
              retrieved_memories_json, final_payload_json, latency_ms, created_at
       FROM prompt_traces
       WHERE id = ?`,
      [traceId],
    );
    if (!row) {
      throw new Error(`Prompt trace '${traceId}' was not found.`);
    }
    return mapPromptTrace(row);
  }

  private ensureDefaultAssistantVariant(message: Message): void {
    if (message.role !== "assistant") {
      return;
    }
    const existing = this.db.queryOne<SqliteRow & { count: number }>(
      `SELECT COUNT(*) AS count FROM message_variants WHERE message_id = ?`,
      [message.id],
    );
    if ((existing?.count ?? 0) > 0) {
      return;
    }
    this.db.execute(
      `INSERT INTO message_variants (
        id, message_id, variant_index, content, is_selected, finish_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        this.idGenerator.next(ENTITY_ID_NAMESPACE.messageVariant) as MessageVariantId,
        message.id,
        0,
        message.content,
        1,
        null,
        message.createdAt,
      ],
    );
  }
}

function resolveForkIndex(
  messages: Message[],
  forkedFromMessageId: MessageId | null,
): number {
  if (messages.length === 0) {
    return -1;
  }

  if (forkedFromMessageId === null) {
    return messages.length - 1;
  }

  const index = messages.findIndex((message) => message.id === forkedFromMessageId);
  if (index === -1) {
    throw new Error(`Cannot fork from missing message '${forkedFromMessageId}'.`);
  }

  return index;
}
