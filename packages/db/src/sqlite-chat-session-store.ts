import type {
  Chat,
  ChatBranch,
  ChatBranchId,
  ChatId,
  Character,
  CharacterId,
  CharacterVersion,
  GenerationPreset,
  GenerationPresetId,
  LoreEntry,
  Lorebook,
  LorebookId,
  Message,
  MessageId,
  MessageVariant,
  MessageVariantId,
  Persona,
  PersonaId,
  PromptPreset,
  PromptPresetId,
  PromptTrace,
  PromptTraceId,
  SummaryMemorySnapshot,
  ToolProfile,
  ToolProfileId,
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
  mes_example: string | null;
  alternate_greetings_json: string;
  post_history_instructions: string | null;
  creator_notes: string | null;
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

type PromptPresetRow = SqliteRow & {
  id: string;
  name: string;
  bind_model: string;
  system: string;
  jailbreak: string;
  summary: string;
  tools: string;
  created_at: string;
  updated_at: string;
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
        id, slug, name, description, default_scenario, mes_example, alternate_greetings_json,
        post_history_instructions, creator_notes, avatar_asset_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        slug = excluded.slug,
        name = excluded.name,
        description = excluded.description,
        default_scenario = excluded.default_scenario,
        mes_example = excluded.mes_example,
        alternate_greetings_json = excluded.alternate_greetings_json,
        post_history_instructions = excluded.post_history_instructions,
        creator_notes = excluded.creator_notes,
        avatar_asset_id = excluded.avatar_asset_id,
        status = excluded.status,
        updated_at = excluded.updated_at`,
      [
        input.id,
        input.slug,
        input.name,
        input.description,
        input.defaultScenario,
        input.mesExample,
        JSON.stringify(input.alternateGreetings),
        input.postHistoryInstructions,
        input.creatorNotes,
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

  getPersona(personaId: PersonaId): Persona | null {
    const row = this.db.queryOne<PersonaRow>(
      `SELECT
         id, name, description, pronouns, avatar_asset_id, default_for_new_chats, created_at, updated_at
       FROM personas
       WHERE id = ?`,
      [personaId],
    );

    if (!row) {
      return null;
    }

    return {
      id: row.id as PersonaId,
      name: row.name,
      description: row.description,
      pronouns: row.pronouns,
      avatarAssetId: row.avatar_asset_id,
      defaultForNewChats: Boolean(row.default_for_new_chats),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
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

  createPersona(input: { name: string; description: string; pronouns: string | null; defaultForNewChats: boolean }): Persona {
    return this.db.transaction(() => {
      const timestamp = this.clock.now();
      const id = this.idGenerator.next("persona") as PersonaId;
      this.db.execute(
        `INSERT INTO personas (
          id, name, description, pronouns, avatar_asset_id, default_for_new_chats, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.name,
          input.description,
          input.pronouns,
          null,
          input.defaultForNewChats ? 1 : 0,
          timestamp,
          timestamp,
        ],
      );
      return {
        id,
        name: input.name,
        description: input.description,
        pronouns: input.pronouns,
        avatarAssetId: null,
        defaultForNewChats: input.defaultForNewChats,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    });
  }

  deletePersona(personaId: PersonaId): void {
    this.db.transaction(() => {
      const exists = this.db.queryOne(`SELECT 1 FROM personas WHERE id = ?`, [personaId]);
      if (!exists) {
        throw new Error(`Persona '${personaId}' was not found.`);
      }
      const referencingChats = this.db.queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM chats WHERE persona_id = ?`,
        [personaId],
      );
      if ((referencingChats?.n ?? 0) > 0) {
        throw new Error(`Persona '${personaId}' is referenced by one or more chats and cannot be deleted.`);
      }
      this.db.execute(`DELETE FROM personas WHERE id = ?`, [personaId]);
    });
  }

  countChatsForPersona(personaId: PersonaId): number {
    const row = this.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM chats WHERE persona_id = ?`,
      [personaId],
    );
    return row?.n ?? 0;
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

  getPersonalLorebookForPersona(personaId: PersonaId): { lorebookId: LorebookId } | null {
    const row = this.db.queryOne<{ id: string }>(
      `SELECT lb.id AS id
       FROM persona_lorebooks pl
       JOIN lorebooks lb ON lb.id = pl.lorebook_id
       WHERE pl.persona_id = ?
         AND lb.scope_type = 'persona'
         AND lb.name = ?
       LIMIT 1`,
      [personaId, `__personal__:${personaId}`],
    );
    return row ? { lorebookId: row.id as LorebookId } : null;
  }

  enablePersonalLorebookForPersona(personaId: PersonaId, name: string): { lorebookId: LorebookId } {
    return this.db.transaction(() => {
      const personaExists = this.db.queryOne(`SELECT 1 FROM personas WHERE id = ?`, [personaId]);
      if (!personaExists) {
        throw new Error(`Persona '${personaId}' was not found.`);
      }
      const existing = this.getPersonalLorebookForPersona(personaId);
      if (existing) return existing;
      const timestamp = this.clock.now();
      const lorebookId = this.idGenerator.next("lorebook") as LorebookId;
      this.db.execute(
        `INSERT INTO lorebooks (id, name, scope_type, description, created_at, updated_at)
         VALUES (?, ?, 'persona', ?, ?, ?)`,
        [lorebookId, name, "Personal lorebook auto-created for persona.", timestamp, timestamp],
      );
      this.db.execute(
        `INSERT INTO persona_lorebooks (persona_id, lorebook_id) VALUES (?, ?)`,
        [personaId, lorebookId],
      );
      return { lorebookId };
    });
  }

  disablePersonalLorebookForPersona(personaId: PersonaId): void {
    this.db.transaction(() => {
      const existing = this.getPersonalLorebookForPersona(personaId);
      if (!existing) return;
      this.db.execute(
        `DELETE FROM persona_lorebooks WHERE persona_id = ? AND lorebook_id = ?`,
        [personaId, existing.lorebookId],
      );
      this.db.execute(`DELETE FROM lorebooks WHERE id = ?`, [existing.lorebookId]);
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

  getGenerationPreset(id: GenerationPresetId): GenerationPreset | null {
    const row = this.db.queryOne<SqliteRow & any>(
      `SELECT
         id, name, temperature, top_p, top_k, presence_penalty, frequency_penalty,
         max_output_tokens, system_style_note, metadata_json
       FROM generation_presets
       WHERE id = ?`,
      [id],
    );

    if (!row) return null;

    return {
      id: row.id as GenerationPresetId,
      name: row.name,
      temperature: row.temperature,
      topP: row.top_p,
      topK: row.top_k,
      presencePenalty: row.presence_penalty,
      frequencyPenalty: row.frequency_penalty,
      maxOutputTokens: row.max_output_tokens,
      systemStyleNote: row.system_style_note,
      metadata: JSON.parse(row.metadata_json),
    };
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

  getToolProfile(id: ToolProfileId): ToolProfile | null {
    const row = this.db.queryOne<SqliteRow & any>(
      `SELECT
         id, name, mode, instructions, metadata_json
       FROM tool_profiles
       WHERE id = ?`,
      [id],
    );

    if (!row) return null;

    return {
      id: row.id as ToolProfileId,
      name: row.name,
      mode: row.mode as ToolProfile["mode"],
      instructions: row.instructions,
      metadata: JSON.parse(row.metadata_json),
    };
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

  createLoreEntry(lorebookId: string, input: Omit<LoreEntry, "id" | "lorebookId">): LoreEntry {
    const entryId = this.idGenerator.next("lore_entry");
    this.db.execute(
      `INSERT INTO lore_entries (
        id, lorebook_id, title, content, keys_json, secondary_keys_json, logic,
        position, depth, priority, sticky_window, cooldown_window, delay_window, enabled, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entryId,
        lorebookId,
        input.title,
        input.content,
        JSON.stringify(input.keys),
        JSON.stringify(input.secondaryKeys),
        input.logic,
        input.position,
        input.depth,
        input.priority,
        input.stickyWindow,
        input.cooldownWindow,
        input.delayWindow,
        input.enabled ? 1 : 0,
        JSON.stringify(input.metadata),
      ],
    );

    return this.requireLoreEntry(entryId);
  }

  updateLoreEntry(entryId: string, input: Partial<Omit<LoreEntry, "id" | "lorebookId">>): LoreEntry {
    const current = this.requireLoreEntry(entryId);
    const updated: LoreEntry = {
      ...current,
      ...input,
      keys: input.keys ?? current.keys,
      secondaryKeys: input.secondaryKeys ?? current.secondaryKeys,
      metadata: input.metadata ?? current.metadata,
    };

    this.db.execute(
      `UPDATE lore_entries SET
        title = ?,
        content = ?,
        keys_json = ?,
        secondary_keys_json = ?,
        logic = ?,
        position = ?,
        depth = ?,
        priority = ?,
        sticky_window = ?,
        cooldown_window = ?,
        delay_window = ?,
        enabled = ?,
        metadata_json = ?
      WHERE id = ?`,
      [
        updated.title,
        updated.content,
        JSON.stringify(updated.keys),
        JSON.stringify(updated.secondaryKeys),
        updated.logic,
        updated.position,
        updated.depth,
        updated.priority,
        updated.stickyWindow,
        updated.cooldownWindow,
        updated.delayWindow,
        updated.enabled ? 1 : 0,
        JSON.stringify(updated.metadata),
        entryId,
      ],
    );

    return this.requireLoreEntry(entryId);
  }

  deleteLoreEntry(entryId: string): void {
    this.db.execute(`DELETE FROM lore_entries WHERE id = ?`, [entryId]);
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
        `SELECT id, slug, name, description, default_scenario, mes_example, alternate_greetings_json,
                post_history_instructions, creator_notes, avatar_asset_id, status, created_at, updated_at
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

  setCharacterStatus(characterId: CharacterId, status: "active" | "archived"): void {
    const timestamp = this.clock.now();
    this.db.execute(
      `UPDATE characters SET status = ?, updated_at = ? WHERE id = ?`,
      [status, timestamp, characterId],
    );
  }

  deleteCharacter(characterId: CharacterId): void {
    this.db.transaction(() => {
      this.db.execute(
        `DELETE FROM prompt_traces WHERE chat_id IN (SELECT id FROM chats WHERE character_id = ?)`,
        [characterId],
      );
      this.db.execute(
        `DELETE FROM message_variants WHERE message_id IN (SELECT m.id FROM messages m INNER JOIN chats c ON c.id = m.chat_id WHERE c.character_id = ?)`,
        [characterId],
      );
      this.db.execute(
        `DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE character_id = ?)`,
        [characterId],
      );
      this.db.execute(
        `DELETE FROM summary_memory_snapshots WHERE chat_id IN (SELECT id FROM chats WHERE character_id = ?)`,
        [characterId],
      );
      this.db.execute(
        `DELETE FROM chat_branches WHERE chat_id IN (SELECT id FROM chats WHERE character_id = ?)`,
        [characterId],
      );
      this.db.execute(
        `DELETE FROM retrieved_memory_hits WHERE chat_id IN (SELECT id FROM chats WHERE character_id = ?)`,
        [characterId],
      );
      this.db.execute(
        `DELETE FROM chat_capabilities WHERE chat_id IN (SELECT id FROM chats WHERE character_id = ?)`,
        [characterId],
      );
      this.db.execute(
        `DELETE FROM chat_lorebooks WHERE chat_id IN (SELECT id FROM chats WHERE character_id = ?)`,
        [characterId],
      );
      this.db.execute(
        `DELETE FROM chats WHERE character_id = ?`,
        [characterId],
      );
      this.db.execute(
        `DELETE FROM character_lorebooks WHERE character_id = ?`,
        [characterId],
      );
      this.db.execute(
        `DELETE FROM character_versions WHERE character_id = ?`,
        [characterId],
      );
      this.db.execute(
        `DELETE FROM characters WHERE id = ?`,
        [characterId],
      );
    });
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

  mergeBranch(input: { chatId: ChatId; sourceBranchId: ChatBranchId; targetBranchId: ChatBranchId }): { appendedMessageCount: number; activeBranchId: ChatBranchId } {
    return this.db.transaction(() => {
      const chat = this.requireChat(input.chatId);
      this.requireBranch(input.chatId, input.sourceBranchId);
      this.requireBranch(input.chatId, input.targetBranchId);

      if (input.sourceBranchId === input.targetBranchId) {
        throw new Error("Source branch and target branch must be different.");
      }

      const timestamp = this.clock.now();
      const sourceMessages = this.listMessagesForBranch(input.sourceBranchId);
      const startPosition = this.nextMessagePosition(input.targetBranchId);
      const copiedMessageIds = new Map<MessageId, MessageId>();

      sourceMessages.forEach((message, index) => {
        const nextId = this.idGenerator.next("msg") as MessageId;
        copiedMessageIds.set(message.id, nextId);
        this.db.execute(
          `INSERT INTO messages (
            id, chat_id, branch_id, role, author_type, position, content, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            nextId,
            input.chatId,
            input.targetBranchId,
            message.role,
            message.authorType,
            startPosition + index,
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

      this.db.execute(
        `UPDATE chats SET active_branch_id = ?, updated_at = ? WHERE id = ?`,
        [input.targetBranchId, timestamp, chat.id],
      );

      return {
        appendedMessageCount: sourceMessages.length,
        activeBranchId: input.targetBranchId,
      };
    });
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
      const newChatId = this.idGenerator.next("chat") as ChatId;
      const newRootBranchId = this.idGenerator.next("branch") as ChatBranchId;

      this.db.execute(
        `INSERT INTO chats (
          id, character_id, persona_id, title, status, active_branch_id,
          generation_preset_id, tool_profile_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newChatId,
          sourceChat.characterId,
          sourceChat.personaId,
          title ?? `${sourceChat.title} (copy)`,
          "active",
          newRootBranchId,
          sourceChat.generationPresetId,
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
        const nextId = this.idGenerator.next("msg") as MessageId;
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

  // Provider Profiles
  upsertProviderProfile(profile: any): void {
    const timestamp = this.clock.now();
    const id = profile.id || (this.idGenerator.next("provider") as string);
    const isActive = profile.isActive === true ? 1 : 0;
    this.db.execute(
      `INSERT INTO provider_profiles (
        id, name, type, endpoint, api_key, default_model, context_budget, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        isActive,
        profile.createdAt || timestamp,
        timestamp,
      ],
    );
  }

  listProviderProfiles(): any[] {
    return this.db.queryAll<any>(
      `SELECT id, name, type, endpoint, api_key as apiKey, default_model as defaultModel,
              context_budget as contextBudget, is_active as isActiveInt,
              created_at as createdAt, updated_at as updatedAt
       FROM provider_profiles
       ORDER BY name ASC`,
    ).map((row) => ({ ...row, isActive: row.isActiveInt === 1 }));
  }

  getProviderProfile(id: string): any | null {
    const row = this.db.queryOne<any>(
      `SELECT id, name, type, endpoint, api_key as apiKey, default_model as defaultModel,
              context_budget as contextBudget, is_active as isActiveInt,
              created_at as createdAt, updated_at as updatedAt
       FROM provider_profiles
       WHERE id = ?`,
      [id],
    );
    return row ? { ...row, isActive: row.isActiveInt === 1 } : null;
  }

  deleteProviderProfile(id: string): void {
    this.db.execute(`DELETE FROM provider_profiles WHERE id = ?`, [id]);
  }

  setActiveProviderProfile(id: string): void {
    this.db.transaction(() => {
      const exists = this.db.queryOne(`SELECT 1 FROM provider_profiles WHERE id = ?`, [id]);
      if (!exists) {
        throw new Error(`Provider profile '${id}' was not found.`);
      }
      this.db.execute(`UPDATE provider_profiles SET is_active = 0 WHERE is_active = 1`, []);
      this.db.execute(`UPDATE provider_profiles SET is_active = 1 WHERE id = ?`, [id]);
    });
  }

  getActiveProviderProfile(): any | null {
    const row = this.db.queryOne<any>(
      `SELECT id, name, type, endpoint, api_key as apiKey, default_model as defaultModel,
              context_budget as contextBudget, is_active as isActiveInt,
              created_at as createdAt, updated_at as updatedAt
       FROM provider_profiles
       WHERE is_active = 1
       LIMIT 1`,
    );
    return row ? { ...row, isActive: true } : null;
  }

  listPromptPresets(): PromptPreset[] {
    return this.db
      .queryAll<PromptPresetRow>(
        `SELECT id, name, bind_model, system, jailbreak, summary, tools, created_at, updated_at
         FROM prompt_presets
         ORDER BY name ASC`,
      )
      .map(mapPromptPreset);
  }

  getPromptPreset(presetId: PromptPresetId): PromptPreset | null {
    const row = this.db.queryOne<PromptPresetRow>(
      `SELECT id, name, bind_model, system, jailbreak, summary, tools, created_at, updated_at
       FROM prompt_presets WHERE id = ?`,
      [presetId],
    );
    return row ? mapPromptPreset(row) : null;
  }

  createPromptPreset(input: { name: string; bindModel: string; system: string; jailbreak: string; summary: string; tools: string }): PromptPreset {
    return this.db.transaction(() => {
      const timestamp = this.clock.now();
      const id = this.idGenerator.next("prompt_preset") as PromptPresetId;
      this.db.execute(
        `INSERT INTO prompt_presets (id, name, bind_model, system, jailbreak, summary, tools, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.name, input.bindModel, input.system, input.jailbreak, input.summary, input.tools, timestamp, timestamp],
      );
      return { id, ...input, createdAt: timestamp, updatedAt: timestamp };
    });
  }

  updatePromptPreset(presetId: PromptPresetId, patch: Partial<Omit<PromptPreset, "id" | "createdAt" | "updatedAt">>): PromptPreset {
    return this.db.transaction(() => {
      const current = this.getPromptPreset(presetId);
      if (!current) {
        throw new Error(`Prompt preset '${presetId}' was not found.`);
      }
      const next = { ...current, ...patch };
      const timestamp = this.clock.now();
      this.db.execute(
        `UPDATE prompt_presets SET name = ?, bind_model = ?, system = ?, jailbreak = ?, summary = ?, tools = ?, updated_at = ? WHERE id = ?`,
        [next.name, next.bindModel, next.system, next.jailbreak, next.summary, next.tools, timestamp, presetId],
      );
      return { ...next, updatedAt: timestamp };
    });
  }

  deletePromptPreset(presetId: PromptPresetId): void {
    this.db.transaction(() => {
      const exists = this.db.queryOne(`SELECT 1 FROM prompt_presets WHERE id = ?`, [presetId]);
      if (!exists) {
        throw new Error(`Prompt preset '${presetId}' was not found.`);
      }
      this.db.execute(`DELETE FROM prompt_presets WHERE id = ?`, [presetId]);
    });
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

  private requireLoreEntry(entryId: string): LoreEntry {
    const row = this.db.queryOne<LoreEntryRow>(
      `SELECT id, lorebook_id, title, content, keys_json, secondary_keys_json, logic,
              position, depth, priority, sticky_window, cooldown_window, delay_window, enabled, metadata_json
       FROM lore_entries
       WHERE id = ?`,
      [entryId],
    );
    if (!row) {
      throw new Error(`Lore entry '${entryId}' was not found.`);
    }
    return mapLoreEntry(row);
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
    mesExample: row.mes_example,
    alternateGreetings: parseJson<string[]>(row.alternate_greetings_json),
    postHistoryInstructions: row.post_history_instructions,
    creatorNotes: row.creator_notes,
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

function mapPromptPreset(row: PromptPresetRow): PromptPreset {
  return {
    id: row.id as PromptPresetId,
    name: row.name,
    bindModel: row.bind_model,
    system: row.system,
    jailbreak: row.jailbreak,
    summary: row.summary,
    tools: row.tools,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
