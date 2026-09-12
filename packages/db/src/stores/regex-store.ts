import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import {
  brandId,
  REGEX_PLACEMENT,
  REGEX_TARGET_TYPE,
} from '@vibe-tavern/domain';
import type {
  RegexLink,
  RegexPlacement,
  RegexPreset,
  RegexPresetId,
  RegexProfile,
  RegexProfileId,
  RegexProfileLink,
  RegexSubstituteMode,
  RegexTargetType,
} from '@vibe-tavern/domain';

import type { AppDb } from '../db-connection.js';
import {
  regexLinks,
  regexPresets,
  regexProfileLinks,
  regexProfiles,
} from '../db-schema.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

// ─── Input types ──────────────────────────────────────────────────────────────

/** Creation input — the full domain shape minus store-generated columns.
 *  `profileId` stays optional: membership is a store operation (attach/detach),
 *  creation always starts standalone. */
export type CreateRegexPresetData = Omit<
  RegexPreset,
  'id' | 'createdAt' | 'updatedAt' | 'profileId'
> & {
  profileId?: RegexProfileId | null;
};

/** Update patch — every field optional except immutable identity/timestamps. */
export type UpdateRegexPresetData = Partial<Omit<RegexPreset, 'id' | 'createdAt'>>;

/** Creation input for a profile (R-13) — minus store-generated columns. */
export type CreateRegexProfileData = Omit<RegexProfile, 'id' | 'createdAt' | 'updatedAt'>;

/** Update patch for a profile — every field optional except identity/timestamps. */
export type UpdateRegexProfileData = Partial<Omit<RegexProfile, 'id' | 'createdAt'>>;

/** Profile deletion mode (R-13, owner-approved): `keep` = member rules survive
 *  as standalone (folder metaphor); `cascade` = members are deleted with their
 *  links. */
export type DeleteRegexProfileMode = 'keep' | 'cascade';

// ─── JSON round-trip helpers (imported-data hygiene) ──────────────────────────
//
// Array columns persist as JSON text. Rows written by ST-import may carry
// hand-edited or truncated JSON — parsing degrades to the column default
// instead of throwing so one broken row can never take down listAll/resolver
// reads (the chat path calls the resolver on EVERY generation).

const DEFAULT_PLACEMENT_JSON = JSON.stringify([REGEX_PLACEMENT.AiOutput]);

function parseTrimStrings(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

function isRegexPlacement(v: unknown): v is RegexPlacement {
  return typeof v === 'number' && Object.values(REGEX_PLACEMENT).some((p) => p === v);
}

function parsePlacement(raw: string): RegexPlacement[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return parsePlacement(DEFAULT_PLACEMENT_JSON);
    return parsed.filter(isRegexPlacement);
  } catch {
    return parsePlacement(DEFAULT_PLACEMENT_JSON);
  }
}

function isRegexTargetType(v: string): v is RegexTargetType {
  return v === REGEX_TARGET_TYPE.Character || v === REGEX_TARGET_TYPE.Preset;
}

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Store for named SillyTavern-parity regex presets (REGEX_EXTENSION_PLAN RX-4)
 * plus their M:N bindings. Unlike scripts/lorebooks there are NO home-scope FK
 * columns on `regex_presets`: visibility comes ONLY from the resolver's three
 * sources — global flag ∪ character-bound ∪ preset-bound junction links.
 *
 * Persona is excluded by design: a regex preset is content-transforming
 * machinery bound to characters and prompt presets, not persona-scoped
 * knowledge — the third instance of the lorebook/script junction pattern
 * deliberately narrows the target vocabulary to {'character','preset'}.
 */
export class RegexStore {
  private readonly db: AppDb;
  private readonly clock: StoreClock;
  private readonly idGen: StoreIdGenerator;

  constructor(db: AppDb, options?: { clock?: StoreClock; idGenerator?: StoreIdGenerator }) {
    this.db = db;
    const runtime = resolveStoreRuntime(options);
    this.clock = runtime.clock;
    this.idGen = runtime.idGenerator;
  }

  // ─── Read operations ───────────────────────────────────────────────────────

  /** All presets ordered for a stable overview view (sortOrder, then name). */
  async listAll(): Promise<RegexPreset[]> {
    const rows = await this.db
      .select()
      .from(regexPresets)
      .orderBy(asc(regexPresets.sortOrder), asc(regexPresets.name))
      .all();
    return rows.map((r) => this.mapRow(r));
  }

  async getById(id: string): Promise<RegexPreset | null> {
    const row = await this.db.select().from(regexPresets).where(eq(regexPresets.id, id)).get();
    return row ? this.mapRow(row) : null;
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  async create(input: CreateRegexPresetData): Promise<RegexPreset> {
    const id = this.idGen.next('regex_preset');
    const now = this.clock.now();
    const [row] = await this.db
      .insert(regexPresets)
      .values({
        id,
        name: input.name,
        findRegex: input.findRegex,
        replaceString: input.replaceString,
        trimStringsJson: JSON.stringify(input.trimStrings),
        substituteRegex: input.substituteRegex,
        disabled: input.disabled ? 1 : 0,
        markdownOnly: input.markdownOnly ? 1 : 0,
        promptOnly: input.promptOnly ? 1 : 0,
        runOnEdit: input.runOnEdit ? 1 : 0,
        minDepth: input.minDepth,
        maxDepth: input.maxDepth,
        placementJson: JSON.stringify(input.placement),
        isGlobal: input.isGlobal ? 1 : 0,
        sortOrder: input.sortOrder,
        // Membership is store-managed: creation always starts standalone.
        profileId: input.profileId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return this.mapRow(row!);
  }

  /** Patch-apply update; bumps `updatedAt`. Returns null when id is unknown. */
  async update(id: string, patch: UpdateRegexPresetData): Promise<RegexPreset | null> {
    const now = this.clock.now();
    const values: Partial<typeof regexPresets.$inferInsert> = { updatedAt: now };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.findRegex !== undefined) values.findRegex = patch.findRegex;
    if (patch.replaceString !== undefined) values.replaceString = patch.replaceString;
    if (patch.trimStrings !== undefined) values.trimStringsJson = JSON.stringify(patch.trimStrings);
    if (patch.substituteRegex !== undefined) values.substituteRegex = patch.substituteRegex;
    if (patch.disabled !== undefined) values.disabled = patch.disabled ? 1 : 0;
    if (patch.markdownOnly !== undefined) values.markdownOnly = patch.markdownOnly ? 1 : 0;
    if (patch.promptOnly !== undefined) values.promptOnly = patch.promptOnly ? 1 : 0;
    if (patch.runOnEdit !== undefined) values.runOnEdit = patch.runOnEdit ? 1 : 0;
    if (patch.minDepth !== undefined) values.minDepth = patch.minDepth;
    if (patch.maxDepth !== undefined) values.maxDepth = patch.maxDepth;
    if (patch.placement !== undefined) values.placementJson = JSON.stringify(patch.placement);
    if (patch.isGlobal !== undefined) values.isGlobal = patch.isGlobal ? 1 : 0;
    if (patch.sortOrder !== undefined) values.sortOrder = patch.sortOrder;
    if (patch.profileId !== undefined) values.profileId = patch.profileId ?? null;

    const [row] = await this.db
      .update(regexPresets)
      .set(values)
      .where(eq(regexPresets.id, id))
      .returning();
    return row ? this.mapRow(row) : null;
  }

  /** Deletes the preset; its junction links cascade away via the FK. */
  async delete(id: string): Promise<void> {
    await this.db.delete(regexPresets).where(eq(regexPresets.id, id)).run();
  }

  // ─── Active-preset resolution (pipeline entry point) ────────────────────────

  /**
   * Returns all enabled presets visible to a generation, sorted by sortOrder
   * (stable tiebreak: id). Three sources, Set-deduped:
   *
   * 1. GLOBAL — `isGlobal` presets apply to every chat regardless of links.
   * 2. CHARACTER-BOUND — presets junction-linked to the chat's character.
   * 3. PRESET-BOUND — presets junction-linked to the active prompt preset.
   * 4. PROFILE-GATED (R-13) — member rules of an enabled profile that is
   *    reachable in this chat context (profile global OR profile bound to the
   *    chat's character/prompt preset).
   *
   * Lorebook-model gating (owner decisions, REGEX_V13_FOLLOWUP R-13): while a
   * rule is a MEMBER of a profile (profileId != null), its OWN isGlobal flag
   * and own `regexLinks` are INERT — sources 1–3 therefore exclude members
   * (profileId IS NULL), and only the profile gate (source 4) can surface a
   * member. A member fires iff profile.enabled (not disabled) AND
   * (profile.isGlobal OR profile bound to this chat context) AND the rule
   * itself is not disabled. The rule's own binding data is preserved in the
   * DB untouched and reactivates on detach (ownership is exclusive — a rule
   * lives in exactly one profile or standalone).
   *
   * Persona is NOT a source by design: regex presets transform content for a
   * character/preset pair, they are not persona-scoped knowledge (see class
   * doc). Placement/depth filtering is intentionally NOT done here — the pure
   * engine's `filterRegexPresets` applies it per application site (hook +
   * message depth), while this resolver answers "what CAN act in this chat".
   */
  async resolveActiveRegexPresets(opts: {
    characterId: string | null;
    presetId: string | null;
  }): Promise<RegexPreset[]> {
    const ids = new Set<string>();

    // Source 1: global presets (standalone only — members gate via profile).
    const globalRows = await this.db
      .select({ id: regexPresets.id })
      .from(regexPresets)
      .where(
        and(
          eq(regexPresets.isGlobal, 1),
          eq(regexPresets.disabled, 0),
          isNull(regexPresets.profileId),
        ),
      )
      .all();
    for (const r of globalRows) ids.add(r.id);

    // Source 2: character-bound (junction innerJoin keeps disabled out;
    // standalone-only — members gate via profile).
    if (opts.characterId != null && opts.characterId !== '') {
      const charRows = await this.db
        .select({ presetId: regexLinks.regexPresetId })
        .from(regexLinks)
        .innerJoin(
          regexPresets,
          and(
            eq(regexLinks.regexPresetId, regexPresets.id),
            eq(regexPresets.disabled, 0),
            isNull(regexPresets.profileId),
          ),
        )
        .where(
          and(
            eq(regexLinks.targetType, REGEX_TARGET_TYPE.Character),
            eq(regexLinks.targetId, opts.characterId),
          ),
        )
        .all();
      for (const r of charRows) ids.add(r.presetId);
    }

    // Source 3: prompt-preset-bound (standalone-only).
    if (opts.presetId != null && opts.presetId !== '') {
      const presetRows = await this.db
        .select({ presetId: regexLinks.regexPresetId })
        .from(regexLinks)
        .innerJoin(
          regexPresets,
          and(
            eq(regexLinks.regexPresetId, regexPresets.id),
            eq(regexPresets.disabled, 0),
            isNull(regexPresets.profileId),
          ),
        )
        .where(
          and(
            eq(regexLinks.targetType, REGEX_TARGET_TYPE.Preset),
            eq(regexLinks.targetId, opts.presetId),
          ),
        )
        .all();
      for (const r of presetRows) ids.add(r.presetId);
    }

    // Source 4 (R-13): profile-gated members. Gather the set of ACTIVE
    // profiles (enabled AND globally-reachable-or-bound-to-this-chat), then
    // collect their non-disabled member rules.
    const enabledProfiles = await this.db
      .select({ id: regexProfiles.id, isGlobal: regexProfiles.isGlobal })
      .from(regexProfiles)
      .where(eq(regexProfiles.disabled, 0))
      .all();
    if (enabledProfiles.length > 0) {
      const boundProfileIds = new Set<string>();
      // Profile char-bound links (junction rows may point at profiles that
      // are now disabled — intersect with the enabled set below).
      if (opts.characterId != null && opts.characterId !== '') {
        const rows = await this.db
          .select({ profileId: regexProfileLinks.regexProfileId })
          .from(regexProfileLinks)
          .where(
            and(
              eq(regexProfileLinks.targetType, REGEX_TARGET_TYPE.Character),
              eq(regexProfileLinks.targetId, opts.characterId),
            ),
          )
          .all();
        for (const r of rows) boundProfileIds.add(r.profileId);
      }
      // Profile preset-bound links.
      if (opts.presetId != null && opts.presetId !== '') {
        const rows = await this.db
          .select({ profileId: regexProfileLinks.regexProfileId })
          .from(regexProfileLinks)
          .where(
            and(
              eq(regexProfileLinks.targetType, REGEX_TARGET_TYPE.Preset),
              eq(regexProfileLinks.targetId, opts.presetId),
            ),
          )
          .all();
        for (const r of rows) boundProfileIds.add(r.profileId);
      }
      const activeProfileIds: string[] = [];
      for (const p of enabledProfiles) {
        if (p.isGlobal === 1 || boundProfileIds.has(p.id)) activeProfileIds.push(p.id);
      }
      if (activeProfileIds.length > 0) {
        const memberRows = await this.db
          .select({ id: regexPresets.id })
          .from(regexPresets)
          .where(
            and(
              inArray(regexPresets.profileId, activeProfileIds),
              eq(regexPresets.disabled, 0),
            ),
          )
          .all();
        for (const r of memberRows) ids.add(r.id);
      }
    }

    if (ids.size === 0) return [];

    const rows = await this.db
      .select()
      .from(regexPresets)
      .where(inArray(regexPresets.id, [...ids]))
      .all();

    return rows
      .map((r) => this.mapRow(r))
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // ─── Link management (mirrors ScriptStore link methods) ───────────────────

  /**
   * Get all junction links for a preset — its character/prompt-preset
   * bindings. Unknown future target kinds (if any migration ever adds one)
   * are skipped, not thrown: reads never crash on forward-compatible data.
   */
  async getLinks(regexPresetId: string): Promise<RegexLink[]> {
    const rows = await this.db
      .select()
      .from(regexLinks)
      .where(eq(regexLinks.regexPresetId, regexPresetId))
      .all();
    return rows.flatMap((r) => {
      if (!isRegexTargetType(r.targetType)) return [];
      return [
        {
          regexPresetId: brandId<RegexPresetId>(r.regexPresetId),
          targetType: r.targetType,
          targetId: r.targetId,
        },
      ];
    });
  }

  /**
   * Replace all links for a preset. Deletes existing and inserts new ones in a
   * synchronous-callback transaction (ASYNC_TRANSACTION_AUDIT step 3 shape):
   * a failure on a later insert rolls the delete back too, so the prior
   * complete binding graph survives instead of being wiped to empty.
   */
  async setLinks(
    regexPresetId: string,
    links: Array<{ targetType: RegexTargetType; targetId: string }>,
  ): Promise<RegexLink[]> {
    // Dedup by (targetType, targetId) BEFORE the delete: the composite PK
    // would reject a duplicate tuple mid-insert — AFTER the old set is already
    // deleted. Normalizing first keeps the replace whole.
    const seen = new Set<string>();
    const unique: Array<{ targetType: RegexTargetType; targetId: string }> = [];
    for (const link of links) {
      const key = JSON.stringify([link.targetType, link.targetId]);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(link);
    }

    this.db.transaction((tx) => {
      tx.delete(regexLinks).where(eq(regexLinks.regexPresetId, regexPresetId)).run();
      for (const link of unique) {
        tx.insert(regexLinks)
          .values({ regexPresetId, targetType: link.targetType, targetId: link.targetId })
          .run();
      }
    });
    return this.getLinks(regexPresetId);
  }

  /** Add a single link (idempotent — ignores duplicates via the composite PK). */
  async addLink(regexPresetId: string, targetType: RegexTargetType, targetId: string): Promise<void> {
    await this.db
      .insert(regexLinks)
      .values({ regexPresetId, targetType, targetId })
      .onConflictDoNothing()
      .run();
  }

  /** Remove a single link. */
  async removeLink(regexPresetId: string, targetType: RegexTargetType, targetId: string): Promise<void> {
    await this.db
      .delete(regexLinks)
      .where(
        and(
          eq(regexLinks.regexPresetId, regexPresetId),
          eq(regexLinks.targetType, targetType),
          eq(regexLinks.targetId, targetId),
        ),
      )
      .run();
  }

  /**
   * Remove every link targeting one entity (owner's policy B for regex on
   * entity deletion, R-10 in REGEX_V13_FOLLOWUP): the PRESETS survive —
   * "came with the card, stay in the manager for manual rebinding" — but
   * their links to the deleted character must not, because nothing can ever
   * resolve them again (chats cascade away with the character FK) and the
   * R-7 bindings UI would otherwise render a nameless ghost row. `targetId`
   * is a polymorphic text column without an FK, so this cleanup can only be
   * app-level.
   */
  async deleteLinksForTarget(targetType: RegexTargetType, targetId: string): Promise<void> {
    await this.db
      .delete(regexLinks)
      .where(and(eq(regexLinks.targetType, targetType), eq(regexLinks.targetId, targetId)))
      .run();
  }

  // ─── Profile CRUD + membership (R-13) ────────────────────────────────────

  /** All profiles ordered for a stable overview (sortOrder, then name). */
  async listProfiles(): Promise<RegexProfile[]> {
    const rows = await this.db
      .select()
      .from(regexProfiles)
      .orderBy(asc(regexProfiles.sortOrder), asc(regexProfiles.name))
      .all();
    return rows.map((r) => this.mapProfileRow(r));
  }

  async getProfileById(id: string): Promise<RegexProfile | null> {
    const row = await this.db.select().from(regexProfiles).where(eq(regexProfiles.id, id)).get();
    return row ? this.mapProfileRow(row) : null;
  }

  /** Create a profile. Rules join it via attachRule — never at creation. */
  async createProfile(input: CreateRegexProfileData): Promise<RegexProfile> {
    const id = this.idGen.next('regex_profile');
    const now = this.clock.now();
    const [row] = await this.db
      .insert(regexProfiles)
      .values({
        id,
        name: input.name,
        disabled: input.disabled ? 1 : 0,
        isGlobal: input.isGlobal ? 1 : 0,
        sortOrder: input.sortOrder,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return this.mapProfileRow(row!);
  }

  /** Patch-apply update; bumps `updatedAt`. Returns null when id is unknown. */
  async updateProfile(id: string, patch: UpdateRegexProfileData): Promise<RegexProfile | null> {
    const now = this.clock.now();
    const values: Partial<typeof regexProfiles.$inferInsert> = { updatedAt: now };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.disabled !== undefined) values.disabled = patch.disabled ? 1 : 0;
    if (patch.isGlobal !== undefined) values.isGlobal = patch.isGlobal ? 1 : 0;
    if (patch.sortOrder !== undefined) values.sortOrder = patch.sortOrder;

    const [row] = await this.db
      .update(regexProfiles)
      .set(values)
      .where(eq(regexProfiles.id, id))
      .returning();
    return row ? this.mapProfileRow(row) : null;
  }

  /**
   * Delete a profile with an explicit mode (owner-approved R-13 semantics):
   * `keep` — member rules survive as standalone (folder metaphor; the FK is
   * ON DELETE SET NULL, so the DB itself detaches them); `cascade` — members
   * are deleted explicitly first (their own regexLinks cascade via the preset
   * FK, then the profile's own junction rows cascade via the profile FK).
   */
  async deleteProfile(id: string, mode: DeleteRegexProfileMode): Promise<void> {
    if (mode === 'cascade') {
      await this.db.delete(regexPresets).where(eq(regexPresets.profileId, id)).run();
    }
    await this.db.delete(regexProfiles).where(eq(regexProfiles.id, id)).run();
  }

  /** Attach a standalone rule to a profile. Returns null when id is unknown. */
  async attachRule(profileId: string, ruleId: string): Promise<RegexPreset | null> {
    return this.update(ruleId, { profileId: brandId<RegexProfileId>(profileId) });
  }

  /**
   * Detach a rule from its profile — it reverts to standalone and its own
   * (preserved) isGlobal/links reactivate. Returns null when id is unknown.
   */
  async detachRule(ruleId: string): Promise<RegexPreset | null> {
    return this.update(ruleId, { profileId: null });
  }

  // ─── Profile link management (R-13, mirrors preset link methods) ────────

  /** Get all junction links for a profile — its character/prompt-preset
   *  bindings (the fourth instance of the junction pattern). Forward-compatible
   *  reads: unknown target kinds are skipped, not thrown. */
  async getProfileLinks(regexProfileId: string): Promise<RegexProfileLink[]> {
    const rows = await this.db
      .select()
      .from(regexProfileLinks)
      .where(eq(regexProfileLinks.regexProfileId, regexProfileId))
      .all();
    return rows.flatMap((r) => {
      if (!isRegexTargetType(r.targetType)) return [];
      return [
        {
          regexProfileId: brandId<RegexProfileId>(r.regexProfileId),
          targetType: r.targetType,
          targetId: r.targetId,
        },
      ];
    });
  }

  /**
   * Replace all links for a profile (transactional, dedup-before-delete — same
   * shape as RegexStore.setLinks: the prior binding graph survives a later
   * insert failure).
   */
  async setProfileLinks(
    regexProfileId: string,
    links: Array<{ targetType: RegexTargetType; targetId: string }>,
  ): Promise<RegexProfileLink[]> {
    const seen = new Set<string>();
    const unique: Array<{ targetType: RegexTargetType; targetId: string }> = [];
    for (const link of links) {
      const key = JSON.stringify([link.targetType, link.targetId]);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(link);
    }

    this.db.transaction((tx) => {
      tx.delete(regexProfileLinks)
        .where(eq(regexProfileLinks.regexProfileId, regexProfileId))
        .run();
      for (const link of unique) {
        tx.insert(regexProfileLinks)
          .values({ regexProfileId, targetType: link.targetType, targetId: link.targetId })
          .run();
      }
    });
    return this.getProfileLinks(regexProfileId);
  }

  /** Add a single profile link (idempotent via the composite PK). */
  async addProfileLink(
    regexProfileId: string,
    targetType: RegexTargetType,
    targetId: string,
  ): Promise<void> {
    await this.db
      .insert(regexProfileLinks)
      .values({ regexProfileId, targetType, targetId })
      .onConflictDoNothing()
      .run();
  }

  /** Remove a single profile link. */
  async removeProfileLink(
    regexProfileId: string,
    targetType: RegexTargetType,
    targetId: string,
  ): Promise<void> {
    await this.db
      .delete(regexProfileLinks)
      .where(
        and(
          eq(regexProfileLinks.regexProfileId, regexProfileId),
          eq(regexProfileLinks.targetType, targetType),
          eq(regexProfileLinks.targetId, targetId),
        ),
      )
      .run();
  }

  /**
   * Remove every profile link targeting one entity (policy B for profiles on
   * entity deletion, R-10 analog): the PROFILE survives, its link to the
   * deleted character must not. App-level — the polymorphic target column has
   * no FK.
   */
  async deleteProfileLinksForTarget(targetType: RegexTargetType, targetId: string): Promise<void> {
    await this.db
      .delete(regexProfileLinks)
      .where(and(eq(regexProfileLinks.targetType, targetType), eq(regexProfileLinks.targetId, targetId)))
      .run();
  }

  /** Member rule ids of a profile (used by the UI for cascade counts). */
  async listProfileMemberIds(regexProfileId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: regexPresets.id })
      .from(regexPresets)
      .where(eq(regexPresets.profileId, regexProfileId))
      .orderBy(asc(regexPresets.sortOrder), asc(regexPresets.name))
      .all();
    return rows.map((r) => r.id);
  }

  // ─── Row mapper ────────────────────────────────────────────────────────────

  private mapProfileRow(row: typeof regexProfiles.$inferSelect): RegexProfile {
    return {
      id: brandId<RegexProfileId>(row.id),
      name: row.name,
      disabled: row.disabled === 1,
      isGlobal: row.isGlobal === 1,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapRow(row: typeof regexPresets.$inferSelect): RegexPreset {
    return {
      id: brandId<RegexPresetId>(row.id),
      name: row.name,
      findRegex: row.findRegex,
      replaceString: row.replaceString,
      trimStrings: parseTrimStrings(row.trimStringsJson),
      substituteRegex: row.substituteRegex as RegexSubstituteMode,
      disabled: row.disabled === 1,
      markdownOnly: row.markdownOnly === 1,
      promptOnly: row.promptOnly === 1,
      runOnEdit: row.runOnEdit === 1,
      minDepth: row.minDepth,
      maxDepth: row.maxDepth,
      placement: parsePlacement(row.placementJson),
      isGlobal: row.isGlobal === 1,
      sortOrder: row.sortOrder,
      profileId: row.profileId ? brandId<RegexProfileId>(row.profileId) : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
