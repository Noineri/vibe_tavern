import type {
  PromptPreset,
  PromptPresetId,
  ToolProfile,
  ToolProfileId,
} from "@rp-platform/domain";
import { ENTITY_ID_NAMESPACE } from "@rp-platform/domain";

import type { PromptPresetRow } from "./sqlite-chat-session-mappers.js";
import { mapPromptPreset } from "./sqlite-chat-session-mappers.js";
import type { SqliteDatabaseAdapter, SqliteRow } from "./sqlite-adapter.js";
import type { StoreClock, StoreIdGenerator } from "./persistence.js";
import {
  type FileStore,
  createFileStore,
  STORAGE_FOLDERS,
  hashCanonicalJson,
} from "./file-store.js";

const PROMPT_PRESET_FILE_SCHEMA_VERSION = 1;

type CanonicalPromptPresetFile = {
  schemaVersion: typeof PROMPT_PRESET_FILE_SCHEMA_VERSION;
  id: string;
  name: string;
  bindModel: string;
  system: string;
  jailbreak: string;
  summary: string;
  tools: string;
  createdAt: string;
  updatedAt: string;
};

function presetToCanonicalFile(preset: PromptPreset): CanonicalPromptPresetFile {
  return {
    schemaVersion: PROMPT_PRESET_FILE_SCHEMA_VERSION,
    id: preset.id,
    name: preset.name,
    bindModel: preset.bindModel,
    system: preset.system,
    jailbreak: preset.jailbreak,
    summary: preset.summary,
    tools: preset.tools,
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt,
  };
}

function canonicalFileToPreset(file: CanonicalPromptPresetFile): PromptPreset {
  return {
    id: file.id as PromptPresetId,
    name: file.name,
    bindModel: file.bindModel,
    system: file.system,
    jailbreak: file.jailbreak,
    summary: file.summary,
    tools: file.tools,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}

function presetSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-zа-яё0-9\-]/gi, "") || "preset";
}

const PRESETS_PATH_SEGMENT = "promptPresets/";

type GenerationPresetId = string;
type GenerationPreset = {
  id: GenerationPresetId;
  name: string;
  providerType: string;
  settings: Record<string, unknown>;
};

export class SqliteProviderStore {
  private readonly fileStore: FileStore;

  constructor(
    private readonly db: SqliteDatabaseAdapter,
    private readonly clock: StoreClock,
    private readonly idGenerator: StoreIdGenerator,
    fileStore?: FileStore,
  ) {
    this.fileStore = fileStore ?? createFileStore();
  }

  upsertGenerationPreset(input: GenerationPreset): void {
    this.db.execute(
      `INSERT INTO generation_presets (
        id, name, provider_type, settings_json
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        provider_type = excluded.provider_type,
        settings_json = excluded.settings_json`,
      [
        input.id,
        input.name,
        input.providerType,
        JSON.stringify(input.settings),
      ],
    );
  }

  getGenerationPreset(id: GenerationPresetId): GenerationPreset | null {
    const row = this.db.queryOne<SqliteRow & any>(
      `SELECT
         id, name, provider_type, settings_json
       FROM generation_presets
       WHERE id = ?`,
      [id],
    );

    if (!row) return null;

    return {
      id: row.id as GenerationPresetId,
      name: row.name,
      providerType: row.provider_type as GenerationPreset["providerType"],
      settings: JSON.parse(row.settings_json),
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

  upsertProviderProfile(profile: any): void {
    const timestamp = this.clock.now();
    const id = profile.id || (this.idGenerator.next(ENTITY_ID_NAMESPACE.providerProfile) as string);
    const isActive = profile.isActive === true ? 1 : 0;
    this.db.execute(
      `INSERT INTO provider_profiles (
        id, name, type, endpoint, api_key, default_model, context_budget, is_active,
        temperature, top_p, min_p, top_k, typical_p, rep_pen, freq_pen, pres_pen,
        max_tokens, stop_seq, seed, reasoning_effort, stream_response,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        endpoint = excluded.endpoint,
        api_key = excluded.api_key,
        default_model = excluded.default_model,
        context_budget = excluded.context_budget,
        temperature = excluded.temperature,
        top_p = excluded.top_p,
        min_p = excluded.min_p,
        top_k = excluded.top_k,
        typical_p = excluded.typical_p,
        rep_pen = excluded.rep_pen,
        freq_pen = excluded.freq_pen,
        pres_pen = excluded.pres_pen,
        max_tokens = excluded.max_tokens,
        stop_seq = excluded.stop_seq,
        seed = excluded.seed,
        reasoning_effort = excluded.reasoning_effort,
        stream_response = excluded.stream_response,
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
        profile.temperature ?? 0.9,
        profile.topP ?? 1.0,
        profile.minP ?? 0.05,
        profile.topK ?? 40,
        profile.typicalP ?? 1.0,
        profile.repPen ?? 1.1,
        profile.freqPen ?? 0.0,
        profile.presPen ?? 0.0,
        profile.maxTokens ?? 8192,
        profile.stopSeq ?? '',
        profile.seed ?? null,
        profile.reasoningEffort ?? 'medium',
        profile.streamResponse === false ? 0 : 1,
        profile.createdAt || timestamp,
        timestamp,
      ],
    );
  }

  listProviderProfiles(): any[] {
    return this.db.queryAll<any>(
      `SELECT id, name, type, endpoint, api_key as apiKey, default_model as defaultModel,
              context_budget as contextBudget, is_active as isActiveInt,
              temperature, top_p as topP, min_p as minP, top_k as topK, typical_p as typicalP,
              rep_pen as repPen, freq_pen as freqPen, pres_pen as presPen,
              max_tokens as maxTokens, stop_seq as stopSeq, seed,
              reasoning_effort as reasoningEffort, stream_response as streamResponseInt,
              created_at as createdAt, updated_at as updatedAt
       FROM provider_profiles
       ORDER BY name ASC`,
    ).map((row) => ({
      ...row,
      isActive: row.isActiveInt === 1,
      streamResponse: row.streamResponseInt === 1,
    }));
  }

  getProviderProfile(id: string): any | null {
    const row = this.db.queryOne<any>(
      `SELECT id, name, type, endpoint, api_key as apiKey, default_model as defaultModel,
              context_budget as contextBudget, is_active as isActiveInt,
              temperature, top_p as topP, min_p as minP, top_k as topK, typical_p as typicalP,
              rep_pen as repPen, freq_pen as freqPen, pres_pen as presPen,
              max_tokens as maxTokens, stop_seq as stopSeq, seed,
              reasoning_effort as reasoningEffort, stream_response as streamResponseInt,
              created_at as createdAt, updated_at as updatedAt
       FROM provider_profiles
       WHERE id = ?`,
      [id],
    );
    return row
      ? { ...row, isActive: row.isActiveInt === 1, streamResponse: row.streamResponseInt === 1 }
      : null;
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
              temperature, top_p as topP, min_p as minP, top_k as topK, typical_p as typicalP,
              rep_pen as repPen, freq_pen as freqPen, pres_pen as presPen,
              max_tokens as maxTokens, stop_seq as stopSeq, seed,
              reasoning_effort as reasoningEffort, stream_response as streamResponseInt,
              created_at as createdAt, updated_at as updatedAt
       FROM provider_profiles
       WHERE is_active = 1
       LIMIT 1`,
    );
    return row
      ? { ...row, isActive: true, streamResponse: row.streamResponseInt === 1 }
      : null;
  }

  listPromptPresets(): PromptPreset[] {
    return this.db
      .queryAll<PromptPresetRow>(
        `SELECT id, name, bind_model, system, jailbreak, summary, tools, created_at, updated_at,
                file_path, file_hash, sync_status
         FROM prompt_presets
         ORDER BY name ASC`,
      )
      .map((row) => this.resolvePromptPreset(row));
  }

  getPromptPreset(presetId: PromptPresetId): PromptPreset | null {
    const row = this.db.queryOne<PromptPresetRow>(
      `SELECT id, name, bind_model, system, jailbreak, summary, tools, created_at, updated_at,
              file_path, file_hash, sync_status
       FROM prompt_presets WHERE id = ?`,
      [presetId],
    );
    return row ? this.resolvePromptPreset(row) : null;
  }

  createPromptPreset(input: { name: string; bindModel: string; system: string; jailbreak: string; summary: string; tools: string }): PromptPreset {
    return this.db.transaction(() => {
      const timestamp = this.clock.now();
      const id = this.idGenerator.next(ENTITY_ID_NAMESPACE.promptPreset) as PromptPresetId;
      const preset: PromptPreset = { id, ...input, createdAt: timestamp, updatedAt: timestamp };

      const canonicalFile = presetToCanonicalFile(preset);
      const slug = presetSlug(input.name);
      const relativeFileName = `${slug}.json`;
      const now = new Date().toISOString();

      let filePath: string | null = null;
      let fileHash: string | null = null;
      let syncStatus = "db_dirty";

      try {
        const absolutePath = this.fileStore.resolvePath(STORAGE_FOLDERS.promptPresets, relativeFileName);
        fileHash = hashCanonicalJson(canonicalFile);
        this.fileStore.writeJson(absolutePath, canonicalFile);
        filePath = `${PRESETS_PATH_SEGMENT}${relativeFileName}`;
        syncStatus = "synced";
      } catch {}

      this.db.execute(
        `INSERT INTO prompt_presets (id, name, bind_model, system, jailbreak, summary, tools, created_at, updated_at,
          file_path, file_hash, file_mtime, sync_status, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.name, input.bindModel, input.system, input.jailbreak, input.summary, input.tools, timestamp, timestamp,
         filePath, fileHash, now, syncStatus, now],
      );
      return preset;
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

      const canonicalFile = presetToCanonicalFile(next);
      const slug = presetSlug(next.name);
      const relativeFileName = `${slug}.json`;
      const now = new Date().toISOString();

      let filePath: string | null = null;
      let fileHash: string | null = null;
      let syncStatus = "db_dirty";

      try {
        const absolutePath = this.fileStore.resolvePath(STORAGE_FOLDERS.promptPresets, relativeFileName);
        fileHash = hashCanonicalJson(canonicalFile);
        this.fileStore.writeJson(absolutePath, canonicalFile);
        filePath = `${PRESETS_PATH_SEGMENT}${relativeFileName}`;
        syncStatus = "synced";
      } catch {}

      this.db.execute(
        `UPDATE prompt_presets SET name = ?, bind_model = ?, system = ?, jailbreak = ?, summary = ?, tools = ?, updated_at = ?,
          file_path = ?, file_hash = ?, file_mtime = ?, sync_status = ?, last_synced_at = ? WHERE id = ?`,
        [next.name, next.bindModel, next.system, next.jailbreak, next.summary, next.tools, timestamp,
         filePath, fileHash, now, syncStatus, now, presetId],
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
      const referencingChats = this.db.queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM chats WHERE prompt_preset_id = ?`,
        [presetId],
      );
      if ((referencingChats?.n ?? 0) > 0) {
        throw new Error(`Prompt preset '${presetId}' is used by a chat.`);
      }
      this.db.execute(`DELETE FROM prompt_presets WHERE id = ?`, [presetId]);
    });
  }

  private resolvePromptPreset(row: PromptPresetRow): PromptPreset {
    if (row.file_path) {
      const fromFile = this.readPresetFromFile(row.id, row.file_path);
      if (fromFile) return fromFile;
    }
    return mapPromptPreset(row);
  }

  private readPresetFromFile(presetId: string, filePath: string): PromptPreset | null {
    try {
      const fileName = filePath.slice(PRESETS_PATH_SEGMENT.length);
      const absolutePath = this.fileStore.resolvePath(STORAGE_FOLDERS.promptPresets, fileName);
      const file = this.fileStore.readJson<CanonicalPromptPresetFile>(absolutePath);
      if (
        file &&
        typeof file.schemaVersion === "number" &&
        file.schemaVersion === PROMPT_PRESET_FILE_SCHEMA_VERSION &&
        file.id === presetId
      ) {
        return canonicalFileToPreset(file);
      }
      this.tryMarkSyncStatus(presetId, "malformed");
    } catch {
      this.tryMarkSyncStatus(presetId, "missing_file");
    }
    return null;
  }

  private tryMarkSyncStatus(presetId: string, syncStatus: string): void {
    try {
      this.db.execute(
        `UPDATE prompt_presets SET sync_status = ? WHERE id = ?`,
        [syncStatus, presetId],
      );
    } catch {}
  }
}