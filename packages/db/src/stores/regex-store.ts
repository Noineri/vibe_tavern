import { and, asc, eq, inArray } from 'drizzle-orm';

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
  RegexSubstituteMode,
  RegexTargetType,
} from '@vibe-tavern/domain';

import type { AppDb } from '../db-connection.js';
import { regexLinks, regexPresets } from '../db-schema.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

// ─── Input types ──────────────────────────────────────────────────────────────

/** Creation input — the full domain shape minus store-generated columns. */
export type CreateRegexPresetData = Omit<RegexPreset, 'id' | 'createdAt' | 'updatedAt'>;

/** Update patch — every field optional except immutable identity/timestamps. */
export type UpdateRegexPresetData = Partial<Omit<RegexPreset, 'id' | 'createdAt'>>;

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

    // Source 1: global presets.
    const globalRows = await this.db
      .select({ id: regexPresets.id })
      .from(regexPresets)
      .where(and(eq(regexPresets.isGlobal, 1), eq(regexPresets.disabled, 0)))
      .all();
    for (const r of globalRows) ids.add(r.id);

    // Source 2: character-bound (junction innerJoin keeps disabled out).
    if (opts.characterId != null && opts.characterId !== '') {
      const charRows = await this.db
        .select({ presetId: regexLinks.regexPresetId })
        .from(regexLinks)
        .innerJoin(
          regexPresets,
          and(eq(regexLinks.regexPresetId, regexPresets.id), eq(regexPresets.disabled, 0)),
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

    // Source 3: prompt-preset-bound.
    if (opts.presetId != null && opts.presetId !== '') {
      const presetRows = await this.db
        .select({ presetId: regexLinks.regexPresetId })
        .from(regexLinks)
        .innerJoin(
          regexPresets,
          and(eq(regexLinks.regexPresetId, regexPresets.id), eq(regexPresets.disabled, 0)),
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

  // ─── Row mapper ────────────────────────────────────────────────────────────

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
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
