import type {
  Character,
  CharacterId,
  CharacterVersion,
  LoreEntry,
  LoreEntryId,
  Lorebook,
  LorebookId,
} from "@rp-platform/domain";
import { ENTITY_ID_NAMESPACE } from "@rp-platform/domain";
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
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FileStore,
  createFileStore,
  STORAGE_FOLDERS,
  hashCanonicalJson,
} from "./file-store.js";

const CHARACTER_FILE_SCHEMA_VERSION = 1;

type CanonicalCharacterFile = {
  schemaVersion: typeof CHARACTER_FILE_SCHEMA_VERSION;
  id: string;
  slug: string;
  name: string;
  description: string;
  personalitySummary: string | null;
  defaultScenario: string | null;
  firstMessage: string | null;
  mesExample: string | null;
  alternateGreetings: string[];
  postHistoryInstructions: string | null;
  creatorNotes: string | null;
  characterBook: Record<string, unknown> | null;
  depthPrompt: string | null;
  depthPromptDepth: number | null;
  depthPromptRole: string | null;
  extensions: Record<string, unknown>;
  systemPrompt: string | null;
  tags: string[];
  avatarAssetId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  source: Record<string, unknown> | null;
};

function characterToCanonicalFile(character: Character): CanonicalCharacterFile {
  return {
    schemaVersion: CHARACTER_FILE_SCHEMA_VERSION,
    id: character.id,
    slug: character.slug,
    name: character.name,
    description: character.description,
    personalitySummary: character.personalitySummary,
    defaultScenario: character.defaultScenario,
    firstMessage: character.firstMessage,
    mesExample: character.mesExample,
    alternateGreetings: character.alternateGreetings,
    postHistoryInstructions: character.postHistoryInstructions,
    creatorNotes: character.creatorNotes,
    characterBook: character.characterBook,
    depthPrompt: character.depthPrompt,
    depthPromptDepth: character.depthPromptDepth,
    depthPromptRole: character.depthPromptRole,
    extensions: character.extensions,
    systemPrompt: character.systemPrompt,
    tags: character.tags,
    avatarAssetId: character.avatarAssetId,
    status: character.status,
    createdAt: character.createdAt,
    updatedAt: character.updatedAt,
    source: null,
  };
}

function canonicalFileToCharacter(file: CanonicalCharacterFile): Character {
  return {
    id: file.id as CharacterId,
    slug: file.slug,
    name: file.name,
    description: file.description,
    personalitySummary: file.personalitySummary,
    defaultScenario: file.defaultScenario,
    firstMessage: file.firstMessage,
    mesExample: file.mesExample,
    alternateGreetings: file.alternateGreetings,
    postHistoryInstructions: file.postHistoryInstructions,
    creatorNotes: file.creatorNotes,
    characterBook: file.characterBook,
    depthPrompt: file.depthPrompt,
    depthPromptDepth: file.depthPromptDepth,
    depthPromptRole: file.depthPromptRole,
    extensions: file.extensions,
    systemPrompt: file.systemPrompt,
    tags: file.tags,
    avatarAssetId: file.avatarAssetId,
    status: file.status as Character["status"],
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}

type CharacterRowWithMeta = CharacterRow & {
  file_path: string | null;
  sync_status: string | null;
};

const CHARACTERS_PATH_SEGMENT = "characters/";

export interface CharacterSyncReport {
  synced: number;
  imported: number;
  renamed: number;
  missing: number;
  malformed: number;
  duplicate: number;
  conflict: number;
}

const LOREBOOK_FILE_SCHEMA_VERSION = 1;

type CanonicalLorebookEntryFile = {
  id: string;
  title: string;
  content: string;
  keys: string[];
  secondaryKeys: string[];
  logic: string;
  position: string;
  depth: number;
  priority: number;
  stickyWindow: number;
  cooldownWindow: number;
  delayWindow: number;
  enabled: boolean;
  metadata: Record<string, unknown>;
};

type CanonicalLorebookFile = {
  schemaVersion: typeof LOREBOOK_FILE_SCHEMA_VERSION;
  id: string;
  name: string;
  scopeType: string;
  description: string;
  scanDepth: number | null;
  tokenBudget: number | null;
  recursiveScanning: boolean | null;
  extensions: Record<string, unknown>;
  entries: CanonicalLorebookEntryFile[];
  createdAt: string;
  updatedAt: string;
};

function lorebookSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, "-").replace(/^-|-$/g, "") || "lorebook";
}

function loreEntryToCanonicalFileEntry(entry: LoreEntry): CanonicalLorebookEntryFile {
  return {
    id: entry.id,
    title: entry.title,
    content: entry.content,
    keys: entry.keys,
    secondaryKeys: entry.secondaryKeys,
    logic: entry.logic,
    position: entry.position,
    depth: entry.depth,
    priority: entry.priority,
    stickyWindow: entry.stickyWindow,
    cooldownWindow: entry.cooldownWindow,
    delayWindow: entry.delayWindow,
    enabled: entry.enabled,
    metadata: entry.metadata,
  };
}

const LOREBOOKS_PATH_SEGMENT = "lorebooks/";

export class SqliteCharacterStore {
  private readonly fileStore: FileStore;

  constructor(
    private readonly db: SqliteDatabaseAdapter,
    private readonly clock: StoreClock,
    private readonly idGenerator: StoreIdGenerator,
    fileStore?: FileStore,
  ) {
    this.fileStore = fileStore ?? createFileStore();
  }

  async upsertCharacter(input: Character): Promise<void> {
    const canonicalFile = characterToCanonicalFile(input);
    const relativeFileName = `${input.slug}.json`;
    const now = new Date().toISOString();

    let filePath: string | null = null;
    let fileHash: string | null = null;
    let fileMtime: string | null = null;
    let syncStatus = "db_dirty";
    let syncError: string | null = null;
    let lastSyncedAt: string | null = null;

    try {
      const absolutePath = this.fileStore.resolvePath(STORAGE_FOLDERS.characters, relativeFileName);
      fileHash = hashCanonicalJson(canonicalFile);
      await this.fileStore.asyncWriteJson(absolutePath, canonicalFile);
      filePath = `${CHARACTERS_PATH_SEGMENT}${input.slug}.json`;
      fileMtime = now;
      syncStatus = "synced";
      lastSyncedAt = now;
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err);
    }

    this.db.execute(
      `INSERT INTO characters (
        id, slug, name, description, personality_summary, default_scenario, first_message, mes_example, alternate_greetings_json,
        post_history_instructions, creator_notes, character_book_json, depth_prompt, depth_prompt_depth, depth_prompt_role,
        extensions_json, system_prompt, tags_json, avatar_asset_id, status, created_at, updated_at,
        file_path, file_hash, file_mtime, sync_status, sync_error, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?)
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
        updated_at = excluded.updated_at,
        file_path = excluded.file_path,
        file_hash = excluded.file_hash,
        file_mtime = excluded.file_mtime,
        sync_status = excluded.sync_status,
        sync_error = excluded.sync_error,
        last_synced_at = excluded.last_synced_at`,
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
        filePath,
        fileHash,
        fileMtime,
        syncStatus,
        syncError,
        lastSyncedAt,
      ],
    );
  }

  async upsertCharacterVersion(input: CharacterVersion): Promise<void> {
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

    if (input.isActive) {
      await this.updateCharacterFileSource(input.characterId, input.definition);
    }
  }

  upsertLorebook(input: Lorebook): void {
    const slug = lorebookSlug(input.name);
    const relativeFileName = `${input.scopeType}-${slug}.json`;
    const now = new Date().toISOString();

    let existingEntries: CanonicalLorebookEntryFile[] = [];
    let existingSettings: Pick<CanonicalLorebookFile, "scanDepth" | "tokenBudget" | "recursiveScanning" | "extensions"> = {
      scanDepth: null, tokenBudget: null, recursiveScanning: null, extensions: {},
    };
    const existingRow = this.db.queryOne<{ file_path: string | null }>(
      `SELECT file_path FROM lorebooks WHERE id = ?`,
      [input.id],
    );
    if (existingRow?.file_path) {
      const oldFile = this.readLorebookFileFromPath(existingRow.file_path);
      if (oldFile) {
        existingEntries = oldFile.entries;
        existingSettings = {
          scanDepth: oldFile.scanDepth,
          tokenBudget: oldFile.tokenBudget,
          recursiveScanning: oldFile.recursiveScanning,
          extensions: oldFile.extensions,
        };
      }
    }

    const canonicalFile: CanonicalLorebookFile = {
      schemaVersion: LOREBOOK_FILE_SCHEMA_VERSION,
      id: input.id,
      name: input.name,
      scopeType: input.scopeType,
      description: input.description,
      ...existingSettings,
      entries: existingEntries,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    };

    let filePath: string | null = null;
    let fileHash: string | null = null;
    let fileMtime: string | null = null;
    let syncStatus = "db_dirty";
    let syncError: string | null = null;
    let lastSyncedAt: string | null = null;

    try {
      const absolutePath = this.fileStore.resolvePath(STORAGE_FOLDERS.lorebooks, relativeFileName);
      fileHash = hashCanonicalJson(canonicalFile);
      this.fileStore.writeJson(absolutePath, canonicalFile);
      filePath = `${LOREBOOKS_PATH_SEGMENT}${relativeFileName}`;
      fileMtime = now;
      syncStatus = "synced";
      lastSyncedAt = now;
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err);
    }

    this.db.execute(
      `INSERT INTO lorebooks (
        id, name, scope_type, description, created_at, updated_at,
        file_path, file_hash, file_mtime, sync_status, sync_error, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        scope_type = excluded.scope_type,
        description = excluded.description,
        updated_at = excluded.updated_at,
        file_path = excluded.file_path,
        file_hash = excluded.file_hash,
        file_mtime = excluded.file_mtime,
        sync_status = excluded.sync_status,
        sync_error = excluded.sync_error,
        last_synced_at = excluded.last_synced_at`,
      [
        input.id,
        input.name,
        input.scopeType,
        input.description,
        input.createdAt,
        input.updatedAt,
        filePath,
        fileHash,
        fileMtime,
        syncStatus,
        syncError,
        lastSyncedAt,
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
    this.syncLorebookFile(lorebookId);
  }

  createLoreEntry(lorebookId: string, input: Omit<LoreEntry, "id" | "lorebookId">): LoreEntry {
    const entryId = this.idGenerator.next(ENTITY_ID_NAMESPACE.loreEntry) as LoreEntryId;
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

    this.syncLorebookFile(lorebookId);
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

    this.syncLorebookFile(current.lorebookId);
    return this.requireLoreEntry(entryId);
  }

  deleteLoreEntry(entryId: string): void {
    const entry = this.requireLoreEntry(entryId);
    const lorebookId = entry.lorebookId;
    this.db.execute(`DELETE FROM lore_entries WHERE id = ?`, [entryId]);
    this.syncLorebookFile(lorebookId);
  }

  linkCharacterLorebook(characterId: string, lorebookId: string): void {
    this.db.execute(
      `INSERT OR IGNORE INTO character_lorebooks (character_id, lorebook_id) VALUES (?, ?)`,
      [characterId, lorebookId],
    );
  }

  listCharacters(): Character[] {
    return this.db
      .queryAll<CharacterRowWithMeta>(
        `SELECT id, slug, name, description, personality_summary, default_scenario, first_message, mes_example, alternate_greetings_json,
                post_history_instructions, creator_notes, character_book_json, depth_prompt, depth_prompt_depth, depth_prompt_role,
                extensions_json, system_prompt, tags_json, avatar_asset_id, status, created_at, updated_at,
                file_path, sync_status
         FROM characters
         ORDER BY created_at ASC, id ASC`,
      )
      .map((row) => this.resolveCharacter(row));
  }

  getCharacter(characterId: CharacterId): Character | null {
    const row = this.db.queryOne<CharacterRowWithMeta>(
      `SELECT id, slug, name, description, personality_summary, default_scenario, first_message, mes_example, alternate_greetings_json,
              post_history_instructions, creator_notes, character_book_json, depth_prompt, depth_prompt_depth, depth_prompt_role,
              extensions_json, system_prompt, tags_json, avatar_asset_id, status, created_at, updated_at,
              file_path, sync_status
       FROM characters
       WHERE id = ?`,
      [characterId],
    );
    return row ? this.resolveCharacter(row) : null;
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

  async setCharacterStatus(characterId: CharacterId, status: "active" | "archived"): Promise<void> {
    const timestamp = this.clock.now();
    this.db.execute(
      `UPDATE characters SET status = ?, updated_at = ? WHERE id = ?`,
      [status, timestamp, characterId],
    );
    await this.updateCharacterFileProperty(characterId, (file) => {
      file.status = status;
      file.updatedAt = timestamp;
    });
  }

  deleteCharacter(characterId: CharacterId): void {
    const metaRow = this.db.queryOne<{ file_path: string | null }>(
      `SELECT file_path FROM characters WHERE id = ?`,
      [characterId],
    );

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

    if (metaRow?.file_path) {
      try {
        const absolutePath = this.fileStore.resolvePath(
          STORAGE_FOLDERS.characters,
          metaRow.file_path.slice(CHARACTERS_PATH_SEGMENT.length),
        );
        unlinkSync(absolutePath);
      } catch {}
    }
  }

  syncCharactersOnStartup(): CharacterSyncReport {
    const report: CharacterSyncReport = {
      synced: 0, imported: 0, renamed: 0,
      missing: 0, malformed: 0, duplicate: 0, conflict: 0,
    };

    const charactersDir = join(this.fileStore.dataRoot, STORAGE_FOLDERS.characters);
    let dirEntries: string[];
    try {
      dirEntries = readdirSync(charactersDir);
    } catch {
      this.markMissingFiles(new Set(), report);
      return report;
    }

    const jsonFiles = dirEntries.filter(
      e => e.endsWith(".json") && !e.startsWith("_") && !e.startsWith("."),
    );

    type MetaRow = { id: string; file_path: string | null; sync_status: string | null };
    const existingRows = this.db.queryAll<MetaRow>(
      `SELECT id, file_path, sync_status FROM characters`,
      [],
    );
    const existingById = new Map(existingRows.map(r => [r.id, r]));
    const seenIds = new Map<string, string>();
    const allEntries = new Set(dirEntries);

    for (const fileName of jsonFiles) {
      const relativePath = `${CHARACTERS_PATH_SEGMENT}${fileName}`;
      let file: CanonicalCharacterFile;
      try {
        const absolutePath = this.fileStore.resolvePath(STORAGE_FOLDERS.characters, fileName);
        file = this.fileStore.readJson<CanonicalCharacterFile>(absolutePath);
      } catch {
        report.malformed++;
        continue;
      }

      if (
        !file || typeof file !== "object" ||
        typeof file.schemaVersion !== "number" ||
        file.schemaVersion !== CHARACTER_FILE_SCHEMA_VERSION ||
        typeof file.id !== "string" || !file.id ||
        typeof file.slug !== "string" || !file.slug ||
        typeof file.name !== "string" || !file.name
      ) {
        report.malformed++;
        continue;
      }

      const firstFileName = seenIds.get(file.id);
      if (firstFileName) {
        report.duplicate++;
        this.writeConflictCopy(file, `duplicate-with-${firstFileName}`);
        continue;
      }
      seenIds.set(file.id, fileName);

      const existing = existingById.get(file.id);
      if (existing) {
        const pathChanged = existing.file_path !== null && existing.file_path !== relativePath;
        if (pathChanged) {
          const oldFileName = existing.file_path!.slice(CHARACTERS_PATH_SEGMENT.length);
          if (!allEntries.has(oldFileName)) {
            this.applyFileSync(existing.id, relativePath, file);
            report.renamed++;
          } else {
            report.conflict++;
            this.writeConflictCopy(file, `id-conflict`);
          }
        } else if (existing.sync_status === "db_dirty") {
          report.conflict++;
          this.writeConflictCopy(file, `db-dirty`);
        } else {
          this.applyFileSync(existing.id, relativePath, file);
          report.synced++;
        }
      } else {
        this.applyFileImport(relativePath, file);
        report.imported++;
      }
    }

    this.markMissingFiles(new Set(jsonFiles), report);
    return report;
  }

  private resolveCharacter(row: CharacterRowWithMeta): Character {
    if (row.file_path) {
      const fromFile = this.readCharacterFromFile(row.id, row.file_path);
      if (fromFile) return fromFile;
    }
    return mapCharacter(row);
  }

  private readCharacterFromFile(characterId: string, filePath: string): Character | null {
    try {
      const fileName = filePath.slice(CHARACTERS_PATH_SEGMENT.length);
      const absolutePath = this.fileStore.resolvePath(STORAGE_FOLDERS.characters, fileName);
      const file = this.fileStore.readJson<CanonicalCharacterFile>(absolutePath);
      if (
        file &&
        typeof file.schemaVersion === "number" &&
        file.schemaVersion === CHARACTER_FILE_SCHEMA_VERSION &&
        file.id === characterId
      ) {
        return canonicalFileToCharacter(file);
      }
      this.tryMarkSyncStatus(characterId, "malformed");
    } catch {
      this.tryMarkSyncStatus(characterId, "missing_file");
    }
    return null;
  }

  private tryMarkSyncStatus(characterId: string, syncStatus: string): void {
    try {
      this.db.execute(
        `UPDATE characters SET sync_status = ? WHERE id = ?`,
        [syncStatus, characterId],
      );
    } catch {}
  }

  private async updateCharacterFileProperty(
    characterId: string,
    mutate: (file: CanonicalCharacterFile) => void,
  ): Promise<void> {
    const row = this.db.queryOne<{ file_path: string | null }>(
      `SELECT file_path FROM characters WHERE id = ?`,
      [characterId],
    );
    if (!row?.file_path) return;
    try {
      const fileName = row.file_path.slice(CHARACTERS_PATH_SEGMENT.length);
      const absolutePath = this.fileStore.resolvePath(STORAGE_FOLDERS.characters, fileName);
      const file = this.fileStore.readJson<CanonicalCharacterFile>(absolutePath);
      mutate(file);
      await this.fileStore.asyncWriteJson(absolutePath, file);
    } catch {}
  }

  private async updateCharacterFileSource(
    characterId: string,
    definition: Record<string, unknown>,
  ): Promise<void> {
    const row = this.db.queryOne<{ file_path: string | null }>(
      `SELECT file_path FROM characters WHERE id = ?`,
      [characterId],
    );
    if (!row?.file_path) return;
    try {
      const fileName = row.file_path.slice(CHARACTERS_PATH_SEGMENT.length);
      const absolutePath = this.fileStore.resolvePath(STORAGE_FOLDERS.characters, fileName);
      const file = this.fileStore.readJson<CanonicalCharacterFile>(absolutePath);
      file.source = definition;
      await this.fileStore.asyncWriteJson(absolutePath, file);
      const fileHash = hashCanonicalJson(file);
      const now = new Date().toISOString();
      this.db.execute(
        `UPDATE characters SET file_hash = ?, sync_status = 'synced', last_synced_at = ? WHERE id = ?`,
        [fileHash, now, characterId],
      );
    } catch {}
  }

  private writeConflictCopy(file: CanonicalCharacterFile, reason: string): void {
    try {
      const conflictsDir = join(this.fileStore.dataRoot, "_conflicts");
      mkdirSync(conflictsDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const conflictName = `${ts}-character-${file.id}-${reason}.json`;
      writeFileSync(join(conflictsDir, conflictName), JSON.stringify(file, null, 2), "utf-8");
    } catch {}
  }

  private applyFileSync(characterId: string, relativePath: string, file: CanonicalCharacterFile): void {
    const now = new Date().toISOString();
    const fileHash = hashCanonicalJson(file);
    try {
      this.db.execute(
        `UPDATE characters SET
          slug = ?, name = ?, description = ?, personality_summary = ?, default_scenario = ?,
          first_message = ?, mes_example = ?, alternate_greetings_json = ?,
          post_history_instructions = ?, creator_notes = ?, character_book_json = ?,
          depth_prompt = ?, depth_prompt_depth = ?, depth_prompt_role = ?,
          extensions_json = ?, system_prompt = ?, tags_json = ?,
          avatar_asset_id = ?, status = ?,
          file_path = ?, file_hash = ?, file_mtime = ?, sync_status = 'synced',
          sync_error = NULL, last_synced_at = ?, updated_at = ?
        WHERE id = ?`,
        [
          file.slug, file.name, file.description, file.personalitySummary, file.defaultScenario,
          file.firstMessage, file.mesExample, JSON.stringify(file.alternateGreetings),
          file.postHistoryInstructions, file.creatorNotes,
          file.characterBook ? JSON.stringify(file.characterBook) : null,
          file.depthPrompt, file.depthPromptDepth, file.depthPromptRole,
          JSON.stringify(file.extensions), file.systemPrompt, JSON.stringify(file.tags),
          file.avatarAssetId, file.status,
          relativePath, fileHash, now, now, now,
          characterId,
        ],
      );
    } catch {
      this.writeConflictCopy(file, `sync-failed`);
    }
  }

  private applyFileImport(relativePath: string, file: CanonicalCharacterFile): void {
    const now = new Date().toISOString();
    const fileHash = hashCanonicalJson(file);
    try {
      this.db.execute(
        `INSERT INTO characters (
          id, slug, name, description, personality_summary, default_scenario, first_message, mes_example, alternate_greetings_json,
          post_history_instructions, creator_notes, character_book_json, depth_prompt, depth_prompt_depth, depth_prompt_role,
          extensions_json, system_prompt, tags_json, avatar_asset_id, status, created_at, updated_at,
          file_path, file_hash, file_mtime, sync_status, sync_error, last_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?)`,
        [
          file.id, file.slug, file.name, file.description, file.personalitySummary, file.defaultScenario,
          file.firstMessage, file.mesExample, JSON.stringify(file.alternateGreetings),
          file.postHistoryInstructions, file.creatorNotes,
          file.characterBook ? JSON.stringify(file.characterBook) : null,
          file.depthPrompt, file.depthPromptDepth, file.depthPromptRole,
          JSON.stringify(file.extensions), file.systemPrompt, JSON.stringify(file.tags),
          file.avatarAssetId, file.status || "active",
          file.createdAt || now, file.updatedAt || now,
          relativePath, fileHash, now, "synced", null, now,
        ],
      );
    } catch {
      this.writeConflictCopy(file, `import-failed`);
    }
  }

  private markMissingFiles(jsonFileSet: Set<string>, report: CharacterSyncReport): void {
    type PathRow = { id: string; file_path: string; sync_status: string | null };
    const rowsWithPaths = this.db.queryAll<PathRow>(
      `SELECT id, file_path, sync_status FROM characters WHERE file_path IS NOT NULL`,
      [],
    );
    for (const row of rowsWithPaths) {
      if (row.sync_status === "missing_file") continue;
      const fileName = row.file_path.slice(CHARACTERS_PATH_SEGMENT.length);
      if (!jsonFileSet.has(fileName)) {
        this.db.execute(
          `UPDATE characters SET sync_status = 'missing_file', sync_error = 'File not found during startup sync' WHERE id = ?`,
          [row.id],
        );
        report.missing++;
      }
    }
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

  private syncLorebookFile(lorebookId: string): void {
    const row = this.db.queryOne<{
      id: string;
      name: string;
      scope_type: string;
      description: string;
      created_at: string;
      updated_at: string;
      file_path: string | null;
    }>(
      `SELECT id, name, scope_type, description, created_at, updated_at, file_path FROM lorebooks WHERE id = ?`,
      [lorebookId],
    );
    if (!row) return;

    const entries = this.listLoreEntriesForLorebook(lorebookId);

    let scanDepth: number | null = null;
    let tokenBudget: number | null = null;
    let recursiveScanning: boolean | null = null;
    let extensions: Record<string, unknown> = {};

    if (row.file_path) {
      const existingFile = this.readLorebookFileFromPath(row.file_path);
      if (existingFile) {
        scanDepth = existingFile.scanDepth;
        tokenBudget = existingFile.tokenBudget;
        recursiveScanning = existingFile.recursiveScanning;
        extensions = existingFile.extensions;
      }
    }

    const canonicalFile: CanonicalLorebookFile = {
      schemaVersion: LOREBOOK_FILE_SCHEMA_VERSION,
      id: row.id,
      name: row.name,
      scopeType: row.scope_type,
      description: row.description,
      scanDepth,
      tokenBudget,
      recursiveScanning,
      extensions,
      entries: entries.map(loreEntryToCanonicalFileEntry),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    const slug = lorebookSlug(row.name);
    const relativeFileName = `${row.scope_type}-${slug}.json`;
    const now = new Date().toISOString();

    let filePath: string | null = null;
    let fileHash: string | null = null;
    let syncStatus = "db_dirty";
    let syncError: string | null = null;

    try {
      const absolutePath = this.fileStore.resolvePath(STORAGE_FOLDERS.lorebooks, relativeFileName);
      fileHash = hashCanonicalJson(canonicalFile);
      this.fileStore.writeJson(absolutePath, canonicalFile);
      filePath = `${LOREBOOKS_PATH_SEGMENT}${relativeFileName}`;
      syncStatus = "synced";
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err);
    }

    this.db.execute(
      `UPDATE lorebooks SET file_path = ?, file_hash = ?, file_mtime = ?, sync_status = ?, sync_error = ?, last_synced_at = ? WHERE id = ?`,
      [filePath, fileHash, now, syncStatus, syncError, now, lorebookId],
    );
  }

  private readLorebookFileFromPath(filePath: string): CanonicalLorebookFile | null {
    try {
      const fileName = filePath.slice(LOREBOOKS_PATH_SEGMENT.length);
      const absolutePath = this.fileStore.resolvePath(STORAGE_FOLDERS.lorebooks, fileName);
      const file = this.fileStore.readJson<CanonicalLorebookFile>(absolutePath);
      if (
        file &&
        typeof file.schemaVersion === "number" &&
        file.schemaVersion === LOREBOOK_FILE_SCHEMA_VERSION
      ) {
        return file;
      }
    } catch {}
    return null;
  }

  private listLoreEntriesForLorebook(lorebookId: string): LoreEntry[] {
    return this.db
      .queryAll<LoreEntryRow>(
        `SELECT id, lorebook_id, title, content, keys_json, secondary_keys_json,
                logic, position, depth, priority, sticky_window, cooldown_window,
                delay_window, enabled, metadata_json
         FROM lore_entries
         WHERE lorebook_id = ?
         ORDER BY priority DESC, id ASC`,
        [lorebookId],
      )
      .map(mapLoreEntry);
  }
}
