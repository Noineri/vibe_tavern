import type {
  Character,
  CharacterId,
  CharacterVersion,
  LoreEntry,
  Lorebook,
  LorebookId,
} from "@rp-platform/domain";
import type {
  CharacterRow,
  CharacterVersionRow,
  LoreEntryRow,
} from "./sqlite-chat-session-mappers.js";
import {
  mapCharacter,
  mapCharacterVersion,
  mapLoreEntry,
} from "./sqlite-chat-session-mappers.js";
import type { SqliteDatabaseAdapter, SqliteRow } from "./sqlite-adapter.js";
import type { StoreClock, StoreIdGenerator } from "./persistence.js";

export class SqliteCharacterStore {
  constructor(
    private readonly db: SqliteDatabaseAdapter,
    private readonly clock: StoreClock,
    private readonly idGenerator: StoreIdGenerator,
  ) {}

  upsertCharacter(input: Character): void {
    this.db.execute(
      `INSERT INTO characters (
        id, slug, name, description, personality_summary, default_scenario, first_message, mes_example, alternate_greetings_json,
        post_history_instructions, creator_notes, character_book_json, depth_prompt, depth_prompt_depth, depth_prompt_role,
        extensions_json, system_prompt, tags_json, avatar_asset_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        slug = excluded.slug,
        name = excluded.name,
        description = excluded.description,
        personality_summary = excluded.personality_summary,
        default_scenario = excluded.default_scenario,
        first_message = excluded.first_message,
        mes_example = excluded.mes_example,
        alternate_greetings_json = excluded.alternate_greetings_json,
        post_history_instructions = excluded.post_history_instructions,
        creator_notes = excluded.creator_notes,
        character_book_json = excluded.character_book_json,
        depth_prompt = excluded.depth_prompt,
        depth_prompt_depth = excluded.depth_prompt_depth,
        depth_prompt_role = excluded.depth_prompt_role,
        extensions_json = excluded.extensions_json,
        system_prompt = excluded.system_prompt,
        tags_json = excluded.tags_json,
        avatar_asset_id = excluded.avatar_asset_id,
        status = excluded.status,
        updated_at = excluded.updated_at`,
      [
        input.id,
        input.slug,
        input.name,
        input.description,
        input.personalitySummary,
        input.defaultScenario,
        input.firstMessage,
        input.mesExample,
        JSON.stringify(input.alternateGreetings),
        input.postHistoryInstructions,
        input.creatorNotes,
        input.characterBook ? JSON.stringify(input.characterBook) : null,
        input.depthPrompt,
        input.depthPromptDepth,
        input.depthPromptRole,
        JSON.stringify(input.extensions),
        input.systemPrompt,
        JSON.stringify(input.tags),
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
        `SELECT id, slug, name, description, personality_summary, default_scenario, first_message, mes_example, alternate_greetings_json,
                post_history_instructions, creator_notes, character_book_json, depth_prompt, depth_prompt_depth, depth_prompt_role,
                extensions_json, system_prompt, tags_json, avatar_asset_id, status, created_at, updated_at
         FROM characters
         ORDER BY created_at ASC, id ASC`,
      )
      .map(mapCharacter);
  }

  getCharacter(characterId: CharacterId): Character | null {
    const row = this.db.queryOne<CharacterRow>(
      `SELECT id, slug, name, description, personality_summary, default_scenario, first_message, mes_example, alternate_greetings_json,
              post_history_instructions, creator_notes, character_book_json, depth_prompt, depth_prompt_depth, depth_prompt_role,
              extensions_json, system_prompt, tags_json, avatar_asset_id, status, created_at, updated_at
       FROM characters
       WHERE id = ?`,
      [characterId],
    );
    return row ? mapCharacter(row) : null;
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
}
