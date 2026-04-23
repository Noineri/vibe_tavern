import type {
  Chat,
  ChatBranch,
  ChatBranchId,
  ChatId,
  Character,
  CharacterVersion,
  GenerationPreset,
  LoreEntry,
  Lorebook,
  Message,
  MessageId,
  MessageVariant,
  MessageVariantId,
  Persona,
  PersonaId,
  PromptTrace,
  SummaryMemorySnapshot,
  ToolProfile,
} from "@rp-platform/domain";

import type {
  AppendChatMessageInput,
  ChatBranchState,
  ChatSessionStore,
  CreateMessageVariantInput,
  CreatePromptTraceInput,
  CreateChatSessionInput,
  CreateChatSessionResult,
  ForkChatBranchInput,
  ForkChatBranchResult,
  ListPromptTracesInput,
  RecordSummarySnapshotInput,
} from "./chat-session-store.js";
import { resolveStoreRuntime, type StoreRuntimeOptions } from "./persistence.js";
import type { SqliteDatabaseAdapter, SqliteRow } from "./sqlite-adapter.js";

type ChatRow = SqliteRow & {
  id: string;
  character_id: string;
  persona_id: string;
  title: string;
  status: string;
  active_branch_id: string;
  generation_preset_id: string;
  tool_profile_id: string;
  created_at: string;
  updated_at: string;
};

type ChatBranchRow = SqliteRow & {
  id: string;
  chat_id: string;
  parent_branch_id: string | null;
  forked_from_message_id: string | null;
  label: string;
  created_at: string;
};

type MessageRow = SqliteRow & {
  id: string;
  chat_id: string;
  branch_id: string;
  role: string;
  author_type: string;
  position: number;
  content: string;
  state: string;
  created_at: string;
  updated_at: string;
};

type SummaryRow = SqliteRow & {
  id: string;
  chat_id: string;
  branch_id: string;
  kind: string;
  summary: string;
  covers_through_message_id: string;
  created_at: string;
};

type MessageVariantRow = SqliteRow & {
  id: string;
  message_id: string;
  variant_index: number;
  content: string;
  is_selected: number;
  finish_reason: string | null;
  created_at: string;
};

type PersonaRow = SqliteRow & {
  id: string;
  name: string;
  description: string;
  pronouns: string | null;
  avatar_asset_id: string | null;
  default_for_new_chats: number;
  created_at: string;
  updated_at: string;
};

type PromptTraceRow = SqliteRow & {
  id: string;
  chat_id: string;
  branch_id: string;
  message_id: string;
  model: string;
  preset_name: string;
  assembled_layers_json: string;
  token_accounting_json: string;
  activated_lore_entries_json: string;
  retrieved_memories_json: string;
  final_payload_json: string;
  latency_ms: number;
  created_at: string;
};

type PositionRow = SqliteRow & {
  max_position: number | null;
};

type CharacterRow = SqliteRow & {
  id: string;
  slug: string;
  name: string;
  description: string;
  default_scenario: string | null;
  avatar_asset_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

type CharacterVersionRow = SqliteRow & {
  id: string;
  character_id: string;
  version_number: number;
  title: string;
  card_format: string;
  definition_json: string;
  is_active: number;
  created_at: string;
};

type LoreEntryRow = SqliteRow & {
  id: string;
  lorebook_id: string;
  title: string;
  content: string;
  keys_json: string;
  secondary_keys_json: string;
  logic: string;
  position: string;
  depth: number;
  priority: number;
  sticky_window: number;
  cooldown_window: number;
  delay_window: number;
  enabled: number;
  metadata_json: string;
};

export class SqliteChatSessionStore implements ChatSessionStore {
  private readonly clock;
  private readonly idGenerator;

  constructor(
    private readonly db: SqliteDatabaseAdapter,
    runtimeOptions: StoreRuntimeOptions = {},
  ) {
    const runtime = resolveStoreRuntime(runtimeOptions);
    this.clock = runtime.clock;
    this.idGenerator = runtime.idGenerator;
  }

  upsertCharacter(input: Character): void {
    this.db.execute(
      `INSERT INTO characters (
        id, slug, name, description, default_scenario, avatar_asset_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        slug = excluded.slug,
        name = excluded.name,
        description = excluded.description,
        default_scenario = excluded.default_scenario,
        avatar_asset_id = excluded.avatar_asset_id,
        status = excluded.status,
        updated_at = excluded.updated_at`,
      [
        input.id,
        input.slug,
        input.name,
        input.description,
        input.defaultScenario,
        input.avatarAssetId,
        input.status,
        input.createdAt,
        input.updatedAt,
      ],
    );
  }

  upsertCharacterVersion(input: CharacterVersion): void {
    this.db.execute(
      `INSERT INTO character_versions (
        id, character_id, version_number, title, card_format, definition_json, is_active, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        character_id = excluded.character_id,
        version_number = excluded.version_number,
        title = excluded.title,
        card_format = excluded.card_format,
        definition_json = excluded.definition_json,
        is_active = excluded.is_active,
        created_at = excluded.created_at`,
      [
        input.id,
        input.characterId,
        input.versionNumber,
        input.title,
        input.cardFormat,
        JSON.stringify(input.definition),
        input.isActive ? 1 : 0,
        input.createdAt,
      ],
    );
  }

  upsertPersona(input: Persona): void {
    this.db.execute(
      `INSERT INTO personas (
        id, name, description, pronouns, avatar_asset_id, default_for_new_chats, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        pronouns = excluded.pronouns,
        avatar_asset_id = excluded.avatar_asset_id,
        default_for_new_chats = excluded.default_for_new_chats,
        updated_at = excluded.updated_at`,
      [
        input.id,
        input.name,
        input.description,
        input.pronouns,
        input.avatarAssetId,
        input.defaultForNewChats ? 1 : 0,
        input.createdAt,
        input.updatedAt,
      ],
    );
  }

  listPersonas(): Persona[] {
    return this.db
      .queryAll<PersonaRow>(
        `SELECT id, name, description, pronouns, avatar_asset_id, default_for_new_chats, created_at, updated_at
         FROM personas
         ORDER BY name ASC`
      )
      .map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        pronouns: row.pronouns,
        avatarAssetId: row.avatar_asset_id,
        defaultForNewChats: row.default_for_new_chats === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

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

  upsertGenerationPreset(input: GenerationPreset): void {
    this.db.execute(
      `INSERT INTO generation_presets (
        id, name, temperature, top_p, top_k, presence_penalty, frequency_penalty,
        max_output_tokens, system_style_note, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        temperature = excluded.temperature,
        top_p = excluded.top_p,
        top_k = excluded.top_k,
        presence_penalty = excluded.presence_penalty,
        frequency_penalty = excluded.frequency_penalty,
        max_output_tokens = excluded.max_output_tokens,
        system_style_note = excluded.system_style_note,
        metadata_json = excluded.metadata_json`,
      [
        input.id,
        input.name,
        input.temperature,
        input.topP,
        input.topK,
        input.presencePenalty,
        input.frequencyPenalty,
        input.maxOutputTokens,
        input.systemStyleNote,
        JSON.stringify(input.metadata),
      ],
    );
  }

  upsertToolProfile(input: ToolProfile): void {
    this.db.execute(
      `INSERT INTO tool_profiles (
        id, name, mode, instructions, metadata_json
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        mode = excluded.mode,
        instructions = excluded.instructions,
        metadata_json = excluded.metadata_json`,
      [
        input.id,
        input.name,
        input.mode,
        input.instructions,
        JSON.stringify(input.metadata),
      ],
    );
  }

  upsertLorebook(input: Lorebook): void {
    this.db.execute(
      `INSERT INTO lorebooks (
        id, name, scope_type, description, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        scope_type = excluded.scope_type,
        description = excluded.description,
        updated_at = excluded.updated_at`,
      [
        input.id,
        input.name,
        input.scopeType,
        input.description,
        input.createdAt,
        input.updatedAt,
      ],
    );
  }

  replaceLoreEntries(lorebookId: string, entries: LoreEntry[]): void {
    this.db.transaction(() => {
      this.db.execute(`DELETE FROM lore_entries WHERE lorebook_id = ?`, [lorebookId]);

      for (const entry of entries) {
        this.db.execute(
          `INSERT INTO lore_entries (
            id, lorebook_id, title, content, keys_json, secondary_keys_json, logic,
            position, depth, priority, sticky_window, cooldown_window, delay_window, enabled, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry.id,
            entry.lorebookId,
            entry.title,
            entry.content,
            JSON.stringify(entry.keys),
            JSON.stringify(entry.secondaryKeys),
            entry.logic,
            entry.position,
            entry.depth,
            entry.priority,
            entry.stickyWindow,
            entry.cooldownWindow,
            entry.delayWindow,
            entry.enabled ? 1 : 0,
            JSON.stringify(entry.metadata),
          ],
        );
      }
    });
  }

  linkCharacterLorebook(characterId: string, lorebookId: string): void {
    this.db.execute(
      `INSERT OR IGNORE INTO character_lorebooks (character_id, lorebook_id) VALUES (?, ?)`,
      [characterId, lorebookId],
    );
  }

  listCharacters(): Character[] {
    return this.db
      .queryAll<CharacterRow>(
        `SELECT id, slug, name, description, default_scenario, avatar_asset_id, status, created_at, updated_at
         FROM characters
         ORDER BY created_at ASC, id ASC`,
      )
      .map(mapCharacter);
  }

  getLatestCharacterVersion(characterId: string): CharacterVersion | null {
    const row = this.db.queryOne<CharacterVersionRow>(
      `SELECT id, character_id, version_number, title, card_format, definition_json, is_active, created_at
       FROM character_versions
       WHERE character_id = ?
       ORDER BY is_active DESC, version_number DESC, created_at DESC, id DESC
       LIMIT 1`,
      [characterId],
    );

    return row ? mapCharacterVersion(row) : null;
  }

  listLoreEntriesForCharacter(characterId: string): LoreEntry[] {
    return this.db
      .queryAll<LoreEntryRow>(
        `SELECT le.id, le.lorebook_id, le.title, le.content, le.keys_json, le.secondary_keys_json,
                le.logic, le.position, le.depth, le.priority, le.sticky_window, le.cooldown_window,
                le.delay_window, le.enabled, le.metadata_json
         FROM lore_entries le
         INNER JOIN character_lorebooks cl ON cl.lorebook_id = le.lorebook_id
         WHERE cl.character_id = ?
         ORDER BY le.priority DESC, le.id ASC`,
        [characterId],
      )
      .map(mapLoreEntry);
  }

  createChat(input: CreateChatSessionInput): CreateChatSessionResult {
    return this.db.transaction(() => {
      const timestamp = input.createdAt ?? this.clock.now();
      const chatId = this.idGenerator.next("chat") as ChatId;
      const rootBranchId = this.idGenerator.next("branch") as ChatBranchId;

      this.db.execute(
        `INSERT INTO chats (
          id, character_id, persona_id, title, status, active_branch_id,
          generation_preset_id, tool_profile_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          chatId,
          input.characterId,
          input.personaId,
          input.title,
          "active",
          rootBranchId,
          input.generationPresetId,
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
                generation_preset_id, tool_profile_id, created_at, updated_at
         FROM chats
         ORDER BY created_at ASC, id ASC`,
      )
      .map(mapChat);
  }

  getChat(chatId: ChatId): Chat | null {
    const row = this.db.queryOne<ChatRow>(
      `SELECT id, character_id, persona_id, title, status, active_branch_id,
              generation_preset_id, tool_profile_id, created_at, updated_at
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
      const messageId = this.idGenerator.next("msg") as MessageId;
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
            this.idGenerator.next("variant") as MessageVariantId,
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
      const variantId = this.idGenerator.next("variant") as MessageVariantId;
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
      const branchId = this.idGenerator.next("branch") as ChatBranchId;

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
        const nextId = this.idGenerator.next("msg") as MessageId;
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
              this.idGenerator.next("variant") as MessageVariantId,
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
              this.idGenerator.next("summary"),
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

      const summaryId = this.idGenerator.next("summary");
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

      const traceId = this.idGenerator.next("trace");
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

  // Provider Profiles
  upsertProviderProfile(profile: any): void {
    const timestamp = this.clock.now();
    const id = profile.id || (this.idGenerator.next("provider") as string);
    this.db.execute(
      `INSERT INTO provider_profiles (
        id, name, type, endpoint, api_key, default_model, context_budget, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        endpoint = excluded.endpoint,
        api_key = excluded.api_key,
        default_model = excluded.default_model,
        context_budget = excluded.context_budget,
        updated_at = excluded.updated_at`,
      [
        id,
        profile.name,
        profile.type,
        profile.endpoint,
        profile.apiKey || null,
        profile.defaultModel || null,
        profile.contextBudget ?? 8192,
        profile.createdAt || timestamp,
        timestamp,
      ],
    );
  }

  listProviderProfiles(): any[] {
    return this.db.queryAll<any>(
      `SELECT id, name, type, endpoint, api_key as apiKey, default_model as defaultModel,
              context_budget as contextBudget, created_at as createdAt, updated_at as updatedAt
       FROM provider_profiles
       ORDER BY name ASC`,
    );
  }

  getProviderProfile(id: string): any | null {
    return this.db.queryOne<any>(
      `SELECT id, name, type, endpoint, api_key as apiKey, default_model as defaultModel,
              context_budget as contextBudget, created_at as createdAt, updated_at as updatedAt
       FROM provider_profiles
       WHERE id = ?`,
      [id],
    );
  }

  deleteProviderProfile(id: string): void {
    this.db.execute(`DELETE FROM provider_profiles WHERE id = ?`, [id]);
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
        this.idGenerator.next("variant") as MessageVariantId,
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

function mapChat(row: ChatRow): Chat {
  return {
    id: row.id,
    characterId: row.character_id,
    personaId: row.persona_id,
    title: row.title,
    status: row.status as Chat["status"],
    activeBranchId: row.active_branch_id,
    generationPresetId: row.generation_preset_id,
    toolProfileId: row.tool_profile_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCharacter(row: CharacterRow): Character {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    defaultScenario: row.default_scenario,
    avatarAssetId: row.avatar_asset_id,
    status: row.status as Character["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCharacterVersion(row: CharacterVersionRow): CharacterVersion {
  return {
    id: row.id,
    characterId: row.character_id,
    versionNumber: row.version_number,
    title: row.title,
    cardFormat: row.card_format as CharacterVersion["cardFormat"],
    definition: parseJson<Record<string, unknown>>(row.definition_json),
    isActive: row.is_active === 1,
    createdAt: row.created_at,
  };
}

function mapLoreEntry(row: LoreEntryRow): LoreEntry {
  return {
    id: row.id,
    lorebookId: row.lorebook_id,
    title: row.title,
    content: row.content,
    keys: parseJson<string[]>(row.keys_json),
    secondaryKeys: parseJson<string[]>(row.secondary_keys_json),
    logic: row.logic as LoreEntry["logic"],
    position: row.position as LoreEntry["position"],
    depth: row.depth,
    priority: row.priority,
    stickyWindow: row.sticky_window,
    cooldownWindow: row.cooldown_window,
    delayWindow: row.delay_window,
    enabled: row.enabled === 1,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json),
  };
}

function mapBranch(row: ChatBranchRow): ChatBranch {
  return {
    id: row.id,
    chatId: row.chat_id,
    parentBranchId: row.parent_branch_id,
    forkedFromMessageId: row.forked_from_message_id,
    label: row.label,
    createdAt: row.created_at,
  };
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    chatId: row.chat_id,
    branchId: row.branch_id,
    role: row.role as Message["role"],
    authorType: row.author_type as Message["authorType"],
    position: row.position,
    content: row.content,
    state: row.state as Message["state"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessageVariant(row: MessageVariantRow): MessageVariant {
  return {
    id: row.id,
    messageId: row.message_id,
    variantIndex: row.variant_index,
    content: row.content,
    isSelected: row.is_selected === 1,
    finishReason: row.finish_reason,
    createdAt: row.created_at,
  };
}

function mapSummary(row: SummaryRow): SummaryMemorySnapshot {
  return {
    id: row.id,
    chatId: row.chat_id,
    branchId: row.branch_id,
    kind: row.kind as SummaryMemorySnapshot["kind"],
    summary: row.summary,
    coversThroughMessageId: row.covers_through_message_id,
    createdAt: row.created_at,
  };
}

function mapPromptTrace(row: PromptTraceRow): PromptTrace {
  return {
    id: row.id,
    chatId: row.chat_id,
    branchId: row.branch_id,
    messageId: row.message_id,
    model: row.model,
    presetName: row.preset_name,
    assembledLayers: parseJson<PromptTrace["assembledLayers"]>(row.assembled_layers_json),
    tokenAccounting: parseJson<Record<string, number>>(row.token_accounting_json),
    activatedLoreEntries: parseJson<string[]>(row.activated_lore_entries_json),
    retrievedMemories: parseJson<Array<Record<string, unknown>>>(row.retrieved_memories_json),
    finalPayload: parseJson<Record<string, unknown>>(row.final_payload_json),
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
  };
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
