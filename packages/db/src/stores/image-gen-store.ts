import { and, asc, eq } from 'drizzle-orm';

import { brandId, IMAGE_GEN_BACKENDS, IMAGE_GEN_TARGET_TYPE, IMAGE_GENERATION_MODES } from '@vibe-tavern/domain';
import type {
  ImageGenBackendType,
  ImageGenCapabilityFlags,
  ImageGenDefaultParams,
  ImageGenModeSizePreset,
  ImageGenModeSizePresets,
  ImageGenProfile,
  ImageGenProfileId,
  ImageGenProfileLink,
  ImageGenTargetType,
} from '@vibe-tavern/domain';

import type { AppDb } from '../db-connection.js';
import { imageGenLinks, imageGenProfiles } from '../db-schema.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

// ─── Input types ──────────────────────────────────────────────────────────────

/** Creation input — the full domain shape minus store-generated columns. */
export type CreateImageGenProfileData = Omit<ImageGenProfile, 'id' | 'createdAt' | 'updatedAt'>;

/** Update patch — every field optional except immutable identity/timestamps. */
export type UpdateImageGenProfileData = Partial<Omit<ImageGenProfile, 'id' | 'createdAt'>>;

// ─── JSON round-trip helpers (imported-data hygiene) ──────────────────────────
//
// The three JSON columns persist as text. Rows written by import or
// hand-editing may carry malformed JSON — parsing degrades to the safe empty
// shape instead of throwing, so one broken row can never take down listAll
// (the STT store's rows-survive rule).

function parseDefaultParams(raw: string): ImageGenDefaultParams {
  return parseJsonObject(raw, {});
}

function parseModeSizePresets(raw: string): ImageGenModeSizePresets {
  const parsed = parseJsonObject<Record<string, unknown>>(raw, {});
  const presets: ImageGenModeSizePresets = {};
  for (const [mode, value] of Object.entries(parsed)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const preset: ImageGenModeSizePreset = {};
    const record = value as Record<string, unknown>;
    if (typeof record.width === 'number') preset.width = record.width;
    if (typeof record.height === 'number') preset.height = record.height;
    if (preset.width !== undefined || preset.height !== undefined) {
      // Key survives only when it is a known generation mode; unknown future
      // modes are dropped (forward-compat read: no crash, no junk).
      if ((Object.values(IMAGE_GENERATION_MODES) as string[]).includes(mode)) {
        presets[mode as keyof ImageGenModeSizePresets] = preset;
      }
    }
  }
  return presets;
}

/** Capability degrade: zero-capability + free sizes — conservative (the UI
 *  hides provider-gated controls rather than offering unsupported ones). */
const DEGRADED_CAPABILITIES: ImageGenCapabilityFlags = {
  supportsNegativePrompt: false,
  supportsSamplers: false,
  supportsSeed: false,
  sizeSupport: { kind: 'free' },
  noApiKey: false,
  supportsLiveProgress: false,
  supportsImg2img: false,
  supportsInpaint: false,
};

function parseCapabilities(raw: string): ImageGenCapabilityFlags {
  const parsed = parseJsonObject<Record<string, unknown>>(raw, {});
  const sizeSupport = parsed.sizeSupport;
  const flags: ImageGenCapabilityFlags = { ...DEGRADED_CAPABILITIES };
  if (typeof parsed.supportsNegativePrompt === 'boolean') flags.supportsNegativePrompt = parsed.supportsNegativePrompt;
  if (typeof parsed.supportsSamplers === 'boolean') flags.supportsSamplers = parsed.supportsSamplers;
  if (typeof parsed.supportsSeed === 'boolean') flags.supportsSeed = parsed.supportsSeed;
  if (typeof parsed.noApiKey === 'boolean') flags.noApiKey = parsed.noApiKey;
  if (typeof parsed.supportsLiveProgress === 'boolean') flags.supportsLiveProgress = parsed.supportsLiveProgress;
  if (typeof parsed.supportsImg2img === 'boolean') flags.supportsImg2img = parsed.supportsImg2img;
  if (typeof parsed.supportsInpaint === 'boolean') flags.supportsInpaint = parsed.supportsInpaint;
  if (
    typeof sizeSupport === 'object' &&
    sizeSupport !== null &&
    !Array.isArray(sizeSupport) &&
    (sizeSupport as { kind?: unknown }).kind === 'vendor-set' &&
    Array.isArray((sizeSupport as { sizes?: unknown }).sizes) &&
    (sizeSupport as { sizes: unknown[] }).sizes.every((s) => typeof s === 'string')
  ) {
    flags.sizeSupport = { kind: 'vendor-set', sizes: (sizeSupport as { sizes: string[] }).sizes };
  }
  return flags;
}

function parseJsonObject<T>(raw: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback;
    return stripSecrets(parsed as Record<string, unknown>) as T;
  } catch {
    return fallback;
  }
}

/** IG-1 secret rule (ST-1 applied): the API key lives in the typed `api_key`
 *  column — writes strip it from every JSON blob so no caller (adapter,
 *  import, future script) can smuggle a key into JSON; reads strip
 *  defensively too, covering hand-edited or backup-restored rows. */
function stripSecrets<T extends Record<string, unknown>>(value: T): T {
  if (!('apiKey' in value)) return value;
  const clean = { ...value };
  delete (clean as { apiKey?: unknown }).apiKey;
  return clean;
}

function isImageGenBackendType(v: string): v is ImageGenBackendType {
  return (Object.values(IMAGE_GEN_BACKENDS) as string[]).includes(v);
}

function isImageGenTargetType(v: string): v is ImageGenTargetType {
  return (Object.values(IMAGE_GEN_TARGET_TYPE) as string[]).includes(v);
}

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Store for named image-gen profiles (IMAGE_GENERATION_PLAN IG-2). Plain CRUD
 * + the character-scoped link junction (TTS voice-map shape): NO default
 * pointer (unlike TTS/STT there is no generation-pipeline fallback — the
 * active profile is a chat-level consumer concern) and NO active-set resolver
 * here.
 *
 * Key hygiene mirrors the STT store: apiKey is a typed-column tri-state on
 * update (`undefined` = keep, `""` = clear, non-empty = set), and a backend
 * flip clears the stored key unless the same patch provides a new one — a
 * key is only meaningful for the protocol it was entered for.
 */
export class ImageGenStore {
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

  /** All profiles ordered for a stable list view (sortOrder, then name, then
   *  createdAt — the TTS list ordering). */
  async listAll(): Promise<ImageGenProfile[]> {
    const rows = await this.db
      .select()
      .from(imageGenProfiles)
      .orderBy(asc(imageGenProfiles.sortOrder), asc(imageGenProfiles.name), asc(imageGenProfiles.createdAt))
      .all();
    return rows.map((r) => this.mapRow(r));
  }

  async getById(id: string): Promise<ImageGenProfile | null> {
    const row = await this.db.select().from(imageGenProfiles).where(eq(imageGenProfiles.id, id)).get();
    return row ? this.mapRow(row) : null;
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  async create(input: CreateImageGenProfileData): Promise<ImageGenProfile> {
    const id = this.idGen.next('image_gen_profile');
    const now = this.clock.now();
    // Sync-transaction shape (ASYNC_TRANSACTION_AUDIT): the sync tx client
    // types only support `.run()`, so the row is read back after commit.
    this.db.transaction((tx) => {
      tx.insert(imageGenProfiles)
        .values({
          id,
          name: input.name,
          backend: input.backend,
          presetId: input.presetId ?? null,
          endpoint: input.endpoint,
          apiKey: input.apiKey ?? null,
          modelId: input.modelId ?? null,
          defaultParamsJson: JSON.stringify(stripSecrets(input.defaultParams as Record<string, unknown>)),
          modeSizePresetsJson: JSON.stringify(stripSecrets(input.modeSizePresets as Record<string, unknown>)),
          llmAssistEnabled: input.llmAssistEnabled,
          llmProviderProfileId: input.llmProviderProfileId ?? null,
          llmModelId: input.llmModelId ?? null,
          capabilitiesJson: JSON.stringify(input.capabilities),
          sortOrder: input.sortOrder,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    });
    const row = await this.db.select().from(imageGenProfiles).where(eq(imageGenProfiles.id, id)).get();
    return this.mapRow(row!);
  }

  /** Patch-apply update; bumps `updatedAt`. Returns null when id is unknown.
   *  A backend flip clears the stored key unless the same patch provides a
   *  new one (key-never-leaks-across-backends guarantee). */
  async update(id: string, patch: UpdateImageGenProfileData): Promise<ImageGenProfile | null> {
    const now = this.clock.now();
    const values: Partial<typeof imageGenProfiles.$inferInsert> = { updatedAt: now };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.backend !== undefined) values.backend = patch.backend;
    if (patch.presetId !== undefined) values.presetId = patch.presetId ?? null;
    if (patch.endpoint !== undefined) values.endpoint = patch.endpoint;
    // Tri-state: `undefined` = untouched, `""` = cleared, non-empty = set.
    if (patch.apiKey !== undefined) values.apiKey = patch.apiKey === '' ? null : patch.apiKey;
    if (patch.modelId !== undefined) values.modelId = patch.modelId ?? null;
    if (patch.defaultParams !== undefined) {
      values.defaultParamsJson = JSON.stringify(stripSecrets(patch.defaultParams as Record<string, unknown>));
    }
    if (patch.modeSizePresets !== undefined) {
      values.modeSizePresetsJson = JSON.stringify(stripSecrets(patch.modeSizePresets as Record<string, unknown>));
    }
    if (patch.llmAssistEnabled !== undefined) values.llmAssistEnabled = patch.llmAssistEnabled;
    if (patch.llmProviderProfileId !== undefined) values.llmProviderProfileId = patch.llmProviderProfileId ?? null;
    if (patch.llmModelId !== undefined) values.llmModelId = patch.llmModelId ?? null;
    if (patch.capabilities !== undefined) values.capabilitiesJson = JSON.stringify(patch.capabilities);
    if (patch.sortOrder !== undefined) values.sortOrder = patch.sortOrder;

    const existing = await this.db
      .select({ id: imageGenProfiles.id, backend: imageGenProfiles.backend })
      .from(imageGenProfiles)
      .where(eq(imageGenProfiles.id, id))
      .get();
    if (!existing) return null;
    // Backend-flip key hygiene (mirrors the STT/TTS stores): switching the
    // protocol clears the stored key unless the SAME patch provides a new
    // one.
    if (
      patch.backend !== undefined &&
      patch.backend !== existing.backend &&
      (patch.apiKey === undefined || patch.apiKey === '')
    ) {
      values.apiKey = null;
    }
    this.db.transaction((tx) => {
      tx.update(imageGenProfiles).set(values).where(eq(imageGenProfiles.id, id)).run();
    });
    const row = await this.db.select().from(imageGenProfiles).where(eq(imageGenProfiles.id, id)).get();
    return row ? this.mapRow(row) : null;
  }

  /** Deletes the profile; junction links cascade via FK. */
  async delete(id: string): Promise<void> {
    await this.db.delete(imageGenProfiles).where(eq(imageGenProfiles.id, id)).run();
  }

  // ─── Link management (character bindings; mirrors TtsStore link methods) ──

  /**
   * Get all junction links for a profile — its character bindings. Unknown
   * future target kinds (if a migration ever adds one) are skipped, not
   * thrown: reads never crash on forward-compatible data.
   */
  async getLinks(imageGenProfileId: string): Promise<ImageGenProfileLink[]> {
    const rows = await this.db
      .select()
      .from(imageGenLinks)
      .where(eq(imageGenLinks.imageGenProfileId, imageGenProfileId))
      .all();
    return rows.flatMap((r) => {
      if (!isImageGenTargetType(r.targetType)) return [];
      return [
        {
          imageGenProfileId: brandId<ImageGenProfileId>(r.imageGenProfileId),
          targetType: r.targetType,
          targetId: r.targetId,
        },
      ];
    });
  }

  /** All character bindings across all profiles (resolver data source). */
  async listAllLinks(): Promise<ImageGenProfileLink[]> {
    const rows = await this.db.select().from(imageGenLinks).all();
    return rows.flatMap((r) => {
      if (!isImageGenTargetType(r.targetType)) return [];
      return [
        {
          imageGenProfileId: brandId<ImageGenProfileId>(r.imageGenProfileId),
          targetType: r.targetType,
          targetId: r.targetId,
        },
      ];
    });
  }

  /**
   * Replace all links for a profile. Deletes existing and inserts new ones in
   * a synchronous-callback transaction (the RegexStore/TtsStore setLinks
   * shape): a failure on a later insert rolls the delete back too, so the
   * prior complete binding graph survives instead of being wiped to empty.
   */
  async setLinks(
    imageGenProfileId: string,
    links: Array<{ targetType: ImageGenTargetType; targetId: string }>,
  ): Promise<ImageGenProfileLink[]> {
    // Dedup by (targetType, targetId) BEFORE the delete: the composite PK
    // would reject a duplicate tuple mid-insert — after the old set is
    // already deleted. Normalizing first keeps the replace whole.
    const seen = new Map<string, { targetType: ImageGenTargetType; targetId: string }>();
    for (const link of links) {
      seen.set(JSON.stringify([link.targetType, link.targetId]), link);
    }
    const unique = [...seen.values()];

    this.db.transaction((tx) => {
      tx.delete(imageGenLinks).where(eq(imageGenLinks.imageGenProfileId, imageGenProfileId)).run();
      for (const link of unique) {
        tx.insert(imageGenLinks)
          .values({ imageGenProfileId, targetType: link.targetType, targetId: link.targetId })
          .run();
      }
    });
    return this.getLinks(imageGenProfileId);
  }

  /** Add a single link (idempotent — the composite PK ignores duplicates). */
  async addLink(imageGenProfileId: string, targetType: ImageGenTargetType, targetId: string): Promise<void> {
    await this.db
      .insert(imageGenLinks)
      .values({ imageGenProfileId, targetType, targetId })
      .onConflictDoNothing()
      .run();
  }

  /** Remove a single link. */
  async removeLink(imageGenProfileId: string, targetType: ImageGenTargetType, targetId: string): Promise<void> {
    await this.db
      .delete(imageGenLinks)
      .where(
        and(
          eq(imageGenLinks.imageGenProfileId, imageGenProfileId),
          eq(imageGenLinks.targetType, targetType),
          eq(imageGenLinks.targetId, targetId),
        ),
      )
      .run();
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private mapRow(row: typeof imageGenProfiles.$inferSelect): ImageGenProfile {
    const profile: ImageGenProfile = {
      id: brandId<ImageGenProfileId>(row.id),
      name: row.name,
      // Unknown future slug degrades to the first roster member so the row
      // stays visible/editable (house pattern: reads never crash on
      // forward-compatible data; the editor re-saves a valid backend).
      backend: isImageGenBackendType(row.backend) ? row.backend : IMAGE_GEN_BACKENDS.OpenRouter,
      endpoint: row.endpoint,
      defaultParams: parseDefaultParams(row.defaultParamsJson),
      modeSizePresets: parseModeSizePresets(row.modeSizePresetsJson),
      llmAssistEnabled: row.llmAssistEnabled,
      capabilities: parseCapabilities(row.capabilitiesJson),
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    if (row.presetId) profile.presetId = row.presetId;
    if (row.modelId) profile.modelId = row.modelId;
    if (row.llmProviderProfileId) profile.llmProviderProfileId = row.llmProviderProfileId;
    if (row.llmModelId) profile.llmModelId = row.llmModelId;
    // Write-only secret: surfaced only when a key is actually stored (the
    // wire layer reports `hasStoredApiKey` instead; the value never leaves
    // the store).
    if (row.apiKey) profile.apiKey = row.apiKey;
    return profile;
  }
}
