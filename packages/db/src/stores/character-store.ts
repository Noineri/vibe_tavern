import { eq, ne, sql } from 'drizzle-orm';
import { characters } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';
import type { CharacterFolder } from './character-folder.js';
import { profileFromCharacter, serializeProfileMd, type VtfCharacterContent } from '../vtf/index.js';

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreateCharacterData {
  name: string;
  description?: string;
  personalitySummary?: string | null;
  defaultScenario?: string | null;
  firstMessage?: string | null;
  mesExample?: string | null;
  mesExampleMode?: string;
  mesExampleDepth?: number;
  alternateGreetings?: string[];
  postHistoryInstructions?: string | null;
  creatorNotes?: string | null;
  characterBook?: Record<string, unknown> | null;
  depthPrompt?: string | null;
  depthPromptDepth?: number | null;
  depthPromptRole?: string | null;
  extensions?: Record<string, unknown>;
  systemPrompt?: string | null;
  tags?: string[];
  avatarAssetId?: string | null;
  avatarFullAssetId?: string | null;
  avatarCropJson?: string | null;
  avatarExt?: string | null;
  avatarFullExt?: string | null;
  avatarSourceAssetId?: string | null;
  includeGalleryInPrompt?: boolean;
  includeAvatarInPrompt?: boolean;
  avatarDescription?: string | null;
}

export type UpdateCharacterData = Partial<CreateCharacterData>;

/**
 * Store-level Character — domain Character projected from a DB row.
 * Uses plain `string` IDs (brands are applied at the API boundary).
 * Includes DB-specific fields like `slug` and `status`.
 */
export interface Character {
  id: string;
  slug: string;
  name: string;
  description: string;
  personalitySummary: string | null;
  defaultScenario: string | null;
  firstMessage: string | null;
  mesExample: string | null;
  mesExampleMode: string;
  mesExampleDepth: number;
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
  avatarFullAssetId: string | null;
  avatarCropJson: string | null;
  /** Extension of the folder-resident thumbnail (crop) avatar at {id}/avatar.{avatarExt}. Null = no folder avatar (legacy flat avatar via avatarAssetId, or none). */
  avatarExt: string | null;
  /** Extension of the folder-resident FULL (uncropped) avatar at {id}/avatar-full.{avatarFullExt}. Null = no separate full image (the thumbnail avatar is itself uncropped, or none). */
  avatarFullExt: string | null;
  /** Gallery row id the avatar was last set from (setAvatarFromGallery). Null = avatar came from a direct upload or was never set from a gallery image. */
  avatarSourceAssetId: string | null;
  // Media gallery / avatar-appearance prompt injection (MEDIA_GALLERY_BACKEND_PLAN).
  includeGalleryInPrompt: boolean;
  includeAvatarInPrompt: boolean;
  avatarDescription: string | null;
  status: 'active' | 'draft' | 'archived';
  createdAt: string;
  updatedAt: string;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class CharacterStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;
  private readonly folder: CharacterFolder | null;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator; folder?: CharacterFolder | null }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
    this.folder = options?.folder ?? null;
  }

  // ─── Read operations ───────────────────────────────────────────────────────

  async getById(id: string): Promise<Character | null> {
    const row = await this.db.select().from(characters).where(eq(characters.id, id)).get();
    if (!row) return null;
    const char = this.mapRow(row);
    const folderName = this.folderOf(id, row);

    // Lazy migration: if not yet on disk, copy-forward from a legacy flat
    // file into {id}/card.json when one exists, otherwise write fresh from
    // the DB row. Either way the file lands in the per-entity folder.
    if (this.folder && !row.hasFileOnDisk) {
      const hash = await this.folder.ensureCardFile(folderName, this.toFileData(char));
      await this.db
        .update(characters)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(characters.id, id))
        .run();
    }

    // Avatar lazy migration (B4): legacy flat avatar (avatarAssetId set,
    // avatarExt null) → copy into {id}/avatar.{ext} and persist the ext.
    // Copy-forward: the flat asset under data/assets/ is NOT deleted. If the
    // flat asset is gone, leave avatarAssetId as-is (avatar 404s, same as
    // today). Idempotent: a successful run stamps avatarExt so the next read
    // skips this block; a mid-flight crash retries safely. Independent of the
    // card block above — runs whenever avatarExt is null and avatarAssetId set.
    if (this.folder && !row.avatarExt && row.avatarAssetId) {
      const ext = await this.folder.migrateAvatar(folderName, row.avatarAssetId);
      if (ext) {
        await this.db
          .update(characters)
          .set({ avatarExt: ext, avatarAssetId: null })
          .where(eq(characters.id, id))
          .run();
        char.avatarExt = ext;
        char.avatarAssetId = null;
      }
    }

    // Full-avatar lazy migration (AVATAR_FULL_PLAN): legacy uncropped flat
    // avatar (avatarFullAssetId set, avatarFullExt null) → copy into
    // {id}/avatar-full.{ext} and persist the ext. Same lazy/copy-forward/
    // idempotent shape as the thumbnail block above. Restores the original for
    // the large display slots (top-bar preview, editor) when only the crop was
    // migrated into avatar.{ext}. Runs independently of the thumbnail block.
    if (this.folder && !row.avatarFullExt && row.avatarFullAssetId) {
      const fullExt = await this.folder.migrateAvatarFull(folderName, row.avatarFullAssetId);
      if (fullExt) {
        await this.db
          .update(characters)
          .set({ avatarFullExt: fullExt, avatarFullAssetId: null })
          .where(eq(characters.id, id))
          .run();
        char.avatarFullExt = fullExt;
        char.avatarFullAssetId = null;
      }
    }

    return this.applyVtfContentOverride(folderName, char);
  }

  /**
   * VTF-aware read: if the entity folder has a `profile.md`, parse the VTF
   * folder (profile.md + instructions.json + extensions.json + greetings/)
   * and override the DB-row content fields with it — the VTF folder is the
   * source of truth for content
   * once it exists. Falls back silently to the DB-row content when the folder
   * is absent or unreadable (legacy card.json-only or pre-migration rows).
   */
  private async applyVtfContentOverride(folderName: string, char: Character): Promise<Character> {
    if (!this.folder) return char;
    const override = await this.folder.readVtfOverride(folderName);
    if (override === null) return char;
    return this.mergeVtfContent(char, override);
  }

  /** Override the content fields of a DB-row character with VTF-parsed content (sourced from {@link CharacterFolder}.readVtfOverride). Media/avatar/status/timestamps are preserved. */
  private mergeVtfContent(base: Character, vtf: VtfCharacterContent): Character {
    return {
      ...base,
      name: vtf.name,
      description: vtf.description,
      personalitySummary: vtf.personalitySummary,
      defaultScenario: vtf.defaultScenario,
      firstMessage: vtf.firstMessage,
      mesExample: vtf.mesExample,
      mesExampleMode: vtf.mesExampleMode,
      mesExampleDepth: vtf.mesExampleDepth,
      alternateGreetings: vtf.alternateGreetings,
      postHistoryInstructions: vtf.postHistoryInstructions,
      creatorNotes: vtf.creatorNotes,
      depthPrompt: vtf.depthPrompt,
      depthPromptDepth: vtf.depthPromptDepth,
      depthPromptRole: vtf.depthPromptRole,
      systemPrompt: vtf.systemPrompt,
      tags: vtf.tags,
      extensions: vtf.extensions,
    };
  }

  /**
   * Return the canonical `profile.md` text for a character (frontmatter + the
   * three prose H1 sections). This is the Co-Author edit target and the
   * round-trip source for Apply (CA-7): `serializeProfileMd(profileFromCharacter(char))`,
   * so the AI always sees and edits the same canonical document the Form emits.
   * Throws if the character does not exist.
   */
  async getProfileMdText(id: string): Promise<string> {
    const char = await this.getById(id);
    if (!char) throw new Error(`Character '${id}' was not found.`);
    return serializeProfileMd({ profile: profileFromCharacter(this.toVtfContent(char)) });
  }

  /** Project a {@link Character} onto the VTF content subset for serialization. */
  private toVtfContent(char: Character): VtfCharacterContent {
    return {
      name: char.name,
      description: char.description,
      personalitySummary: char.personalitySummary,
      defaultScenario: char.defaultScenario,
      firstMessage: char.firstMessage ?? '',
      mesExample: char.mesExample,
      mesExampleMode: char.mesExampleMode,
      mesExampleDepth: char.mesExampleDepth,
      alternateGreetings: char.alternateGreetings,
      postHistoryInstructions: char.postHistoryInstructions,
      creatorNotes: char.creatorNotes,
      depthPrompt: char.depthPrompt,
      depthPromptDepth: char.depthPromptDepth,
      depthPromptRole: char.depthPromptRole,
      systemPrompt: char.systemPrompt,
      tags: char.tags,
      extensions: char.extensions,
    };
  }

  async listAll(): Promise<Character[]> {
    const rows = await this.db
      .select()
      .from(characters)
      .where(eq(characters.status, 'active'))
      .all();
    return rows.map((row) => this.mapRow(row));
  }

  async search(query: string): Promise<Character[]> {
    const rows = await this.db
      .select()
      .from(characters)
      .where(
        sql`lower(${characters.name}) LIKE lower(${'%' + query + '%'})`,
      )
      .all();
    return rows.map((row) => this.mapRow(row));
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  async create(data: CreateCharacterData): Promise<Character> {
    const id = this.idGen.next('char');
    const now = this.clock.now();

    const [row] = await this.db
      .insert(characters)
      .values({
        id,
        name: data.name,
        description: data.description ?? '',
        personalitySummary: data.personalitySummary ?? null,
        defaultScenario: data.defaultScenario ?? null,
        firstMessage: data.firstMessage ?? null,
        mesExample: data.mesExample ?? null,
        mesExampleMode: data.mesExampleMode ?? 'always',
        mesExampleDepth: data.mesExampleDepth ?? 4,
        alternateGreetingsJson: JSON.stringify(data.alternateGreetings ?? []),
        postHistoryInstructions: data.postHistoryInstructions ?? null,
        creatorNotes: data.creatorNotes ?? null,
        characterBookJson: data.characterBook ? JSON.stringify(data.characterBook) : null,
        depthPrompt: data.depthPrompt ?? null,
        depthPromptDepth: data.depthPromptDepth ?? null,
        depthPromptRole: data.depthPromptRole ?? null,
        extensionsJson: JSON.stringify(data.extensions ?? {}),
        systemPrompt: data.systemPrompt ?? null,
        tagsJson: JSON.stringify(data.tags ?? []),
        avatarAssetId: data.avatarAssetId ?? null,
        avatarFullAssetId: data.avatarFullAssetId ?? null,
        avatarCropJson: data.avatarCropJson ?? null,
        avatarExt: data.avatarExt ?? null,
        avatarFullExt: data.avatarFullExt ?? null,
        avatarSourceAssetId: data.avatarSourceAssetId ?? null,
        includeGalleryInPrompt: data.includeGalleryInPrompt ?? false,
        includeAvatarInPrompt: data.includeAvatarInPrompt ?? false,
        avatarDescription: data.avatarDescription ?? null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const char = this.mapRow(row!);

    // Dual write: persist content to the VTF folder; stamp the combined hash on the DB row.
    if (this.folder) {
      const hash = await this.folder.writeVtfFolder(this.folderOf(id, row!), this.toVtfContent(char), id);
      await this.db
        .update(characters)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(characters.id, id))
        .run();
    }

    return char;
  }

  async update(id: string, data: UpdateCharacterData): Promise<Character> {
    const now = this.clock.now();

    const values: Partial<typeof characters.$inferInsert> = { updatedAt: now };

    if (data.name !== undefined) values.name = data.name;
    if (data.description !== undefined) values.description = data.description;
    if (data.personalitySummary !== undefined) values.personalitySummary = data.personalitySummary;
    if (data.defaultScenario !== undefined) values.defaultScenario = data.defaultScenario;
    if (data.firstMessage !== undefined) values.firstMessage = data.firstMessage;
    if (data.mesExample !== undefined) values.mesExample = data.mesExample;
    if (data.mesExampleMode !== undefined) values.mesExampleMode = data.mesExampleMode;
    if (data.mesExampleDepth !== undefined) values.mesExampleDepth = data.mesExampleDepth;
    if (data.alternateGreetings !== undefined) values.alternateGreetingsJson = JSON.stringify(data.alternateGreetings);
    if (data.postHistoryInstructions !== undefined) values.postHistoryInstructions = data.postHistoryInstructions;
    if (data.creatorNotes !== undefined) values.creatorNotes = data.creatorNotes;
    if (data.characterBook !== undefined) values.characterBookJson = data.characterBook ? JSON.stringify(data.characterBook) : null;
    if (data.depthPrompt !== undefined) values.depthPrompt = data.depthPrompt;
    if (data.depthPromptDepth !== undefined) values.depthPromptDepth = data.depthPromptDepth;
    if (data.depthPromptRole !== undefined) values.depthPromptRole = data.depthPromptRole;
    if (data.extensions !== undefined) values.extensionsJson = JSON.stringify(data.extensions);
    if (data.systemPrompt !== undefined) values.systemPrompt = data.systemPrompt;
    if (data.tags !== undefined) values.tagsJson = JSON.stringify(data.tags);
    if (data.avatarAssetId !== undefined) values.avatarAssetId = data.avatarAssetId;
    if (data.avatarFullAssetId !== undefined) values.avatarFullAssetId = data.avatarFullAssetId;
    if (data.avatarCropJson !== undefined) values.avatarCropJson = data.avatarCropJson;
    if (data.avatarExt !== undefined) values.avatarExt = data.avatarExt;
    if (data.avatarFullExt !== undefined) values.avatarFullExt = data.avatarFullExt;
    // Media gallery / avatar-appearance prompt-injection fields. Mirrored on
    // setMediaFields; mapped here too so the PATCH path can set them (the
    // describe endpoints write avatarDescription via setMediaFields, but the
    // toggles and manual description edits go through the PATCH path).
    if (data.includeGalleryInPrompt !== undefined) values.includeGalleryInPrompt = data.includeGalleryInPrompt;
    if (data.includeAvatarInPrompt !== undefined) values.includeAvatarInPrompt = data.includeAvatarInPrompt;
    if (data.avatarDescription !== undefined) values.avatarDescription = data.avatarDescription;

    const [row] = await this.db
      .update(characters)
      .set(values)
      .where(eq(characters.id, id))
      .returning();

    if (!row) {
      throw new Error(`Character '${id}' not found after update`);
    }
    const updated = this.mapRow(row);

    // Dual write: rewrite the VTF folder; stamp the combined hash on the DB row.
    if (this.folder) {
      const hash = await this.folder.writeVtfFolder(this.folderOf(id, row), this.toVtfContent(updated), id);
      await this.db
        .update(characters)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(characters.id, id))
        .run();
    }

    return updated;
  }

  async delete(id: string): Promise<void> {
    // Load the row first so the on-disk folder resolves by name
    // (HUMAN_READABLE_FOLDERS): a renamed character's folder is `folder_name`,
    // not the opaque id. If the row is already gone, folderOf falls back to id
    // and removeAll is a harmless no-op on a non-existent folder.
    const row = await this.db.select().from(characters).where(eq(characters.id, id)).get();
    await this.db.delete(characters).where(eq(characters.id, id)).run();
    if (this.folder) {
      // Remove the whole per-entity folder (card.json, original.json,
      // avatar.*, future gallery/). Legacy flat files ({id}.json /
      // {id}.{slug}.json) are intentionally left in place — copy-forward
      // policy; they become harmless orphans.
      await this.folder.removeAll(this.folderOf(id, row));
    }
  }

  async duplicate(id: string): Promise<Character> {
    const original = await this.db.select().from(characters).where(eq(characters.id, id)).get();
    if (!original) {
      throw new Error(`Character '${id}' not found`);
    }

    const newId = this.idGen.next('char');
    const now = this.clock.now();

    const [row] = await this.db
      .insert(characters)
      .values({
        id: newId,
        name: `${original.name} (copy)`,
        description: original.description,
        personalitySummary: original.personalitySummary,
        defaultScenario: original.defaultScenario,
        firstMessage: original.firstMessage,
        mesExample: original.mesExample,
        mesExampleMode: original.mesExampleMode,
        mesExampleDepth: original.mesExampleDepth,
        alternateGreetingsJson: original.alternateGreetingsJson,
        postHistoryInstructions: original.postHistoryInstructions,
        creatorNotes: original.creatorNotes,
        characterBookJson: original.characterBookJson,
        depthPrompt: original.depthPrompt,
        depthPromptDepth: original.depthPromptDepth,
        depthPromptRole: original.depthPromptRole,
        extensionsJson: original.extensionsJson,
        systemPrompt: original.systemPrompt,
        tagsJson: original.tagsJson,
        avatarAssetId: original.avatarAssetId,
        avatarFullAssetId: original.avatarFullAssetId,
        avatarCropJson: original.avatarCropJson,
        avatarExt: original.avatarExt,
        avatarFullExt: original.avatarFullExt,
        avatarSourceAssetId: original.avatarSourceAssetId,
        includeGalleryInPrompt: original.includeGalleryInPrompt,
        includeAvatarInPrompt: original.includeAvatarInPrompt,
        avatarDescription: original.avatarDescription,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const copy = this.mapRow(row!);

    // Dual write: persist the copy's VTF folder; stamp the combined hash on the DB row.
    if (this.folder) {
      const hash = await this.folder.writeVtfFolder(this.folderOf(newId, row!), this.toVtfContent(copy), newId);
      await this.db
        .update(characters)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(characters.id, newId))
        .run();

      // Copy the folder-resident avatar (if any) into the duplicate's own
      // folder — a separate file, not a shared reference. The flat
      // avatarAssetId (shared above) is the legacy fallback and is left shared
      // per the plan (avatarFullAssetId also stays shared).
      if (original.avatarExt) {
        await this.folder.copyAvatarFile(this.folderOf(original.id, original), this.folderOf(newId, row!), original.avatarExt);
      }
      // Copy the folder-resident full uncropped avatar (if any), mirroring the
      // thumbnail block above. Without this, duplicating a migrated character
      // (avatarFullExt set, avatarFullAssetId already nulled by migration)
      // would silently lose the full avatar — the read-time lazy-migration
      // guard (!avatarFullExt && avatarFullAssetId) cannot self-heal it.
      if (original.avatarFullExt) {
        await this.folder.copyAvatarFullFile(this.folderOf(original.id, original), this.folderOf(newId, row!), original.avatarFullExt);
      }
    }

    return copy;
  }

  /**
   * One-shot VTF migration (VTF-8): read the character's full content (DB row,
   * with any existing profile.md override applied via getById) and (re)write
   * the VTF folder (profile.md + instructions.json + extensions.json +
   * greetings/). Stamps `contentHash` + `hasFileOnDisk`. Idempotent: returns
   * null (skipped) when `profile.md` already exists and `force` is not set.
   * The legacy `card.json` / flat file (if present) is left in place as a
   * harmless backup — `getById` prefers `profile.md`. Media/avatar/status are
   * untouched.
   */
  async migrateToVtf(id: string, opts?: { force?: boolean }): Promise<string | null> {
    if (!this.folder) throw new Error('CharacterFolder required for VTF migration');
    // Load the row up front so the on-disk folder resolves by name
    // (HUMAN_READABLE_FOLDERS): hasVtfProfile + writeVtfFolder must target the
    // `folder_name` folder, not the opaque id, once a character is renamed.
    const row = await this.db.select().from(characters).where(eq(characters.id, id)).get();
    if (!row) throw new Error(`Character '${id}' not found`);
    const folderName = this.folderOf(id, row);
    if (!opts?.force) {
      // Filesystem check (not the text cache, which may be stale if the file
      // was removed out-of-band) — a character is VTF-native iff profile.md
      // physically exists in its folder.
      const exists = await this.folder.hasVtfProfile(folderName);
      if (exists) return null;
    }
    const char = await this.getById(id);
    if (!char) throw new Error(`Character '${id}' not found`);
    const hash = await this.folder.writeVtfFolder(folderName, this.toVtfContent(char), id);
    await this.db
      .update(characters)
      .set({ contentHash: hash, hasFileOnDisk: 1 })
      .where(eq(characters.id, id))
      .run();
    return hash;
  }

  // ─── Avatar ────────────────────────────────────────────────────────────────

  /**
   * Point update of the folder-resident avatar: sets `avatarExt` and clears
   * the legacy `avatarAssetId` in a single UPDATE. Does NOT rewrite
   * {id}/card.json (avatar upload must not touch the card — see C1 plan).
   * Use after writing {id}/avatar.{ext} bytes out-of-band (AssetService).
   */
  async setFolderAvatar(id: string, ext: string): Promise<void> {
    await this.db
      .update(characters)
      .set({ avatarExt: ext, avatarAssetId: null, updatedAt: this.clock.now() })
      .where(eq(characters.id, id))
      .run();
  }

  /**
   * Point update of the folder-resident FULL avatar: sets `avatarFullExt` and
   * clears the legacy `avatarFullAssetId` in a single UPDATE. Symmetric with
   * setFolderAvatar. Does NOT rewrite {id}/card.json.
   */
  async setFolderAvatarFull(id: string, ext: string): Promise<void> {
    await this.db
      .update(characters)
      .set({ avatarFullExt: ext, avatarFullAssetId: null, updatedAt: this.clock.now() })
      .where(eq(characters.id, id))
      .run();
  }

  /** D8: store the avatar crop geometry (percentages JSON from react-easy-crop).
   *  Bumps updatedAt so cache-busted avatar URLs refresh. Used by the
   *  set-avatar-from-gallery flow; null clears the remembered crop. */
  async setAvatarCropJson(id: string, json: string | null): Promise<void> {
    await this.db
      .update(characters)
      .set({ avatarCropJson: json, updatedAt: this.clock.now() })
      .where(eq(characters.id, id))
      .run();
  }

  /** D8/Bug #3: record which gallery row the current avatar was set from.
   *  Set to the source row id by setAvatarFromGallery; cleared to null by
   *  uploadCharacterAvatar. Drives salvage gating: when non-null, the current
   *  avatar's bytes already live in the gallery under this id, so the NEXT
   *  setAvatarFromGallery skips salvage (prevents gallery duplication — Bug #3).
   *  When null, the avatar is a direct upload whose bytes are NOT in the
   *  gallery, so the next gallery swap salvages it. Bumps updatedAt. */
  async setAvatarSourceAssetId(id: string, assetId: string | null): Promise<void> {
    await this.db
      .update(characters)
      .set({ avatarSourceAssetId: assetId, updatedAt: this.clock.now() })
      .where(eq(characters.id, id))
      .run();
  }

  /**
   * Point-update for media prompt-injection fields (avatar description + the
   * gallery/avatar include toggles). Does NOT rewrite {id}/card.json (unlike
   * `update`) — these are display/prompt columns, not card content. Used by
   * the vision describe endpoints (A6) and the media settings UI.
   */
  async setMediaFields(
    id: string,
    patch: {
      avatarDescription?: string | null;
      includeGalleryInPrompt?: boolean;
      includeAvatarInPrompt?: boolean;
    },
  ): Promise<void> {
    const values: Record<string, unknown> = { updatedAt: this.clock.now() };
    if (patch.avatarDescription !== undefined) values.avatarDescription = patch.avatarDescription;
    if (patch.includeGalleryInPrompt !== undefined) values.includeGalleryInPrompt = patch.includeGalleryInPrompt;
    if (patch.includeAvatarInPrompt !== undefined) values.includeAvatarInPrompt = patch.includeAvatarInPrompt;
    await this.db.update(characters).set(values).where(eq(characters.id, id)).run();
  }

  // ─── Status operations ─────────────────────────────────────────────────────

  async archive(id: string): Promise<Character> {
    const now = this.clock.now();
    const [row] = await this.db
      .update(characters)
      .set({ status: 'archived', updatedAt: now })
      .where(eq(characters.id, id))
      .returning();

    if (!row) {
      throw new Error(`Character '${id}' not found after archive`);
    }
    return this.mapRow(row);
  }

  async unarchive(id: string): Promise<Character> {
    const now = this.clock.now();
    const [row] = await this.db
      .update(characters)
      .set({ status: 'active', updatedAt: now })
      .where(eq(characters.id, id))
      .returning();

    if (!row) {
      throw new Error(`Character '${id}' not found after unarchive`);
    }
    return this.mapRow(row);
  }

  // ─── System character ──────────────────────────────────────────────────────

  // ─── File data helpers ────────────────────────────────────────────────────

  private toFileData(char: Character): Record<string, unknown> {
    return {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: char.name,
        description: char.description,
        personality: char.personalitySummary ?? '',
        scenario: char.defaultScenario ?? '',
        first_mes: char.firstMessage ?? '',
        mes_example: char.mesExample ?? '',
        system_prompt: char.systemPrompt ?? '',
        creator_notes: char.creatorNotes ?? '',
        post_history_instructions: char.postHistoryInstructions ?? '',
        alternate_greetings: char.alternateGreetings,
        tags: char.tags,
        character_book: char.characterBook ?? undefined,
        extensions: char.extensions,
        depth_prompt: {
          prompt: char.depthPrompt ?? '',
          depth: char.depthPromptDepth ?? 4,
          role: char.depthPromptRole ?? 'system',
        },
      },
    };
  }

  // ─── Folder-name helpers ─────────────────────────────────────────────────

  /**
   * Resolve a collision-free `folder_name` for a candidate slug. Queries the
   * existing non-empty `folder_name`s (excluding `excludeId` when renaming so a
   * character never collides with itself) and appends `-2`, `-3`, … until
   * unique. Empty folder_names are skipped — legacy fallback rows each fall back
   * to their distinct id, so they never collide with a real slug.
   */
  async ensureUniqueFolderName(candidate: string, excludeId?: string): Promise<string> {
    const rows = await this.db.select({ folderName: characters.folderName })
      .from(characters)
      .where(excludeId ? ne(characters.id, excludeId) : undefined)
      .all();
    const taken = new Set<string>();
    for (const r of rows) {
      if (r.folderName !== '') taken.add(r.folderName);
    }
    if (!taken.has(candidate)) return candidate;
    let n = 2;
    while (taken.has(`${candidate}-${n}`)) n++;
    return `${candidate}-${n}`;
  }

  /**
   * Resolve the on-disk folder name for a character (HUMAN_READABLE_FOLDERS).
   * Returns the stored `folder_name` slug when set, falling back to the opaque
   * `id` when it is empty (legacy / pre-migration rows — `folder_name` is
   * `notNull` default `''`). Every `this.folder.*` call routes through here, so
   * the store→facade boundary is the single place that turns a DB row into an
   * on-disk folder name; `CharacterFolder` / `ContentStore` stay path-ignorant
   * and just receive the resolved name as their `id` arg.
   */
  private folderOf(id: string, row?: typeof characters.$inferSelect): string {
    return row?.folderName || id;
  }

  /**
   * Public async folder resolver for API-layer collaborators (asset-service,
   * character-runtime, import) that do NOT have the Character row in scope
   * (HUMAN_READABLE_FOLDERS Phase 3a). Loads `folder_name` and falls back to
   * the opaque id for legacy/pre-migration rows — the async, DB-reading twin
   * of the private sync `folderOf`. Every character-folder I/O site outside
   * the store routes through here so avatars/gallery/imports follow the
   * content into the renamed folder once Phase 3b flips to slugs.
   */
  async resolveFolderName(characterId: string): Promise<string> {
    const row = await this.db.select({ folderName: characters.folderName })
      .from(characters)
      .where(eq(characters.id, characterId))
      .get();
    return row?.folderName || characterId;
  }

  // ─── Row mapper ────────────────────────────────────────────────────────────

  private mapRow(row: typeof characters.$inferSelect): Character {
    return {
      id: row.id,
      slug: deriveSlug(row.name),
      name: row.name,
      description: row.description,
      personalitySummary: row.personalitySummary,
      defaultScenario: row.defaultScenario,
      firstMessage: row.firstMessage,
      mesExample: row.mesExample,
      mesExampleMode: row.mesExampleMode,
      mesExampleDepth: row.mesExampleDepth,
      alternateGreetings: JSON.parse(row.alternateGreetingsJson),
      postHistoryInstructions: row.postHistoryInstructions,
      creatorNotes: row.creatorNotes,
      characterBook: row.characterBookJson ? JSON.parse(row.characterBookJson) : null,
      depthPrompt: row.depthPrompt,
      depthPromptDepth: row.depthPromptDepth,
      depthPromptRole: row.depthPromptRole,
      extensions: JSON.parse(row.extensionsJson),
      systemPrompt: row.systemPrompt,
      tags: JSON.parse(row.tagsJson),
      avatarAssetId: row.avatarAssetId,
      avatarFullAssetId: row.avatarFullAssetId,
      avatarCropJson: row.avatarCropJson ?? null,
      avatarExt: row.avatarExt ?? null,
      avatarFullExt: row.avatarFullExt ?? null,
      avatarSourceAssetId: row.avatarSourceAssetId ?? null,
      includeGalleryInPrompt: row.includeGalleryInPrompt,
      includeAvatarInPrompt: row.includeAvatarInPrompt,
      avatarDescription: row.avatarDescription ?? null,
      status: row.status as Character['status'],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Seed for a character's stored `folder_name` (HUMAN_READABLE_FOLDERS). Same
 * transform as {@link deriveSlug}; kept as a distinct name so the folder-name
 * rule can diverge from the read-time `slug` if ever needed. This is only the
 * SEED — {@link CharacterStore.ensureUniqueFolderName} collision-resolves it
 * (`oliver` → `oliver-2` → `oliver-3`) before storing.
 */
export function deriveFolderName(name: string): string {
  return deriveSlug(name);
}
