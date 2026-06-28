import { eq, sql } from 'drizzle-orm';
import { personas } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';
import type { ContentStore } from '../content-store.js';
import { STORAGE_FOLDERS, IMAGE_EXTENSIONS } from '../file-store.js';
import type { PronounForms } from '@vibe-tavern/domain';

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreatePersonaData {
  name: string;
  description?: string;
  pronouns?: string | null;
  pronounForms?: PronounForms | null;
  avatarAssetId?: string | null;
  avatarFullAssetId?: string | null;
  avatarCropJson?: string | null;
  avatarExt?: string | null;
  avatarFullExt?: string | null;
  includeAvatarInPrompt?: boolean;
  avatarDescription?: string | null;
  defaultForNewChats?: boolean;
}

export type UpdatePersonaData = Partial<CreatePersonaData>;

// ─── Return type (matches domain Persona interface) ───────────────────────────

/**
 * Store-level Persona — domain Persona projected from a DB row.
 */
export interface Persona {
  id: string;
  name: string;
  description: string;
  pronouns: string | null;
  /** Structured pronoun declensions (custom case only); null for presets and unset. */
  pronounForms: PronounForms | null;
  avatarAssetId: string | null;
  avatarFullAssetId: string | null;
  avatarCropJson: string | null;
  /** Extension of the folder-resident thumbnail (crop) avatar at {id}/avatar.{avatarExt}. Null = no folder avatar (legacy flat avatar via avatarAssetId, or none). */
  avatarExt: string | null;
  /** Extension of the folder-resident FULL (uncropped) avatar at {id}/avatar-full.{avatarFullExt}. Null = no separate full image (the thumbnail avatar is itself uncropped, or none). */
  avatarFullExt: string | null;
  // Avatar-appearance prompt injection (MEDIA_GALLERY_BACKEND_PLAN).
  includeAvatarInPrompt: boolean;
  avatarDescription: string | null;
  defaultForNewChats: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class PersonaStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;
  private readonly content: ContentStore | null;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator; content?: ContentStore | null }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
    this.content = options?.content ?? null;
  }

  // ─── Read operations ───────────────────────────────────────────────────────

  async getById(id: string): Promise<Persona | null> {
    const row = await this.db.select().from(personas).where(eq(personas.id, id)).get();
    if (!row) return null;
    const persona = this.mapRow(row);

    // Lazy migration: copy-forward from a legacy flat file into {id}/persona.json
    // when one exists, otherwise write fresh from the DB row.
    if (this.content && !row.hasFileOnDisk) {
      const migrated = await this.content.migrateFlatToFolder(STORAGE_FOLDERS.personas, id, 'persona');
      let hash: string;
      if (migrated) {
        const copied = await this.content.readEntityFile<unknown>(STORAGE_FOLDERS.personas, id, 'persona');
        hash = this.content.hashContent(copied);
      } else {
        const fileData = this.toFilePayload(row);
        hash = await this.content.writeEntityFile(STORAGE_FOLDERS.personas, id, 'persona', fileData);
      }
      await this.db.update(personas)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(personas.id, id))
        .run();
    }

    // Avatar lazy migration (B4): legacy flat avatar → {id}/avatar.{ext}.
    // See CharacterStore.getById for full rationale (copy-forward, null on
    // missing flat asset, idempotent). Independent of the card block above —
    // runs whenever avatarExt is null and avatarAssetId is set.
    if (this.content && !row.avatarExt && row.avatarAssetId) {
      const ext = await this.content.copyAssetToEntityFolder(
        row.avatarAssetId,
        STORAGE_FOLDERS.personas,
        id,
        'avatar',
        IMAGE_EXTENSIONS,
      );
      if (ext) {
        await this.db.update(personas)
          .set({ avatarExt: ext, avatarAssetId: null })
          .where(eq(personas.id, id))
          .run();
        persona.avatarExt = ext;
        persona.avatarAssetId = null;
      }
    }

    // Full-avatar lazy migration (AVATAR_FULL_PLAN): legacy uncropped flat
    // avatar (avatarFullAssetId set, avatarFullExt null) → {id}/avatar-full.{ext}.
    // Same lazy/copy-forward/idempotent shape as the thumbnail block above.
    // Restores the original for the large display slots. Independent of the
    // thumbnail block.
    if (this.content && !row.avatarFullExt && row.avatarFullAssetId) {
      const fullExt = await this.content.copyAssetToEntityFolder(
        row.avatarFullAssetId,
        STORAGE_FOLDERS.personas,
        id,
        'avatar-full',
        IMAGE_EXTENSIONS,
      );
      if (fullExt) {
        await this.db.update(personas)
          .set({ avatarFullExt: fullExt, avatarFullAssetId: null })
          .where(eq(personas.id, id))
          .run();
        persona.avatarFullExt = fullExt;
        persona.avatarFullAssetId = null;
      }
    }

    return persona;
  }

  async listAll(): Promise<Persona[]> {
    const rows = await this.db.select().from(personas).all();
    return rows.map((row) => this.mapRow(row));
  }

  async getDefault(): Promise<Persona | null> {
    const row = await this.db
      .select()
      .from(personas)
      .where(eq(personas.defaultForNewChats, 1))
      .get();
    return row ? this.mapRow(row) : null;
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  async create(data: CreatePersonaData): Promise<Persona> {
    const id = this.idGen.next('persona');
    const now = this.clock.now();

    const [row] = await this.db
      .insert(personas)
      .values({
        id,
        name: data.name,
        description: data.description ?? '',
        pronouns: data.pronouns ?? null,
        pronounFormsJson: data.pronounForms ? JSON.stringify(data.pronounForms) : null,
        avatarAssetId: data.avatarAssetId ?? null,
        avatarFullAssetId: data.avatarFullAssetId ?? null,
        avatarCropJson: data.avatarCropJson ?? null,
        avatarExt: data.avatarExt ?? null,
        avatarFullExt: data.avatarFullExt ?? null,
        includeAvatarInPrompt: data.includeAvatarInPrompt ?? false,
        avatarDescription: data.avatarDescription ?? null,
        defaultForNewChats: data.defaultForNewChats ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // Dual-write: write canonical {id}/persona.json
    if (this.content) {
      const fileData = this.toFilePayload(row!);
      const hash = await this.content.writeEntityFile(STORAGE_FOLDERS.personas, id, 'persona', fileData);
      await this.db.update(personas)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(personas.id, id))
        .run();
    }

    return this.mapRow(row!);
  }

  async update(id: string, data: UpdatePersonaData): Promise<Persona> {
    const now = this.clock.now();

    const values: Partial<typeof personas.$inferInsert> = { updatedAt: now };

    if (data.name !== undefined) values.name = data.name;
    if (data.description !== undefined) values.description = data.description;
    if (data.pronouns !== undefined) values.pronouns = data.pronouns;
    if (data.pronounForms !== undefined) values.pronounFormsJson = data.pronounForms ? JSON.stringify(data.pronounForms) : null;
    if (data.avatarAssetId !== undefined) values.avatarAssetId = data.avatarAssetId;
    if (data.avatarFullAssetId !== undefined) values.avatarFullAssetId = data.avatarFullAssetId;
    if (data.avatarCropJson !== undefined) values.avatarCropJson = data.avatarCropJson;
    if (data.avatarExt !== undefined) values.avatarExt = data.avatarExt;
    if (data.avatarFullExt !== undefined) values.avatarFullExt = data.avatarFullExt;
    if (data.defaultForNewChats !== undefined) values.defaultForNewChats = data.defaultForNewChats ? 1 : 0;
    // Avatar-appearance prompt-injection fields. Mirrored on setMediaFields;
    // mapped here too so the PATCH path can set them.
    if (data.includeAvatarInPrompt !== undefined) values.includeAvatarInPrompt = data.includeAvatarInPrompt;
    if (data.avatarDescription !== undefined) values.avatarDescription = data.avatarDescription;

    const [row] = await this.db
      .update(personas)
      .set(values)
      .where(eq(personas.id, id))
      .returning();

    if (!row) {
      throw new Error(`Persona '${id}' not found after update`);
    }

    // Dual-write: update canonical {id}/persona.json
    if (this.content) {
      const fileData = this.toFilePayload(row);
      const hash = await this.content.writeEntityFile(STORAGE_FOLDERS.personas, id, 'persona', fileData);
      await this.db.update(personas)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(personas.id, id))
        .run();
    }

    return this.mapRow(row);
  }

  async delete(id: string): Promise<void> {
    // Delete guard: cannot delete the last persona
    const countRow = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(personas)
      .get();

    if (countRow && countRow.count <= 1) {
      throw new Error('Cannot delete the last persona');
    }

    // Remove the whole per-entity folder ({id}/persona.json, future avatar.*).
    // Legacy flat {id}.json is left in place (copy-forward; harmless orphan).
    if (this.content) {
      await this.content.deleteEntityFolder(STORAGE_FOLDERS.personas, id);
    }

    await this.db.delete(personas).where(eq(personas.id, id)).run();
  }

  /**
   * Point update of the folder-resident avatar: sets `avatarExt` and clears
   * the legacy `avatarAssetId` in a single UPDATE. Does NOT rewrite
   * {id}/persona.json (avatar upload must not touch the persona file — C1).
   * Use after writing {id}/avatar.{ext} bytes out-of-band (AssetService).
   */
  async setFolderAvatar(id: string, ext: string): Promise<void> {
    await this.db
      .update(personas)
      .set({ avatarExt: ext, avatarAssetId: null, updatedAt: this.clock.now() })
      .where(eq(personas.id, id))
      .run();
  }

  /**
   * Point update of the folder-resident FULL avatar: sets `avatarFullExt` and
   * clears the legacy `avatarFullAssetId`. Symmetric with setFolderAvatar.
   */
  async setFolderAvatarFull(id: string, ext: string): Promise<void> {
    await this.db
      .update(personas)
      .set({ avatarFullExt: ext, avatarFullAssetId: null, updatedAt: this.clock.now() })
      .where(eq(personas.id, id))
      .run();
  }

  /**
   * Point-update for the persona's media prompt-injection fields (avatar
   * description + the include toggle). Does NOT touch other columns — used by
   * the vision describe endpoint (A6) and the persona media settings UI.
   * Mirrors CharacterStore.setMediaFields (persona has no gallery).
   */
  async setMediaFields(
    id: string,
    patch: {
      avatarDescription?: string | null;
      includeAvatarInPrompt?: boolean;
    },
  ): Promise<void> {
    const values: Record<string, unknown> = { updatedAt: this.clock.now() };
    if (patch.avatarDescription !== undefined) values.avatarDescription = patch.avatarDescription;
    if (patch.includeAvatarInPrompt !== undefined) values.includeAvatarInPrompt = patch.includeAvatarInPrompt;
    await this.db.update(personas).set(values).where(eq(personas.id, id)).run();
  }

  async setDefault(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(personas).set({ defaultForNewChats: 0 }).run();
      await tx.update(personas).set({ defaultForNewChats: 1 }).where(eq(personas.id, id)).run();
    });
  }

  async ensureDefault(): Promise<Persona> {
    const countRow = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(personas)
      .get();

    if (countRow && countRow.count > 0) {
      // Return existing default, or first persona
      const existing = await this.getDefault();
      if (existing) return existing;
      const first = await this.db.select().from(personas).get();
      return this.mapRow(first!);
    }

    // Create default "User" persona
    return this.create({
      name: 'User',
      description: '',
      pronouns: null,
      avatarAssetId: null,
      defaultForNewChats: true,
    });
  }

  // ─── File payload ──────────────────────────────────────────────────────────

  private toFilePayload(row: typeof personas.$inferSelect): Record<string, unknown> {
    return {
      name: row.name,
      description: row.description,
      pronouns: row.pronouns,
      pronounForms: parsePronounForms(row.pronounFormsJson),
    };
  }

  // ─── Row mapper ────────────────────────────────────────────────────────────

  private mapRow(row: typeof personas.$inferSelect): Persona {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      pronouns: row.pronouns,
      pronounForms: parsePronounForms(row.pronounFormsJson),
      avatarAssetId: row.avatarAssetId,
      avatarFullAssetId: row.avatarFullAssetId,
      avatarCropJson: row.avatarCropJson ?? null,
      avatarExt: row.avatarExt ?? null,
      avatarFullExt: row.avatarFullExt ?? null,
      includeAvatarInPrompt: row.includeAvatarInPrompt,
      avatarDescription: row.avatarDescription ?? null,
      defaultForNewChats: row.defaultForNewChats === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

/** Parse `pronoun_forms_json` into a validated PronounForms, or null when absent/malformed.
 *  The column is always written via JSON.stringify of a valid PronounForms, so a malformed value
 *  indicates corruption — fall back to null (treated identically to "unset"). */
function parsePronounForms(text: string | null): PronounForms | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<PronounForms>;
    if (
      typeof parsed.subjective === 'string' &&
      typeof parsed.objective === 'string' &&
      typeof parsed.possessive === 'string' &&
      typeof parsed.possessivePronoun === 'string' &&
      typeof parsed.reflexive === 'string'
    ) {
      return parsed as PronounForms;
    }
    return null;
  } catch {
    return null;
  }
}
