import { eq, and, isNull } from 'drizzle-orm';
import {
  experienceVisuals,
  experienceChatConfigs,
  experiencePromptOverrides,
} from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

// ─── Return types (store-level row shapes) ───────────────────────────────────
//
// These mirror the `experience_*` tables. The Wave 3 service layer maps them to
// canonical domain entities (@vibe-tavern/domain ExperienceVisual, etc.) at the
// API boundary, branding raw ids where the domain requires it. Kept as plain
// row types here for the same reason DiceRollStore keeps DiceRoll: the store is
// the persistence authority, not the domain contract.

export interface ExperienceVisualRow {
  id: string;
  name: string;
  source: string;
  sourceHash: string;
  apiVersion: number;
  compatibleManifestIds: string[];
  scopeType: string;
  characterId: string | null;
  personaId: string | null;
  chatId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExperienceChatConfigRow {
  id: string;
  chatId: string;
  enabled: boolean;
  scriptId: string | null;
  visualId: string | null;
  capabilityGrants: string[];
  contextMode: string;
  launcherVisible: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExperiencePromptOverrideRow {
  id: string;
  scopeType: string;
  characterId: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Input types ─────────────────────────────────────────────────────────────

export interface CreateVisualData {
  name: string;
  source: string;
  apiVersion: number;
  compatibleManifestIds?: string[];
  scopeType?: string;
  characterId?: string | null;
  personaId?: string | null;
  chatId?: string | null;
}

export interface UpdateVisualData {
  name?: string;
  source?: string;
  apiVersion?: number;
  compatibleManifestIds?: string[];
  scopeType?: string;
  characterId?: string | null;
  personaId?: string | null;
  chatId?: string | null;
}

export interface UpdateChatConfigData {
  enabled?: boolean;
  scriptId?: string | null;
  visualId?: string | null;
  capabilityGrants?: string[];
  contextMode?: string;
  launcherVisible?: boolean;
}

// ─── Store ───────────────────────────────────────────────────────────────────

/**
 * Interactive-runtime resource persistence (INTERACTIVE_RUNTIME_FOUNDATION_PLAN,
 * Wave 2 / IR-21).
 *
 * Owns the three non-session resource tables:
 *  - `experience_visuals` — editable HTML/CSS/JS bundles (CRUD + source hash);
 *  - `experience_chat_configs` — the per-chat Chat Add-on row (one per chat);
 *  - `experience_prompt_overrides` — one global + per-character model prompt.
 *
 * Visual source is stored inline as text (no dual-write JSON file — visuals are
 * Vibe-Tavern-internal, unlike scripts which participate in the portable card
 * format). The source hash uses the same SHA-256 algorithm as the IR-12 kernel
 * so a visual's stored hash is directly comparable to a discovered rules hash.
 * Trust invalidation after an edit is recorded by the changing sourceHash; the
 * Wave 8 trust layer compares stored-vs-trusted hashes.
 */
export class ExperienceResourceStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  // ─── Visuals ─────────────────────────────────────────────────────────────

  async createVisual(data: CreateVisualData): Promise<ExperienceVisualRow> {
    const id = this.idGen.next('xv');
    const now = this.clock.now();
    const sourceHash = hashSource(data.source);
    const [row] = await this.db
      .insert(experienceVisuals)
      .values({
        id,
        name: data.name,
        source: data.source,
        sourceHash,
        apiVersion: data.apiVersion,
        compatibleManifestIdsJson: JSON.stringify(data.compatibleManifestIds ?? []),
        scopeType: data.scopeType ?? 'global',
        characterId: data.characterId ?? null,
        personaId: data.personaId ?? null,
        chatId: data.chatId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return this.mapRowVisual(row!);
  }

  async getVisualById(id: string): Promise<ExperienceVisualRow | null> {
    const row = await this.db
      .select()
      .from(experienceVisuals)
      .where(eq(experienceVisuals.id, id))
      .get();
    return row ? this.mapRowVisual(row) : null;
  }

  async updateVisual(id: string, data: UpdateVisualData): Promise<ExperienceVisualRow> {
    const now = this.clock.now();
    const values: Partial<typeof experienceVisuals.$inferInsert> = { updatedAt: now };
    if (data.name !== undefined) values.name = data.name;
    if (data.source !== undefined) {
      values.source = data.source;
      values.sourceHash = hashSource(data.source);
    }
    if (data.apiVersion !== undefined) values.apiVersion = data.apiVersion;
    if (data.compatibleManifestIds !== undefined) {
      values.compatibleManifestIdsJson = JSON.stringify(data.compatibleManifestIds);
    }
    if (data.scopeType !== undefined) values.scopeType = data.scopeType;
    if (data.characterId !== undefined) values.characterId = data.characterId;
    if (data.personaId !== undefined) values.personaId = data.personaId;
    if (data.chatId !== undefined) values.chatId = data.chatId;

    const [row] = await this.db
      .update(experienceVisuals)
      .set(values)
      .where(eq(experienceVisuals.id, id))
      .returning();
    if (!row) throw new Error(`Experience visual '${id}' not found after update`);
    return this.mapRowVisual(row);
  }

  async deleteVisual(id: string): Promise<void> {
    await this.db.delete(experienceVisuals).where(eq(experienceVisuals.id, id)).run();
  }

  /**
   * List visuals visible to a scope. Global visuals are always returned; a
   * character/persona/chat scope additionally returns its directly-owned visual.
   * (Junction linking — like scriptLinks — is not part of V1 for visuals.)
   */
  async listVisualsForScope(
    scopeType: string,
    ownerId: string | null,
  ): Promise<ExperienceVisualRow[]> {
    if (scopeType === 'global' || ownerId === null) {
      const rows = await this.db
        .select()
        .from(experienceVisuals)
        .where(eq(experienceVisuals.scopeType, 'global'))
        .all();
      return rows.map((r) => this.mapRowVisual(r));
    }
    const ownerCol =
      scopeType === 'character'
        ? experienceVisuals.characterId
        : scopeType === 'persona'
          ? experienceVisuals.personaId
          : experienceVisuals.chatId;
    const rows = await this.db
      .select()
      .from(experienceVisuals)
      .where(and(eq(experienceVisuals.scopeType, scopeType), eq(ownerCol, ownerId)))
      .all();
    return rows.map((r) => this.mapRowVisual(r));
  }

  // ─── Chat configs (one row per chat) ─────────────────────────────────────

  async getConfigForChat(chatId: string): Promise<ExperienceChatConfigRow | null> {
    const row = await this.db
      .select()
      .from(experienceChatConfigs)
      .where(eq(experienceChatConfigs.chatId, chatId))
      .get();
    return row ? this.mapRowConfig(row) : null;
  }

  /**
   * Get the chat's add-on config, creating a default disabled row if absent.
   * The unique(chatId) index makes this safe against racing inserts (the second
   * insert would violate the constraint and is retried by reading the winner).
   */
  async getOrCreateConfigForChat(chatId: string): Promise<ExperienceChatConfigRow> {
    const existing = await this.getConfigForChat(chatId);
    if (existing) return existing;

    const id = this.idGen.next('xcc');
    const now = this.clock.now();
    try {
      const [row] = await this.db
        .insert(experienceChatConfigs)
        .values({
          id,
          chatId,
          enabled: false,
          scriptId: null,
          visualId: null,
          capabilityGrantsJson: '[]',
          contextMode: 'none',
          launcherVisible: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return this.mapRowConfig(row!);
    } catch {
      // Racing insert on unique(chatId) — the winner is now persisted; read it.
      const winner = await this.getConfigForChat(chatId);
      if (winner) return winner;
      throw new Error(`Failed to create experience config for chat '${chatId}'`);
    }
  }

  async updateConfig(chatId: string, data: UpdateChatConfigData): Promise<ExperienceChatConfigRow> {
    const config = await this.getOrCreateConfigForChat(chatId);
    const now = this.clock.now();
    const values: Partial<typeof experienceChatConfigs.$inferInsert> = { updatedAt: now };
    if (data.enabled !== undefined) values.enabled = data.enabled;
    if (data.scriptId !== undefined) values.scriptId = data.scriptId;
    if (data.visualId !== undefined) values.visualId = data.visualId;
    if (data.capabilityGrants !== undefined) {
      values.capabilityGrantsJson = JSON.stringify(data.capabilityGrants);
    }
    if (data.contextMode !== undefined) values.contextMode = data.contextMode;
    if (data.launcherVisible !== undefined) values.launcherVisible = data.launcherVisible;

    const [row] = await this.db
      .update(experienceChatConfigs)
      .set(values)
      .where(eq(experienceChatConfigs.id, config.id))
      .returning();
    if (!row) throw new Error(`Experience config for chat '${chatId}' not found after update`);
    return this.mapRowConfig(row);
  }

  async deleteConfig(chatId: string): Promise<void> {
    await this.db
      .delete(experienceChatConfigs)
      .where(eq(experienceChatConfigs.chatId, chatId))
      .run();
  }

  // ─── Prompt overrides (global + per-character) ───────────────────────────

  async getGlobalOverride(): Promise<ExperiencePromptOverrideRow | null> {
    const row = await this.db
      .select()
      .from(experiencePromptOverrides)
      .where(
        and(eq(experiencePromptOverrides.scopeType, 'global'), isNull(experiencePromptOverrides.characterId)),
      )
      .get();
    return row ? this.mapRowOverride(row) : null;
  }

  async getOverrideForCharacter(characterId: string): Promise<ExperiencePromptOverrideRow | null> {
    const row = await this.db
      .select()
      .from(experiencePromptOverrides)
      .where(
        and(
          eq(experiencePromptOverrides.scopeType, 'character'),
          eq(experiencePromptOverrides.characterId, characterId),
        ),
      )
      .get();
    return row ? this.mapRowOverride(row) : null;
  }

  /** Upsert the single global override (scope 'global', character_id NULL). */
  async setGlobalOverride(content: string): Promise<ExperiencePromptOverrideRow> {
    const existing = await this.getGlobalOverride();
    const now = this.clock.now();
    if (existing) {
      const [row] = await this.db
        .update(experiencePromptOverrides)
        .set({ content, updatedAt: now })
        .where(eq(experiencePromptOverrides.id, existing.id))
        .returning();
      return this.mapRowOverride(row!);
    }
    const id = this.idGen.next('xpo');
    const [row] = await this.db
      .insert(experiencePromptOverrides)
      .values({
        id,
        scopeType: 'global',
        characterId: null,
        content,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return this.mapRowOverride(row!);
  }

  /** Upsert the per-character override (scope 'character', character_id set). */
  async setOverrideForCharacter(
    characterId: string,
    content: string,
  ): Promise<ExperiencePromptOverrideRow> {
    const existing = await this.getOverrideForCharacter(characterId);
    const now = this.clock.now();
    if (existing) {
      const [row] = await this.db
        .update(experiencePromptOverrides)
        .set({ content, updatedAt: now })
        .where(eq(experiencePromptOverrides.id, existing.id))
        .returning();
      return this.mapRowOverride(row!);
    }
    const id = this.idGen.next('xpo');
    const [row] = await this.db
      .insert(experiencePromptOverrides)
      .values({
        id,
        scopeType: 'character',
        characterId,
        content,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return this.mapRowOverride(row!);
  }

  async deleteOverrideForCharacter(characterId: string): Promise<void> {
    await this.db
      .delete(experiencePromptOverrides)
      .where(
        and(
          eq(experiencePromptOverrides.scopeType, 'character'),
          eq(experiencePromptOverrides.characterId, characterId),
        ),
      )
      .run();
  }

  /**
   * Effective override resolution for a character: the character-specific
   * override wins over the global one (matching the fixed prompt order where a
   * character override follows the global user override). Returns null when
   * neither layer is set.
   */
  async getEffectiveOverride(characterId: string | null): Promise<ExperiencePromptOverrideRow | null> {
    if (characterId !== null) {
      const per = await this.getOverrideForCharacter(characterId);
      if (per) return per;
    }
    return this.getGlobalOverride();
  }

  // ─── Row mappers ─────────────────────────────────────────────────────────

  private mapRowVisual(row: typeof experienceVisuals.$inferSelect): ExperienceVisualRow {
    return {
      id: row.id,
      name: row.name,
      source: row.source,
      sourceHash: row.sourceHash,
      apiVersion: row.apiVersion,
      compatibleManifestIds: parseStringArray(row.compatibleManifestIdsJson),
      scopeType: row.scopeType,
      characterId: row.characterId,
      personaId: row.personaId,
      chatId: row.chatId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapRowConfig(row: typeof experienceChatConfigs.$inferSelect): ExperienceChatConfigRow {
    return {
      id: row.id,
      chatId: row.chatId,
      enabled: row.enabled,
      scriptId: row.scriptId,
      visualId: row.visualId,
      capabilityGrants: parseStringArray(row.capabilityGrantsJson),
      contextMode: row.contextMode,
      launcherVisible: row.launcherVisible,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapRowOverride(
    row: typeof experiencePromptOverrides.$inferSelect,
  ): ExperiencePromptOverrideRow {
    return {
      id: row.id,
      scopeType: row.scopeType,
      characterId: row.characterId,
      content: row.content,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * SHA-256 of the source body — the SAME algorithm as the IR-12 kernel's
 * `hashSource` (experience-sandbox.ts) and the IR-12 discovery `sourceHash`. A
 * visual's stored hash is thus directly comparable to a discovered rules hash,
 * and a source edit (new hash) invalidates exact-revision trust.
 */
function hashSource(source: string): string {
  return new Bun.CryptoHasher('sha256')
    .update(new TextEncoder().encode(source))
    .digest('hex');
}

function parseStringArray(json: string): string[] {
  const parsed = JSON.parse(json) as unknown;
  return Array.isArray(parsed) ? (parsed.filter((v) => typeof v === 'string') as string[]) : [];
}
