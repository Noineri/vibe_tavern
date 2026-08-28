import { and, asc, eq, ne } from 'drizzle-orm';

import { brandId, TTS_BACKEND, TTS_LINK_MODE, TTS_TARGET_TYPE } from '@vibe-tavern/domain';
import type {
  TtsBackendSlug,
  TtsLinkMode,
  TtsProfile,
  TtsProfileConfig,
  TtsProfileId,
  TtsProfileLink,
  TtsTargetType,
} from '@vibe-tavern/domain';

import type { AppDb } from '../db-connection.js';
import { ttsProfileLinks, ttsProfiles } from '../db-schema.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

// ─── Input types ──────────────────────────────────────────────────────────────

/** Creation input — the full domain shape minus store-generated columns. */
export type CreateTtsProfileData = Omit<TtsProfile, 'id' | 'createdAt' | 'updatedAt'>;

/** Update patch — every field optional except immutable identity/timestamps. */
export type UpdateTtsProfileData = Partial<Omit<TtsProfile, 'id' | 'createdAt'>>;

// ─── JSON round-trip helpers (imported-data hygiene) ──────────────────────────
//
// The backend-specific config bag persists as JSON text. Rows written by
// import or hand-editing may carry malformed JSON — parsing degrades to the
// column default ({}) instead of throwing, so one broken row can never take
// down listAll (which the Providers modal calls on every open).

function parseConfig(raw: string): TtsProfileConfig {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as TtsProfileConfig;
  } catch {
    return {};
  }
}

function isTtsBackendSlug(v: string): v is TtsBackendSlug {
  return (Object.values(TTS_BACKEND) as string[]).includes(v);
}

function isTtsTargetType(v: string): v is TtsTargetType {
  return v === TTS_TARGET_TYPE.Character || v === TTS_TARGET_TYPE.Persona;
}

function isTtsLinkMode(v: string): v is TtsLinkMode {
  return v === TTS_LINK_MODE.Voice || v === TTS_LINK_MODE.Disabled;
}

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Store for named TTS voice profiles (TTS_PLAN TS-1) plus their voice-map
 * M:N bindings. The `[Default Voice]` pointer is a store-maintained invariant:
 * at most one profile carries `isDefault` — create({isDefault:true}) and
 * update({isDefault:true}) clear every other row first (transactionally with
 * their own write), and `setDefault` is the explicit pointer move. Deleting
 * the default profile does NOT auto-promote another: the voice map simply has
 * no default until the owner picks one (the orchestrator treats that as
 * "no narration without an explicit binding").
 *
 * Unlike RegexStore there is deliberately NO active-set resolver here: voice
 * resolution (character override → persona override → default) is a
 * client-side orchestrator concern (TTS_PLAN TS-9), not a generation-pipeline
 * gate.
 */
export class TtsStore {
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

  /** All profiles ordered for a stable list view (sortOrder, then name). */
  async listAll(): Promise<TtsProfile[]> {
    const rows = await this.db
      .select()
      .from(ttsProfiles)
      .orderBy(asc(ttsProfiles.sortOrder), asc(ttsProfiles.name))
      .all();
    return rows.map((r) => this.mapRow(r));
  }

  async getById(id: string): Promise<TtsProfile | null> {
    const row = await this.db.select().from(ttsProfiles).where(eq(ttsProfiles.id, id)).get();
    return row ? this.mapRow(row) : null;
  }

  /** The voice map's [Default Voice], or null when none is set. */
  async getDefault(): Promise<TtsProfile | null> {
    const row = await this.db
      .select()
      .from(ttsProfiles)
      .where(eq(ttsProfiles.isDefault, 1))
      .orderBy(asc(ttsProfiles.sortOrder), asc(ttsProfiles.name))
      .get();
    return row ? this.mapRow(row) : null;
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  async create(input: CreateTtsProfileData): Promise<TtsProfile> {
    const id = this.idGen.next('tts_profile');
    const now = this.clock.now();
    // Default-pointer invariant: claiming the default clears every other row —
    // atomically with the insert, so a failed insert cannot leave the voice
    // map defaultless. Sync-transaction shape (ASYNC_TRANSACTION_AUDIT): the
    // sync tx client types only support `.run()`, so the row is read back
    // after the transaction commits.
    this.db.transaction((tx) => {
      tx.insert(ttsProfiles)
        .values({
          id,
          name: input.name,
          backend: input.backend,
          configJson: JSON.stringify(input.config),
          voiceId: input.voiceId,
          narratorVoiceId: input.narratorVoiceId,
          lang: input.lang,
          sortOrder: input.sortOrder,
          isDefault: input.isDefault ? 1 : 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      if (input.isDefault) {
        tx.update(ttsProfiles).set({ isDefault: 0 }).where(ne(ttsProfiles.id, id)).run();
      }
    });
    const row = await this.db.select().from(ttsProfiles).where(eq(ttsProfiles.id, id)).get();
    return this.mapRow(row!);
  }

  /** Patch-apply update; bumps `updatedAt`. Setting `isDefault: true` moves
   *  the default pointer (clears every other row first); `isDefault: false`
   *  simply unsets this row (another row may keep the pointer — use
   *  `setDefault` for pointer moves). Returns null when id is unknown. */
  async update(id: string, patch: UpdateTtsProfileData): Promise<TtsProfile | null> {
    const now = this.clock.now();
    const values: Partial<typeof ttsProfiles.$inferInsert> = { updatedAt: now };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.backend !== undefined) values.backend = patch.backend;
    if (patch.config !== undefined) values.configJson = JSON.stringify(patch.config);
    if (patch.voiceId !== undefined) values.voiceId = patch.voiceId;
    if (patch.narratorVoiceId !== undefined) values.narratorVoiceId = patch.narratorVoiceId;
    if (patch.lang !== undefined) values.lang = patch.lang;
    if (patch.sortOrder !== undefined) values.sortOrder = patch.sortOrder;
    if (patch.isDefault !== undefined) values.isDefault = patch.isDefault ? 1 : 0;

    // Patch + default-pointer move in one transaction: clearing the other
    // rows only commits if this row actually took the flag. `.run()` shape —
    // see the create note; existence is pre-checked because the sync tx
    // client's `.run()` is typed void (no `.changes`).
    const existing = await this.db
      .select({ id: ttsProfiles.id })
      .from(ttsProfiles)
      .where(eq(ttsProfiles.id, id))
      .get();
    if (!existing) return null;
    this.db.transaction((tx) => {
      tx.update(ttsProfiles).set(values).where(eq(ttsProfiles.id, id)).run();
      if (patch.isDefault === true) {
        tx.update(ttsProfiles).set({ isDefault: 0 }).where(ne(ttsProfiles.id, id)).run();
      }
    });
    const row = await this.db.select().from(ttsProfiles).where(eq(ttsProfiles.id, id)).get();
    return row ? this.mapRow(row) : null;
  }

  /** Deletes the profile; its voice-map links cascade away via the FK. */
  async delete(id: string): Promise<void> {
    await this.db.delete(ttsProfiles).where(eq(ttsProfiles.id, id)).run();
  }

  /** Move the [Default Voice] pointer to a profile. Returns the updated
   *  profile, or null when id is unknown. */
  async setDefault(id: string): Promise<TtsProfile | null> {
    const existing = await this.getById(id);
    if (!existing) return null;
    this.db.transaction((tx) => {
      tx.update(ttsProfiles).set({ isDefault: 0 }).run();
      tx.update(ttsProfiles).set({ isDefault: 1 }).where(eq(ttsProfiles.id, id)).run();
    });
    return this.getById(id);
  }

  // ─── Link management (voice map; mirrors RegexStore link methods) ──────────

  /**
   * Get all junction links for a profile — its character/persona bindings.
   * Unknown future target kinds (if any migration ever adds one) are skipped,
   * not thrown: reads never crash on forward-compatible data. Unknown link
   * modes degrade to `voice` (same forward-compat rule).
   */
  async getLinks(ttsProfileId: string): Promise<TtsProfileLink[]> {
    const rows = await this.db
      .select()
      .from(ttsProfileLinks)
      .where(eq(ttsProfileLinks.ttsProfileId, ttsProfileId))
      .all();
    return rows.flatMap((r) => {
      if (!isTtsTargetType(r.targetType)) return [];
      return [
        {
          ttsProfileId: brandId<TtsProfileId>(r.ttsProfileId),
          targetType: r.targetType,
          targetId: r.targetId,
          mode: isTtsLinkMode(r.mode) ? r.mode : TTS_LINK_MODE.Voice,
        },
      ];
    });
  }

  /** All voice-map links across all profiles (resolver data source; the link
   *  count is small — one chat's worth of characters/personas). */
  async listAllLinks(): Promise<TtsProfileLink[]> {
    const rows = await this.db.select().from(ttsProfileLinks).all();
    return rows.flatMap((r) => {
      if (!isTtsTargetType(r.targetType)) return [];
      return [
        {
          ttsProfileId: brandId<TtsProfileId>(r.ttsProfileId),
          targetType: r.targetType,
          targetId: r.targetId,
          mode: isTtsLinkMode(r.mode) ? r.mode : TTS_LINK_MODE.Voice,
        },
      ];
    });
  }

  /**
   * Replace all links for a profile. Deletes existing and inserts new ones in a
   * synchronous-callback transaction (same shape as RegexStore.setLinks): a
   * failure on a later insert rolls the delete back too, so the prior complete
   * binding graph survives instead of being wiped to empty.
   */
  async setLinks(
    ttsProfileId: string,
    links: Array<{ targetType: TtsTargetType; targetId: string; mode?: TtsLinkMode }>,
  ): Promise<TtsProfileLink[]> {
    // Dedup by (targetType, targetId) BEFORE the delete: the composite PK
    // would reject a duplicate tuple mid-insert — AFTER the old set is already
    // deleted. Normalizing first keeps the replace whole. Later duplicates
    // win on mode (last-write semantics within one payload).
    const seen = new Map<string, { targetType: TtsTargetType; targetId: string; mode: TtsLinkMode }>();
    for (const link of links) {
      const key = JSON.stringify([link.targetType, link.targetId]);
      seen.set(key, { ...link, mode: link.mode ?? TTS_LINK_MODE.Voice });
    }
    const unique = [...seen.values()];

    this.db.transaction((tx) => {
      tx.delete(ttsProfileLinks).where(eq(ttsProfileLinks.ttsProfileId, ttsProfileId)).run();
      for (const link of unique) {
        tx.insert(ttsProfileLinks)
          .values({ ttsProfileId, targetType: link.targetType, targetId: link.targetId, mode: link.mode })
          .run();
      }
    });
    return this.getLinks(ttsProfileId);
  }

  /** Add a single link (idempotent — ignores duplicates via the composite PK). */
  async addLink(
    ttsProfileId: string,
    targetType: TtsTargetType,
    targetId: string,
    mode: TtsLinkMode = TTS_LINK_MODE.Voice,
  ): Promise<void> {
    await this.db
      .insert(ttsProfileLinks)
      .values({ ttsProfileId, targetType, targetId, mode })
      .onConflictDoNothing()
      .run();
  }

  /** Remove a single link. */
  async removeLink(ttsProfileId: string, targetType: TtsTargetType, targetId: string): Promise<void> {
    await this.db
      .delete(ttsProfileLinks)
      .where(
        and(
          eq(ttsProfileLinks.ttsProfileId, ttsProfileId),
          eq(ttsProfileLinks.targetType, targetType),
          eq(ttsProfileLinks.targetId, targetId),
        ),
      )
      .run();
  }

  /**
   * Remove every link targeting one entity (voice-map hygiene on entity
   * deletion, RegexStore.deleteLinksForTarget analog): the PROFILE survives —
   * "stays in the manager for manual rebinding" — but its link to the deleted
   * character/persona must not, because nothing can ever resolve it again and
   * the bindings UI would render a nameless ghost row. `targetId` is a
   * polymorphic text column without an FK, so this cleanup is app-level.
   */
  async deleteLinksForTarget(targetType: TtsTargetType, targetId: string): Promise<void> {
    await this.db
      .delete(ttsProfileLinks)
      .where(and(eq(ttsProfileLinks.targetType, targetType), eq(ttsProfileLinks.targetId, targetId)))
      .run();
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private mapRow(row: typeof ttsProfiles.$inferSelect): TtsProfile {
    return {
      id: brandId<TtsProfileId>(row.id),
      name: row.name,
      backend: isTtsBackendSlug(row.backend) ? row.backend : TTS_BACKEND.Kokoro,
      config: parseConfig(row.configJson),
      voiceId: row.voiceId,
      narratorVoiceId: row.narratorVoiceId ?? null,
      lang: row.lang,
      sortOrder: row.sortOrder,
      isDefault: row.isDefault === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
