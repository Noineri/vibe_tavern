import { eq, sql } from 'drizzle-orm';
import { characters } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';
import type { ContentStore } from '../content-store.js';
import { STORAGE_FOLDERS, IMAGE_EXTENSIONS, hashCanonicalJson } from '../file-store.js';
import { serializeCharacterFolder, parseCharacterFolder, profileFromCharacter, serializeProfileMd, type VtfCharacterContent, type FolderFileEntry } from '../vtf/index.js';
import { parseGreetingsIndex } from '../vtf/greetings.js';

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
  private readonly content: ContentStore | null;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator; content?: ContentStore | null }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
    this.content = options?.content ?? null;
  }

  // ─── Read operations ───────────────────────────────────────────────────────

  async getById(id: string): Promise<Character | null> {
    const row = await this.db.select().from(characters).where(eq(characters.id, id)).get();
    if (!row) return null;
    const char = this.mapRow(row);

    // Lazy migration: if not yet on disk, copy-forward from a legacy flat
    // file into {id}/card.json when one exists, otherwise write fresh from
    // the DB row. Either way the file lands in the per-entity folder.
    if (this.content && !row.hasFileOnDisk) {
      const migrated = await this.content.migrateFlatToFolder(STORAGE_FOLDERS.characters, id, 'card');
      let hash: string;
      if (migrated) {
        const copied = await this.content.readEntityFile<unknown>(STORAGE_FOLDERS.characters, id, 'card');
        hash = this.content.hashContent(copied);
      } else {
        const fileData = this.toFileData(char);
        hash = await this.content.writeEntityFile(STORAGE_FOLDERS.characters, id, 'card', fileData);
      }
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
    if (this.content && !row.avatarExt && row.avatarAssetId) {
      const ext = await this.content.copyAssetToEntityFolder(
        row.avatarAssetId,
        STORAGE_FOLDERS.characters,
        id,
        'avatar',
        IMAGE_EXTENSIONS,
      );
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
    if (this.content && !row.avatarFullExt && row.avatarFullAssetId) {
      const fullExt = await this.content.copyAssetToEntityFolder(
        row.avatarFullAssetId,
        STORAGE_FOLDERS.characters,
        id,
        'avatar-full',
        IMAGE_EXTENSIONS,
      );
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

    return this.applyVtfContentOverride(id, char);
  }

  /**
   * VTF-aware read: if the entity folder has a `profile.md`, parse the VTF
   * folder (profile.md + instructions.json + extensions.json + greetings/)
   * and override the DB-row content fields with it — the VTF folder is the
   * source of truth for content
   * once it exists. Falls back silently to the DB-row content when the folder
   * is absent or unreadable (legacy card.json-only or pre-migration rows).
   */
  private async applyVtfContentOverride(id: string, char: Character): Promise<Character> {
    if (!this.content) return char;
    const profileText = await this.content.readEntityTextFile(STORAGE_FOLDERS.characters, id, 'profile.md');
    if (profileText === null) return char;
    const entries = await this.readVtfFolderEntries(id);
    if (entries.length === 0) return char;
    const merged = parseCharacterFolder(entries);
    return this.mergeVtfContent(char, merged);
  }

  /**
   * Serialize a character's content fields to the VTF folder
   * (profile.md + instructions.json + extensions.json + greetings/) and return
   * a combined sha256 hash over the canonical entry set (sorted by path). The
   * combined hash is stored in `contentHash` so cache-busting and
   * change-detection work across the whole multi-file folder. Greetings are
   * rewritten wholesale (the old `greetings/` subfolder is removed first to
   * garbage-collect stale files).
   */
  private async writeVtfFolder(id: string, char: Character): Promise<string> {
    if (!this.content) throw new Error('ContentStore required for VTF writes');
    const content = this.toVtfContent(char);
    const entries = serializeCharacterFolder(content);
    // Remove stale greetings first (rename-free ids mean content edits reuse
    // filenames, but deleted alternates must not leave orphan .md files).
    await this.content.removeEntitySubfolder(STORAGE_FOLDERS.characters, id, 'greetings');
    for (const entry of entries) {
      await this.content.writeEntityTextFile(STORAGE_FOLDERS.characters, id, entry.path, entry.content);
    }
    return this.hashVtfEntries(entries);
  }

  /**
   * Read every VTF leaf file for an entity into a {@link FolderFileEntry} list.
   * `subdir` reads from a nested folder (e.g. `versions/{vid}`); the returned
   * entry `path` is always relative to the entity ROOT (no subdir prefix), so a
   * caller can write the entries back to any target unchanged.
   */
  private async readVtfEntriesAt(id: string, subdir: string): Promise<FolderFileEntry[]> {
    if (!this.content) return [];
    const prefix = subdir ? `${subdir}/` : '';
    const entries: FolderFileEntry[] = [];
    const profileMd = await this.content.readEntityTextFile(STORAGE_FOLDERS.characters, id, `${prefix}profile.md`);
    if (profileMd !== null) entries.push({ path: 'profile.md', content: profileMd });
    const instructionsJson = await this.content.readEntityTextFile(STORAGE_FOLDERS.characters, id, `${prefix}instructions.json`);
    if (instructionsJson !== null) entries.push({ path: 'instructions.json', content: instructionsJson });
    const extensionsJson = await this.content.readEntityTextFile(STORAGE_FOLDERS.characters, id, `${prefix}extensions.json`);
    if (extensionsJson !== null) entries.push({ path: 'extensions.json', content: extensionsJson });
    // Greetings are manifest-driven: read _index.yaml, then each referenced file.
    const indexYaml = await this.content.readEntityTextFile(STORAGE_FOLDERS.characters, id, `${prefix}greetings/_index.yaml`);
    if (indexYaml !== null) {
      entries.push({ path: 'greetings/_index.yaml', content: indexYaml });
      const manifest = parseGreetingsIndex(indexYaml);
      for (const row of manifest) {
        if (!row.file) continue;
        const body = await this.content.readEntityTextFile(STORAGE_FOLDERS.characters, id, `${prefix}greetings/${row.file}`);
        if (body !== null) entries.push({ path: `greetings/${row.file}`, content: body });
      }
    }
    return entries;
  }

  /** Read the root VTF folder (alias for {@link readVtfEntriesAt} with no subdir). */
  private async readVtfFolderEntries(id: string): Promise<FolderFileEntry[]> {
    return this.readVtfEntriesAt(id, '');
  }

  // ─── Version folder snapshots (VTF Phase 3) ──────────────────────────────
  // The active version's content lives at the entity root; non-active versions
  // are full folder snapshots under versions/{versionId}/. These methods move
  // the canonical VTF file set (profile.md + instructions.json + extensions.json
  // + greetings/) between root and a version slot. VersionStore orchestrates
  // them and owns the character_versions DB rows; getById stays version-agnostic
  // (it always reads the root, which always reflects the active version).

  /** Snapshot the current root VTF folder into versions/{versionId}/ (overwrites). */
  async snapshotRootToVersion(id: string, versionId: string): Promise<void> {
    if (!this.content) throw new Error('ContentStore required for VTF version snapshots');
    const entries = await this.readVtfEntriesAt(id, '');
    // Clear the target slot first so a stale snapshot leaves no orphaned greeting files.
    await this.content.removeEntitySubfolder(STORAGE_FOLDERS.characters, id, `versions/${versionId}`);
    for (const entry of entries) {
      await this.content.writeEntityTextFile(STORAGE_FOLDERS.characters, id, `versions/${versionId}/${entry.path}`, entry.content);
    }
  }

  /** Restore a version snapshot from versions/{versionId}/ to the root folder. */
  async restoreVersionToRoot(id: string, versionId: string): Promise<void> {
    if (!this.content) throw new Error('ContentStore required for VTF version snapshots');
    const entries = await this.readVtfEntriesAt(id, `versions/${versionId}`);
    if (entries.length === 0) return;
    // Clear root greetings first (GC); profile/instructions/extensions are overwritten in place.
    await this.content.removeEntitySubfolder(STORAGE_FOLDERS.characters, id, 'greetings');
    for (const entry of entries) {
      await this.content.writeEntityTextFile(STORAGE_FOLDERS.characters, id, entry.path, entry.content);
    }
  }

  /** Remove the versions/{versionId}/ subfolder. No-op if missing. */
  async removeVersionFolder(id: string, versionId: string): Promise<void> {
    if (!this.content) return;
    await this.content.removeEntitySubfolder(STORAGE_FOLDERS.characters, id, `versions/${versionId}`);
  }

  /** True if a version snapshot with a profile.md exists at versions/{versionId}/. */
  async versionFolderExists(id: string, versionId: string): Promise<boolean> {
    if (!this.content) return false;
    return this.content.entityLeafExists(STORAGE_FOLDERS.characters, id, `versions/${versionId}/profile.md`);
  }

  /** Override the content fields of a DB-row character with VTF-parsed content. Media/avatar/status/timestamps are preserved. */
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

  /** Combined sha256 over canonical VTF entries (sorted by path, content concatenated). */
  private hashVtfEntries(entries: FolderFileEntry[]): string {
    const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const combined = sorted.map((e) => `${e.path}\u0000${e.content}`).join('\u0001');
    return this.content!.hashText(combined);
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

    // Dual write: persist content to {id}/card.json in the file store
    if (this.content) {
      const hash = await this.writeVtfFolder(id, char);
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

    // Dual write: update {id}/card.json in the file store
    if (this.content) {
      const hash = await this.writeVtfFolder(id, updated);
      await this.db
        .update(characters)
        .set({ contentHash: hash, hasFileOnDisk: 1 })
        .where(eq(characters.id, id))
        .run();
    }

    return updated;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(characters).where(eq(characters.id, id)).run();
    if (this.content) {
      // Remove the whole per-entity folder (card.json, original.json,
      // avatar.*, future gallery/). Legacy flat files ({id}.json /
      // {id}.{slug}.json) are intentionally left in place — copy-forward
      // policy; they become harmless orphans.
      await this.content.deleteEntityFolder(STORAGE_FOLDERS.characters, id);
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
        avatarSourceAssetId: original.avatarSourceAssetId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const copy = this.mapRow(row!);

    // Dual write: persist copy to {newId}/card.json in the file store
    if (this.content) {
      const hash = await this.writeVtfFolder(newId, copy);
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
        const buf = await this.content.readBinary(STORAGE_FOLDERS.characters, original.id, `avatar.${original.avatarExt}`);
        if (buf) {
          await this.content.writeBinary(STORAGE_FOLDERS.characters, newId, `avatar.${original.avatarExt}`, new Uint8Array(buf));
        }
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
    if (!this.content) throw new Error('ContentStore required for VTF migration');
    if (!opts?.force) {
      // Filesystem check (not the text cache, which may be stale if the file
      // was removed out-of-band) — a character is VTF-native iff profile.md
      // physically exists in its folder.
      const exists = await this.content.entityLeafExists(STORAGE_FOLDERS.characters, id, 'profile.md');
      if (exists) return null;
    }
    const char = await this.getById(id);
    if (!char) throw new Error(`Character '${id}' not found`);
    const hash = await this.writeVtfFolder(id, char);
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
