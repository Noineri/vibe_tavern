import { asc, eq, ne } from 'drizzle-orm';

import { brandId, STT_BACKENDS } from '@vibe-tavern/domain';
import type { SttBackendType, SttProfile, SttProfileConfig, SttProfileId } from '@vibe-tavern/domain';

import type { AppDb } from '../db-connection.js';
import { sttProfiles } from '../db-schema.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

// ─── Input types ──────────────────────────────────────────────────────────────

/** Creation input — the full domain shape minus store-generated columns. */
export type CreateSttProfileData = Omit<SttProfile, 'id' | 'createdAt' | 'updatedAt'>;

/** Update patch — every field optional except immutable identity/timestamps. */
export type UpdateSttProfileData = Partial<Omit<SttProfile, 'id' | 'createdAt'>>;

// ─── JSON round-trip helpers (imported-data hygiene) ──────────────────────────
//
// The backend-specific config persists as JSON text. Rows written by import or
// hand-editing may carry malformed JSON — parsing degrades to the minimal
// membership-valid config ({ model: '' }, the whisper-browser member shape)
// instead of throwing, so one broken row can never take down listAll. Unlike
// TTS's loose config bag there is no empty {} member in the discriminated
// union; the empty-model degrade keeps the same "rows survive" property.

function parseConfig(raw: string): SttProfileConfig {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { model: '' };
    const config = stripConfigSecrets(parsed as Record<string, unknown>);
    const model = typeof config.model === 'string' ? config.model : '';
    const language = typeof config.language === 'string' ? config.language : undefined;
    // Endpoint presence discriminates the openai-compat member (domain
    // `SttProfileConfig`); otherwise degrade onto the whisper-browser member.
    if (typeof config.endpoint === 'string') {
      return { endpoint: config.endpoint, model, language };
    }
    return { model, language };
  } catch {
    return { model: '' };
  }
}

/** ST-1 invariant (the TE2-16 key rule applied to STT): the config blob NEVER
 *  carries the secret — it lives in the typed `api_key` column. Writes strip
 *  it so no caller (adapter, import, future script) can smuggle a key into
 *  JSON; reads strip defensively too, covering rows written by hand-editing or
 *  restored backups. */
function stripConfigSecrets(config: Record<string, unknown>): Record<string, unknown> {
  if (!('apiKey' in config)) return config;
  const clean = { ...config };
  delete clean.apiKey;
  return clean;
}

function isSttBackendType(v: string): v is SttBackendType {
  return (Object.values(STT_BACKENDS) as string[]).includes(v);
}

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Store for named STT profiles (STT_PLAN ST-1). The fallback pointer
 * (`isDefault`) is a store-maintained invariant mirroring TtsStore: at most
 * one profile carries `isDefault` — create({isDefault:true}) and
 * update({isDefault:true}) clear every other row first (transactionally with
 * their own write), and `setDefault` is the explicit pointer move. Deleting
 * the default profile does NOT auto-promote another: the scenario layer falls
 * back to "no transcription" until the owner picks one.
 *
 * The two scenario pointers (`ui_settings.activeDictationProfileId` /
 * `activeVoiceMessageProfileId`) live in UiSettingsStore, not here (ST-1).
 *
 * Unlike the realm of generation-profile stores there is deliberately NO
 * active-set resolver here: dictation/voice-message profile resolution is a
 * consumer concern (ST-4b/ST-5/ST-6), not a generation-pipeline gate.
 */
export class SttStore {
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

  /** All profiles ordered for a stable list view (name, then createdAt). */
  async listAll(): Promise<SttProfile[]> {
    const rows = await this.db
      .select()
      .from(sttProfiles)
      .orderBy(asc(sttProfiles.name), asc(sttProfiles.createdAt))
      .all();
    return rows.map((r) => this.mapRow(r));
  }

  async getById(id: string): Promise<SttProfile | null> {
    const row = await this.db.select().from(sttProfiles).where(eq(sttProfiles.id, id)).get();
    return row ? this.mapRow(row) : null;
  }

  /** The fallback profile, or null when none is set. */
  async getDefault(): Promise<SttProfile | null> {
    const row = await this.db
      .select()
      .from(sttProfiles)
      .where(eq(sttProfiles.isDefault, 1))
      .orderBy(asc(sttProfiles.name), asc(sttProfiles.createdAt))
      .get();
    return row ? this.mapRow(row) : null;
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  async create(input: CreateSttProfileData): Promise<SttProfile> {
    const id = this.idGen.next('stt_profile');
    const now = this.clock.now();
    // Default-pointer invariant: claiming the default clears every other row —
    // atomically with the insert, so a failed insert cannot leave the roster
    // defaultless. Sync-transaction shape (ASYNC_TRANSACTION_AUDIT): the sync
    // tx client types only support `.run()`, so the row is read back after the
    // transaction commits.
    this.db.transaction((tx) => {
      tx.insert(sttProfiles)
        .values({
          id,
          name: input.name,
          backend: input.backend,
          configJson: JSON.stringify(stripConfigSecrets(input.config)),
          apiKey: input.apiKey ?? null,
          emotionAnnotation: input.emotionAnnotation,
          isDefault: input.isDefault ? 1 : 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      if (input.isDefault) {
        tx.update(sttProfiles).set({ isDefault: 0 }).where(ne(sttProfiles.id, id)).run();
      }
    });
    const row = await this.db.select().from(sttProfiles).where(eq(sttProfiles.id, id)).get();
    return this.mapRow(row!);
  }

  /** Patch-apply update; bumps `updatedAt`. Setting `isDefault: true` moves
   *  the fallback pointer (clears every other row first); `isDefault: false`
   *  simply unsets this row (another row may keep the pointer — use
   *  `setDefault` for pointer moves). Returns null when id is unknown. */
  async update(id: string, patch: UpdateSttProfileData): Promise<SttProfile | null> {
    const now = this.clock.now();
    const values: Partial<typeof sttProfiles.$inferInsert> = { updatedAt: now };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.backend !== undefined) values.backend = patch.backend;
    if (patch.config !== undefined) values.configJson = JSON.stringify(stripConfigSecrets(patch.config));
    // ST-1 tri-state: apiKey is `undefined` = untouched, `""` = cleared,
    // non-empty string = set (mirrors the TE2-16 tri-state on tts_profiles).
    if (patch.apiKey !== undefined) values.apiKey = patch.apiKey === '' ? null : patch.apiKey;
    if (patch.emotionAnnotation !== undefined) values.emotionAnnotation = patch.emotionAnnotation;
    if (patch.isDefault !== undefined) values.isDefault = patch.isDefault ? 1 : 0;

    // Patch + default-pointer move in one transaction: clearing the other
    // rows only commits if this row actually took the flag. `.run()` shape —
    // see the create note; existence is pre-checked because the sync tx
    // client's `.run()` is typed void (no `.changes`).
    const existing = await this.db
      .select({ id: sttProfiles.id, backend: sttProfiles.backend })
      .from(sttProfiles)
      .where(eq(sttProfiles.id, id))
      .get();
    if (!existing) return null;
    // Backend-flip hygiene: a key is only meaningful for the backend it was
    // entered for — switching backends clears the stored key unless the SAME
    // patch provides a new one (mirrors tts-store; whisper-browser needs no
    // key at all). Keeps the "never leaks across backends" guarantee in the
    // typed-column world.
    if (
      patch.backend !== undefined &&
      patch.backend !== existing.backend &&
      (patch.apiKey === undefined || patch.apiKey === '')
    ) {
      values.apiKey = null;
    }
    this.db.transaction((tx) => {
      tx.update(sttProfiles).set(values).where(eq(sttProfiles.id, id)).run();
      if (patch.isDefault === true) {
        tx.update(sttProfiles).set({ isDefault: 0 }).where(ne(sttProfiles.id, id)).run();
      }
    });
    const row = await this.db.select().from(sttProfiles).where(eq(sttProfiles.id, id)).get();
    return row ? this.mapRow(row) : null;
  }

  /** Deletes the profile. The scenario pointers in ui_settings may dangle —
   *  they resolve back to the fallback instead of blocking the delete. */
  async delete(id: string): Promise<void> {
    await this.db.delete(sttProfiles).where(eq(sttProfiles.id, id)).run();
  }

  /** Move the fallback pointer to a profile. Returns the updated profile, or
   *  null when id is unknown. */
  async setDefault(id: string): Promise<SttProfile | null> {
    const existing = await this.getById(id);
    if (!existing) return null;
    this.db.transaction((tx) => {
      tx.update(sttProfiles).set({ isDefault: 0 }).run();
      tx.update(sttProfiles).set({ isDefault: 1 }).where(eq(sttProfiles.id, id)).run();
    });
    return this.getById(id);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private mapRow(row: typeof sttProfiles.$inferSelect): SttProfile {
    const profile: SttProfile = {
      id: brandId<SttProfileId>(row.id),
      name: row.name,
      // Unknown future slug degrades to the zero-setup default backend so the
      // row stays visible/editable in the list (house pattern: reads never
      // crash on forward-compatible data).
      backend: isSttBackendType(row.backend) ? row.backend : STT_BACKENDS.WhisperBrowser,
      config: parseConfig(row.configJson),
      emotionAnnotation: row.emotionAnnotation,
      isDefault: row.isDefault === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    // Write-only secret: surfaced only when a key is actually stored (the
    // wire layer reports `hasStoredApiKey` instead; the plain value never
    // leaves the store).
    if (row.apiKey) profile.apiKey = row.apiKey;
    return profile;
  }
}