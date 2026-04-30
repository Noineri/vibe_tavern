import type {
  LorebookId,
  Persona,
  PersonaId,
} from "@rp-platform/domain";
import { ENTITY_ID_NAMESPACE } from "@rp-platform/domain";
import type { PersonaRow } from "./sqlite-chat-session-mappers.js";
import type { SqliteDatabaseAdapter } from "./sqlite-adapter.js";
import type { StoreClock, StoreIdGenerator } from "./persistence.js";
import { unlinkSync } from "node:fs";
import {
  type FileStore,
  createFileStore,
  STORAGE_FOLDERS,
  hashCanonicalJson,
} from "./file-store.js";

const PERSONA_FILE_SCHEMA_VERSION = 1;

type CanonicalPersonaFile = {
  schemaVersion: typeof PERSONA_FILE_SCHEMA_VERSION;
  id: string;
  name: string;
  description: string;
  pronouns: string | null;
  avatarAssetId: string | null;
  createdAt: string;
  updatedAt: string;
};

function personaToCanonicalFile(persona: Persona): CanonicalPersonaFile {
  return {
    schemaVersion: PERSONA_FILE_SCHEMA_VERSION,
    id: persona.id,
    name: persona.name,
    description: persona.description,
    pronouns: persona.pronouns,
    avatarAssetId: persona.avatarAssetId,
    createdAt: persona.createdAt,
    updatedAt: persona.updatedAt,
  };
}

function canonicalFileToPersona(file: CanonicalPersonaFile): Persona {
  return {
    id: file.id as PersonaId,
    name: file.name,
    description: file.description,
    pronouns: file.pronouns,
    avatarAssetId: file.avatarAssetId,
    defaultForNewChats: false,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}

function personaSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-zа-яё0-9\-]/gi, "") || "persona";
}

function lorebookSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, "-").replace(/^-|-$/g, "") || "lorebook";
}

const PERSONAS_PATH_SEGMENT = "personas/";

type PersonaRowWithMeta = PersonaRow & {
  file_path: string | null;
  sync_status: string | null;
};

export class SqlitePersonaStore {
  private readonly fileStore: FileStore;

  constructor(
    private readonly db: SqliteDatabaseAdapter,
    private readonly clock: StoreClock,
    private readonly idGenerator: StoreIdGenerator,
    fileStore?: FileStore,
  ) {
    this.fileStore = fileStore ?? createFileStore();
  }

  upsertPersona(input: Persona): void {
    const canonicalFile = personaToCanonicalFile(input);
    const slug = personaSlug(input.name);
    const relativeFileName = `${slug}.json`;
    const now = new Date().toISOString();

    let filePath: string | null = null;
    let fileHash: string | null = null;
    let fileMtime: string | null = null;
    let syncStatus = "db_dirty";
    let syncError: string | null = null;
    let lastSyncedAt: string | null = null;

    try {
      const absolutePath = this.fileStore.resolvePath(STORAGE_FOLDERS.personas, relativeFileName);
      fileHash = hashCanonicalJson(canonicalFile);
      this.fileStore.writeJson(absolutePath, canonicalFile);
      filePath = `${PERSONAS_PATH_SEGMENT}${relativeFileName}`;
      fileMtime = now;
      syncStatus = "synced";
      lastSyncedAt = now;
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err);
    }

    this.db.execute(
      `INSERT INTO personas (
        id, name, description, pronouns, avatar_asset_id, default_for_new_chats, created_at, updated_at,
        file_path, file_hash, file_mtime, sync_status, sync_error, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        pronouns = excluded.pronouns,
        avatar_asset_id = excluded.avatar_asset_id,
        default_for_new_chats = excluded.default_for_new_chats,
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
        input.description,
        input.pronouns,
        input.avatarAssetId,
        input.defaultForNewChats ? 1 : 0,
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

  getPersona(personaId: PersonaId): Persona | null {
    const row = this.db.queryOne<PersonaRowWithMeta>(
      `SELECT
         id, name, description, pronouns, avatar_asset_id, default_for_new_chats, created_at, updated_at,
         file_path, sync_status
       FROM personas
       WHERE id = ?`,
      [personaId],
    );

    if (!row) {
      return null;
    }

    return this.resolvePersona(row);
  }

  listPersonas(): Persona[] {
    return this.db
      .queryAll<PersonaRowWithMeta>(
        `SELECT id, name, description, pronouns, avatar_asset_id, default_for_new_chats, created_at, updated_at,
                file_path, sync_status
         FROM personas
         ORDER BY name ASC`,
      )
      .map((row) => this.resolvePersona(row));
  }

  createPersona(input: { name: string; description: string; pronouns: string | null; defaultForNewChats: boolean }): Persona {
    return this.db.transaction(() => {
      const timestamp = this.clock.now();
      const id = this.idGenerator.next(ENTITY_ID_NAMESPACE.persona) as PersonaId;

      const persona: Persona = {
        id,
        name: input.name,
        description: input.description,
        pronouns: input.pronouns,
        avatarAssetId: null,
        defaultForNewChats: input.defaultForNewChats,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      const canonicalFile = personaToCanonicalFile(persona);
      const slug = personaSlug(input.name);
      const relativeFileName = `${slug}.json`;
      const now = new Date().toISOString();

      let filePath: string | null = null;
      let fileHash: string | null = null;
      let syncStatus = "db_dirty";

      try {
        const absolutePath = this.fileStore.resolvePath(STORAGE_FOLDERS.personas, relativeFileName);
        fileHash = hashCanonicalJson(canonicalFile);
        this.fileStore.writeJson(absolutePath, canonicalFile);
        filePath = `${PERSONAS_PATH_SEGMENT}${relativeFileName}`;
        syncStatus = "synced";
      } catch {}

      this.db.execute(
        `INSERT INTO personas (
          id, name, description, pronouns, avatar_asset_id, default_for_new_chats, created_at, updated_at,
          file_path, file_hash, file_mtime, sync_status, last_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.name,
          input.description,
          input.pronouns,
          null,
          input.defaultForNewChats ? 1 : 0,
          timestamp,
          timestamp,
          filePath,
          fileHash,
          now,
          syncStatus,
          now,
        ],
      );

      return persona;
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
      const lorebookId = this.idGenerator.next(ENTITY_ID_NAMESPACE.lorebook) as LorebookId;

      const lorebookFile = {
        schemaVersion: 1,
        id: lorebookId,
        name,
        scopeType: "persona",
        description: "Personal lorebook auto-created for persona.",
        scanDepth: null as number | null,
        tokenBudget: null as number | null,
        recursiveScanning: null as boolean | null,
        extensions: {} as Record<string, unknown>,
        entries: [] as Array<unknown>,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      const slug = lorebookSlug(name);
      const relativeFileName = `persona-${slug}.json`;
      let filePath: string | null = null;
      let fileHash: string | null = null;
      let syncStatus = "db_dirty";
      let syncError: string | null = null;
      const now = new Date().toISOString();

      try {
        const absolutePath = this.fileStore.resolvePath(STORAGE_FOLDERS.lorebooks, relativeFileName);
        fileHash = hashCanonicalJson(lorebookFile);
        this.fileStore.writeJson(absolutePath, lorebookFile);
        filePath = `lorebooks/${relativeFileName}`;
        syncStatus = "synced";
      } catch (err) {
        syncError = err instanceof Error ? err.message : String(err);
      }

      this.db.execute(
        `INSERT INTO lorebooks (id, name, scope_type, description, created_at, updated_at,
          file_path, file_hash, file_mtime, sync_status, sync_error, last_synced_at)
         VALUES (?, ?, 'persona', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [lorebookId, name, "Personal lorebook auto-created for persona.", timestamp, timestamp,
         filePath, fileHash, now, syncStatus, syncError, now],
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

      const row = this.db.queryOne<{ file_path: string | null }>(
        `SELECT file_path FROM lorebooks WHERE id = ?`,
        [existing.lorebookId],
      );

      this.db.execute(
        `DELETE FROM persona_lorebooks WHERE persona_id = ? AND lorebook_id = ?`,
        [personaId, existing.lorebookId],
      );
      this.db.execute(`DELETE FROM lorebooks WHERE id = ?`, [existing.lorebookId]);

      if (row?.file_path) {
        try {
          const fileName = row.file_path.slice("lorebooks/".length);
          const absolutePath = this.fileStore.resolvePath(STORAGE_FOLDERS.lorebooks, fileName);
          unlinkSync(absolutePath);
        } catch {}
      }
    });
  }

  private resolvePersona(row: PersonaRowWithMeta): Persona {
    if (row.file_path) {
      const fromFile = this.readPersonaFromFile(row.id, row.file_path);
      if (fromFile) {
        return {
          id: row.id as PersonaId,
          name: row.name,
          description: fromFile.description,
          pronouns: fromFile.pronouns,
          avatarAssetId: row.avatar_asset_id,
          defaultForNewChats: Boolean(row.default_for_new_chats),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }
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

  private readPersonaFromFile(personaId: string, filePath: string): Pick<Persona, "description" | "pronouns"> | null {
    try {
      const fileName = filePath.slice(PERSONAS_PATH_SEGMENT.length);
      const absolutePath = this.fileStore.resolvePath(STORAGE_FOLDERS.personas, fileName);
      const file = this.fileStore.readJson<CanonicalPersonaFile>(absolutePath);
      if (
        file &&
        typeof file.schemaVersion === "number" &&
        file.schemaVersion === PERSONA_FILE_SCHEMA_VERSION &&
        file.id === personaId
      ) {
        return { description: file.description, pronouns: file.pronouns };
      }
      this.tryMarkSyncStatus(personaId, "malformed");
    } catch {
      this.tryMarkSyncStatus(personaId, "missing_file");
    }
    return null;
  }

  private tryMarkSyncStatus(personaId: string, syncStatus: string): void {
    try {
      this.db.execute(
        `UPDATE personas SET sync_status = ? WHERE id = ?`,
        [syncStatus, personaId],
      );
    } catch {}
  }
}
