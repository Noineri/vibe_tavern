import type {
  LorebookId,
  Persona,
  PersonaId,
} from "@rp-platform/domain";
import { ENTITY_ID_NAMESPACE } from "@rp-platform/domain";
import type { PersonaRow } from "./sqlite-chat-session-mappers.js";
import type { SqliteDatabaseAdapter } from "./sqlite-adapter.js";
import type { StoreClock, StoreIdGenerator } from "./persistence.js";

export class SqlitePersonaStore {
  constructor(
    private readonly db: SqliteDatabaseAdapter,
    private readonly clock: StoreClock,
    private readonly idGenerator: StoreIdGenerator,
  ) {}

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
      const id = this.idGenerator.next(ENTITY_ID_NAMESPACE.persona) as PersonaId;
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
}
