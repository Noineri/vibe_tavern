import { COAUTHOR_TRANSPORT, type CoauthorTransport, type StoredProviderProfileRecord, type ModelFavoriteScope, type ModelSettingsOverlay } from '@vibe-tavern/domain';
import { and, asc, eq, sql } from 'drizzle-orm';
import { providerProfiles, cachedModels, providerModelFavorites, providerModelSettings } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

/** Safe JSON parse that returns [] on missing/invalid data (handles pre-migration state). */
function safeParseJson<T>(value: string | null | undefined): T {
  if (!value) return [] as T;
  try { return JSON.parse(value) as T; }
  catch { return [] as T; }
}

// ─── Return types ─────────────────────────────────────────────────────────────

/**
 * Store-level provider profile — mirrors StoredProviderProfileRecord from domain.
 * Uses plain `string` IDs (brands are applied at the API boundary).
 */
export type ProviderProfile = StoredProviderProfileRecord;

export interface CachedModel {
  id: string;
  providerProfileId: string;
  modelSlug: string;
  modelName: string;
  contextLength: number | null;
  capabilities: { reasoning?: boolean; tools?: boolean; vision?: boolean };
  fetchedAt: string;
}

export interface FavoriteModel {
  id: string;
  providerProfileId: string;
  modelId: string;
  scope: ModelFavoriteScope;
  label: string | null;
  contextLength: number | null;
  createdAt: string;
}

/** Per-model settings overlay row. `settings` is the parsed {@link ModelSettingsOverlay};
 *  absent fields mean "inherit the profile base" (see resolveEffectiveSettings). */
export interface ProviderModelSettings {
  id: string;
  providerProfileId: string;
  modelId: string;
  settings: ModelSettingsOverlay;
  createdAt: string;
  updatedAt: string;
}

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreateProviderData {
  name: string;
  providerPreset: string;
  coauthorTransport?: CoauthorTransport;
  endpoint: string;
  apiKey?: string | null;
  defaultModel?: string | null;
  contextBudget?: number | null;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  topA?: number;
  typicalP?: number;
  tfsZ?: number;
  repeatLastN?: number;
  mirostat?: number;
  mirostatTau?: number;
  mirostatEta?: number;
  dryMultiplier?: number;
  dryBase?: number;
  dryAllowedLength?: number;
  drySequenceBreakers?: string[];
  xtcThreshold?: number;
  xtcProbability?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
  stopSequences?: string[];
  logitBias?: Array<{ tokenId: number; bias: number; text?: string; sourceText?: string; model?: string }>;
  seed?: string | null;
  reasoningEffort?: string;
  showReasoning?: boolean;
  streamResponse?: boolean;
  customSamplers?: boolean;
  pinContextBudget?: boolean;
  /** Per-model binding toggle — when true, sampler/context edits route to a per-model overlay. */
  bindPerModel?: boolean;
  /** Model-list display prefs (MODEL_LIST_FILTERS) — pure UI, no backend logic. */
  modelFreeOnly?: boolean;
  modelGroupByOwner?: boolean;
  /** Optional vision model for image description fallback. */
  visionModel?: string | null;
}

export type UpdateProviderData = Partial<CreateProviderData>;

export interface CachedModelData {
  modelSlug: string;
  modelName: string;
  contextLength?: number | null;
  capabilities?: { reasoning?: boolean; tools?: boolean; vision?: boolean };
}

export interface FavoriteModelData {
  modelId: string;
  label?: string | null;
  contextLength?: number | null;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class ProviderStore {
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

  async getById(id: string): Promise<ProviderProfile | null> {
    const row = await this.db.select().from(providerProfiles).where(eq(providerProfiles.id, id)).get();
    return row ? this.mapRow(row) : null;
  }

  async listAll(): Promise<ProviderProfile[]> {
    const rows = await this.db.select().from(providerProfiles).orderBy(asc(providerProfiles.sortOrder), asc(providerProfiles.createdAt)).all();
    const result = rows.map((row) => this.mapRow(row));
    for (const p of result) {
      console.log(`[DB] provider.listAll id=${p.id} visionModel=${p.visionModel}`);
    }
    return result;
  }

  async getActive(): Promise<ProviderProfile | null> {
    const row = await this.db.select().from(providerProfiles).where(eq(providerProfiles.isActive, 1)).get();
    return row ? this.mapRow(row) : null;
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  async create(data: CreateProviderData): Promise<ProviderProfile> {
    const id = this.idGen.next('prov');
    const now = this.clock.now();

    // Append at end: sort_order = current max + 1 (see PromptPresetStore.create).
    const maxRow = await this.db
      .select({ maxSort: sql<number>`COALESCE(MAX(${providerProfiles.sortOrder}), -1)` })
      .from(providerProfiles)
      .get();
    const nextSortOrder = (maxRow?.maxSort ?? -1) + 1;

    const [row] = await this.db
      .insert(providerProfiles)
      .values({
        id,
        name: data.name,
        sortOrder: nextSortOrder,
        providerPreset: data.providerPreset,
        coauthorTransport: data.coauthorTransport ?? COAUTHOR_TRANSPORT.chatCompletions,
        endpoint: data.endpoint,
        apiKey: data.apiKey ?? null,
        defaultModel: data.defaultModel ?? null,
        contextBudget: data.contextBudget ?? null,
        maxTokens: data.maxTokens ?? 2000,
        temperature: data.temperature ?? 1.0,
        topP: data.topP ?? 1.0,
        topK: data.topK ?? 0,
        minP: data.minP ?? 0,
        topA: data.topA ?? 0,
        typicalP: data.typicalP ?? 1.0,
        tfsZ: data.tfsZ ?? 1.0,
        repeatLastN: data.repeatLastN ?? 0,
        mirostat: data.mirostat ?? 0,
        mirostatTau: data.mirostatTau ?? 5.0,
        mirostatEta: data.mirostatEta ?? 0.1,
        dryMultiplier: data.dryMultiplier ?? 0,
        dryBase: data.dryBase ?? 1.75,
        dryAllowedLength: data.dryAllowedLength ?? 2,
        drySequenceBreakersJson: data.drySequenceBreakers?.length ? JSON.stringify(data.drySequenceBreakers) : null,
        xtcThreshold: data.xtcThreshold ?? 0.1,
        xtcProbability: data.xtcProbability ?? 0,
        frequencyPenalty: data.frequencyPenalty ?? 0,
        presencePenalty: data.presencePenalty ?? 0,
        repetitionPenalty: data.repetitionPenalty ?? 1.0,
        stopSequencesJson: data.stopSequences ? JSON.stringify(data.stopSequences) : null,
        logitBiasJson: data.logitBias?.length ? JSON.stringify(data.logitBias) : null,
        seed: data.seed ?? null,
        reasoningEffort: data.reasoningEffort ?? 'auto',
        showReasoning: data.showReasoning ? 1 : 0,
        streamResponse: data.streamResponse !== undefined ? (data.streamResponse ? 1 : 0) : 1,
        customSamplers: data.customSamplers ? 1 : 0,
        pinContextBudget: data.pinContextBudget ?? false,
        bindPerModel: data.bindPerModel ?? false,
        modelFreeOnly: data.modelFreeOnly ?? false,
        modelGroupByOwner: data.modelGroupByOwner ?? false,
        visionModel: data.visionModel ?? null,
        isActive: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return this.mapRow(row!);
  }

  async update(id: string, data: UpdateProviderData): Promise<ProviderProfile> {
    const now = this.clock.now();

    const values: Partial<typeof providerProfiles.$inferInsert> = { updatedAt: now };

    if (data.name !== undefined) values.name = data.name;
    if (data.providerPreset !== undefined) values.providerPreset = data.providerPreset;
    if (data.coauthorTransport !== undefined) values.coauthorTransport = data.coauthorTransport;
    if (data.endpoint !== undefined) values.endpoint = data.endpoint;
    if (data.apiKey !== undefined) values.apiKey = data.apiKey;
    if (data.defaultModel !== undefined) values.defaultModel = data.defaultModel;
    if (data.contextBudget !== undefined) values.contextBudget = data.contextBudget;
    if (data.maxTokens !== undefined) values.maxTokens = data.maxTokens;
    if (data.temperature !== undefined) values.temperature = data.temperature;
    if (data.topP !== undefined) values.topP = data.topP;
    if (data.topK !== undefined) values.topK = data.topK;
    if (data.minP !== undefined) values.minP = data.minP;
    if (data.topA !== undefined) values.topA = data.topA;
    if (data.typicalP !== undefined) values.typicalP = data.typicalP;
    if (data.tfsZ !== undefined) values.tfsZ = data.tfsZ;
    if (data.repeatLastN !== undefined) values.repeatLastN = data.repeatLastN;
    if (data.mirostat !== undefined) values.mirostat = data.mirostat;
    if (data.mirostatTau !== undefined) values.mirostatTau = data.mirostatTau;
    if (data.mirostatEta !== undefined) values.mirostatEta = data.mirostatEta;
    if (data.dryMultiplier !== undefined) values.dryMultiplier = data.dryMultiplier;
    if (data.dryBase !== undefined) values.dryBase = data.dryBase;
    if (data.dryAllowedLength !== undefined) values.dryAllowedLength = data.dryAllowedLength;
    if (data.drySequenceBreakers !== undefined) values.drySequenceBreakersJson = data.drySequenceBreakers.length ? JSON.stringify(data.drySequenceBreakers) : null;
    if (data.xtcThreshold !== undefined) values.xtcThreshold = data.xtcThreshold;
    if (data.xtcProbability !== undefined) values.xtcProbability = data.xtcProbability;
    if (data.frequencyPenalty !== undefined) values.frequencyPenalty = data.frequencyPenalty;
    if (data.presencePenalty !== undefined) values.presencePenalty = data.presencePenalty;
    if (data.repetitionPenalty !== undefined) values.repetitionPenalty = data.repetitionPenalty;
    if (data.stopSequences !== undefined) values.stopSequencesJson = JSON.stringify(data.stopSequences);
    if (data.logitBias !== undefined) values.logitBiasJson = data.logitBias.length ? JSON.stringify(data.logitBias) : null;
    if (data.seed !== undefined) values.seed = data.seed;
    if (data.reasoningEffort !== undefined) values.reasoningEffort = data.reasoningEffort;
    if (data.showReasoning !== undefined) values.showReasoning = data.showReasoning ? 1 : 0;
    if (data.streamResponse !== undefined) values.streamResponse = data.streamResponse ? 1 : 0;
    if (data.customSamplers !== undefined) values.customSamplers = data.customSamplers ? 1 : 0;
    if (data.pinContextBudget !== undefined) values.pinContextBudget = data.pinContextBudget;
    if (data.bindPerModel !== undefined) values.bindPerModel = data.bindPerModel;
    if (data.modelFreeOnly !== undefined) values.modelFreeOnly = data.modelFreeOnly;
    if (data.modelGroupByOwner !== undefined) values.modelGroupByOwner = data.modelGroupByOwner;
    if (data.visionModel !== undefined) values.visionModel = data.visionModel ?? null;

    console.log(`[DB] provider.update id=${id} visionModel_in=${data.visionModel} visionModel_set=${values.visionModel} fields=${Object.keys(values).join(',')}`);
    const [row] = await this.db
      .update(providerProfiles)
      .set(values)
      .where(eq(providerProfiles.id, id))
      .returning();

    if (!row) {
      throw new Error(`ProviderProfile '${id}' not found after update`);
    }
    console.log(`[DB] provider.update.returning id=${row.id} visionModel_db=${row.visionModel}`);
    return this.mapRow(row);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(providerProfiles).where(eq(providerProfiles.id, id)).run();
  }

  async activate(id: string): Promise<void> {
    // Synchronous callback (ASYNC_TRANSACTION_AUDIT step 4): drizzle-orm 0.38.4
    // + bun:sqlite commits at the end of the callback's synchronous prefix, so
    // an async callback's post-await throw is never rolled back. Keeping this
    // synchronous means a throw rolls the whole tx back.
    //
    // Validate the target BEFORE clearing the old active flag: a stale id
    // would otherwise update zero rows on the second statement without
    // throwing — silently leaving NO provider active (the old flag already
    // cleared by the first statement). Checking inside the tx means a stale
    // id throws before any write runs, so the currently-active provider is
    // preserved. (provider-profile-service converts this throw to a 404.)
    this.db.transaction((tx) => {
      const target = tx.select({ id: providerProfiles.id }).from(providerProfiles)
        .where(eq(providerProfiles.id, id)).get();
      if (!target) {
        throw new Error(`ProviderProfile '${id}' not found for activation`);
      }
      tx.update(providerProfiles).set({ isActive: 0 }).run();
      tx.update(providerProfiles).set({ isActive: 1 }).where(eq(providerProfiles.id, id)).run();
    });
  }

  async duplicate(id: string): Promise<ProviderProfile> {
    const original = await this.db.select().from(providerProfiles).where(eq(providerProfiles.id, id)).get();
    if (!original) {
      throw new Error(`ProviderProfile '${id}' not found`);
    }

    const newId = this.idGen.next('prov');
    const now = this.clock.now();

    // Append at end (see create()).
    const maxRow = await this.db
      .select({ maxSort: sql<number>`COALESCE(MAX(${providerProfiles.sortOrder}), -1)` })
      .from(providerProfiles)
      .get();
    const nextSortOrder = (maxRow?.maxSort ?? -1) + 1;

    const [row] = await this.db
      .insert(providerProfiles)
      .values({
        id: newId,
        name: `${original.name} (copy)`,
        sortOrder: nextSortOrder,
        providerPreset: original.providerPreset,
        coauthorTransport: original.coauthorTransport,
        endpoint: original.endpoint,
        apiKey: original.apiKey,
        defaultModel: original.defaultModel,
        contextBudget: original.contextBudget,
        maxTokens: original.maxTokens,
        temperature: original.temperature,
        topP: original.topP,
        topK: original.topK,
        minP: original.minP,
        topA: original.topA,
        typicalP: original.typicalP,
        tfsZ: original.tfsZ,
        repeatLastN: original.repeatLastN,
        mirostat: original.mirostat,
        mirostatTau: original.mirostatTau,
        mirostatEta: original.mirostatEta,
        dryMultiplier: original.dryMultiplier,
        dryBase: original.dryBase,
        dryAllowedLength: original.dryAllowedLength,
        drySequenceBreakersJson: original.drySequenceBreakersJson,
        xtcThreshold: original.xtcThreshold,
        xtcProbability: original.xtcProbability,
        frequencyPenalty: original.frequencyPenalty,
        presencePenalty: original.presencePenalty,
        repetitionPenalty: original.repetitionPenalty,
        stopSequencesJson: original.stopSequencesJson,
        logitBiasJson: original.logitBiasJson,
        seed: original.seed,
        reasoningEffort: original.reasoningEffort,
        showReasoning: original.showReasoning,
        streamResponse: original.streamResponse,
        customSamplers: original.customSamplers,
        pinContextBudget: original.pinContextBudget,
        bindPerModel: original.bindPerModel,
        modelFreeOnly: original.modelFreeOnly,
        modelGroupByOwner: original.modelGroupByOwner,
        visionModel: original.visionModel,
        isActive: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return this.mapRow(row!);
  }

  async reorder(updates: Array<{ id: string; sortOrder: number }>): Promise<ProviderProfile[]> {
    const now = this.clock.now();
    // Synchronous callback (ASYNC_TRANSACTION_AUDIT step 4): see activate.
    // A failure partway through the reorder rolls the earlier updates back —
    // the prior complete order survives.
    this.db.transaction((tx) => {
      for (const u of updates) {
        tx
          .update(providerProfiles)
          .set({ sortOrder: u.sortOrder, updatedAt: now })
          .where(eq(providerProfiles.id, u.id))
          .run();
      }
    });
    return this.listAll();
  }

  // ─── Cached models ─────────────────────────────────────────────────────────

  async saveCachedModels(providerId: string, models: CachedModelData[]): Promise<void> {
    // Dedup by modelSlug BEFORE the delete: cached_models has a unique index
    // on (provider_profile_id, model_slug), so a duplicate slug in the input
    // would violate it on the bulk insert — AFTER the old cache was already
    // deleted, leaving the provider with no cached models. Normalizing first
    // keeps the replace whole. First occurrence wins.
    const seen = new Set<string>();
    const unique: CachedModelData[] = [];
    for (const m of models) {
      if (seen.has(m.modelSlug)) continue;
      seen.add(m.modelSlug);
      unique.push(m);
    }

    // Synchronous callback (ASYNC_TRANSACTION_AUDIT step 4): see activate.
    // A failure on the bulk insert rolls the delete back too — the prior
    // cached-model set survives instead of being wiped to empty.
    this.db.transaction((tx) => {
      tx.delete(cachedModels).where(eq(cachedModels.providerProfileId, providerId)).run();
      if (unique.length > 0) {
        const values = unique.map((model) => ({
          id: this.idGen.next('cmod'),
          providerProfileId: providerId,
          modelSlug: model.modelSlug,
          modelName: model.modelName,
          contextLength: model.contextLength ?? null,
          capabilitiesJson: JSON.stringify(model.capabilities ?? {}),
          fetchedAt: this.clock.now(),
        }));
        tx.insert(cachedModels).values(values).run();
      }
    });
  }

  async getCachedModels(providerId: string): Promise<CachedModel[]> {
    const rows = await this.db
      .select()
      .from(cachedModels)
      .where(eq(cachedModels.providerProfileId, providerId))
      .all();
    return rows.map((row) => this.mapCachedModelRow(row));
  }

  // ─── Favorite models ───────────────────────────────────────────────────────

  async listFavoriteModels(providerId: string, scope: ModelFavoriteScope): Promise<FavoriteModel[]> {
    const rows = await this.db
      .select()
      .from(providerModelFavorites)
      .where(and(
        eq(providerModelFavorites.providerProfileId, providerId),
        eq(providerModelFavorites.scope, scope),
      ))
      .all();
    return rows.map((row) => this.mapFavoriteModelRow(row));
  }

  async addFavoriteModel(providerId: string, scope: ModelFavoriteScope, model: FavoriteModelData): Promise<FavoriteModel> {
    const now = this.clock.now();
    const existing = await this.db
      .select()
      .from(providerModelFavorites)
      .where(and(
        eq(providerModelFavorites.providerProfileId, providerId),
        eq(providerModelFavorites.modelId, model.modelId),
        eq(providerModelFavorites.scope, scope),
      ))
      .get();

    if (existing) {
      const [row] = await this.db
        .update(providerModelFavorites)
        .set({
          label: model.label ?? existing.label,
          contextLength: model.contextLength ?? existing.contextLength,
        })
        .where(eq(providerModelFavorites.id, existing.id))
        .returning();
      return this.mapFavoriteModelRow(row!);
    }

    const [row] = await this.db
      .insert(providerModelFavorites)
      .values({
        id: this.idGen.next('fm'),
        providerProfileId: providerId,
        modelId: model.modelId,
        scope,
        label: model.label ?? null,
        contextLength: model.contextLength ?? null,
        createdAt: now,
      })
      .returning();
    return this.mapFavoriteModelRow(row!);
  }

  async removeFavoriteModel(providerId: string, scope: ModelFavoriteScope, modelId: string): Promise<void> {
    await this.db
      .delete(providerModelFavorites)
      .where(and(
        eq(providerModelFavorites.providerProfileId, providerId),
        eq(providerModelFavorites.modelId, modelId),
        eq(providerModelFavorites.scope, scope),
      ))
      .run();
  }

  // ─── Per-model settings overlay ───────────────────────────────────────────

  /** Parse a stored settingsJson row. Returns `{}` (empty overlay = inherit all base) on missing/invalid JSON. */
  private parseSettingsJson(value: string): ModelSettingsOverlay {
    try {
      const parsed = JSON.parse(value) as unknown;
      return (parsed && typeof parsed === 'object' ? parsed : {}) as ModelSettingsOverlay;
    } catch {
      return {};
    }
  }

  private mapModelSettingsRow(row: typeof providerModelSettings.$inferSelect): ProviderModelSettings {
    return {
      id: row.id,
      providerProfileId: row.providerProfileId,
      modelId: row.modelId,
      settings: this.parseSettingsJson(row.settingsJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Get a single model's overlay, or `null` if the model has no bound settings yet (inherit base). */
  async getModelSettings(providerId: string, modelId: string): Promise<ProviderModelSettings | null> {
    const row = await this.db
      .select()
      .from(providerModelSettings)
      .where(and(
        eq(providerModelSettings.providerProfileId, providerId),
        eq(providerModelSettings.modelId, modelId),
      ))
      .get();
    return row ? this.mapModelSettingsRow(row) : null;
  }

  /** List every model overlay for a profile (used to populate the binding UI). */
  async listModelSettings(providerId: string): Promise<ProviderModelSettings[]> {
    const rows = await this.db
      .select()
      .from(providerModelSettings)
      .where(eq(providerModelSettings.providerProfileId, providerId))
      .all();
    return rows.map((row) => this.mapModelSettingsRow(row));
  }

  /** Insert or update (upsert) a model's overlay. Idempotent on `(providerId, modelId)`. */
  async upsertModelSettings(providerId: string, modelId: string, settings: ModelSettingsOverlay): Promise<ProviderModelSettings> {
    const now = this.clock.now();
    const settingsJson = JSON.stringify(settings);
    const existing = await this.db
      .select()
      .from(providerModelSettings)
      .where(and(
        eq(providerModelSettings.providerProfileId, providerId),
        eq(providerModelSettings.modelId, modelId),
      ))
      .get();

    if (existing) {
      const [row] = await this.db
        .update(providerModelSettings)
        .set({ settingsJson, updatedAt: now })
        .where(eq(providerModelSettings.id, existing.id))
        .returning();
      return this.mapModelSettingsRow(row!);
    }

    const [row] = await this.db
      .insert(providerModelSettings)
      .values({
        id: this.idGen.next('pms'),
        providerProfileId: providerId,
        modelId,
        settingsJson,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return this.mapModelSettingsRow(row!);
  }

  /** Delete a model's overlay (the model reverts to the profile base). No-op if none exists. */
  async deleteModelSettings(providerId: string, modelId: string): Promise<void> {
    await this.db
      .delete(providerModelSettings)
      .where(and(
        eq(providerModelSettings.providerProfileId, providerId),
        eq(providerModelSettings.modelId, modelId),
      ))
      .run();
  }

  // ─── Row mappers ───────────────────────────────────────────────────────────

  private mapRow(row: typeof providerProfiles.$inferSelect): ProviderProfile {
    return {
      id: row.id,
      name: row.name,
      providerPreset: row.providerPreset,
      coauthorTransport: row.coauthorTransport,
      endpoint: row.endpoint,
      apiKey: row.apiKey,
      defaultModel: row.defaultModel,
      contextBudget: row.contextBudget,
      pinContextBudget: row.pinContextBudget,
      bindPerModel: row.bindPerModel,
      modelFreeOnly: row.modelFreeOnly,
      modelGroupByOwner: row.modelGroupByOwner,
      maxTokens: row.maxTokens,
      temperature: row.temperature,
      topP: row.topP,
      topK: row.topK,
      minP: row.minP,
      topA: row.topA,
      typicalP: row.typicalP,
      tfsZ: row.tfsZ,
      repeatLastN: row.repeatLastN,
      mirostat: row.mirostat,
      mirostatTau: row.mirostatTau,
      mirostatEta: row.mirostatEta,
      dryMultiplier: row.dryMultiplier,
      dryBase: row.dryBase,
      dryAllowedLength: row.dryAllowedLength,
      drySequenceBreakers: safeParseJson<string[]>(row.drySequenceBreakersJson),
      xtcThreshold: row.xtcThreshold,
      xtcProbability: row.xtcProbability,
      frequencyPenalty: row.frequencyPenalty,
      presencePenalty: row.presencePenalty,
      repetitionPenalty: row.repetitionPenalty,
      stopSequences: row.stopSequencesJson ? JSON.parse(row.stopSequencesJson) : [],
      logitBias: safeParseJson<Array<{ tokenId: number; bias: number; text?: string; sourceText?: string; model?: string }>>(row.logitBiasJson),
      seed: row.seed,
      reasoningEffort: row.reasoningEffort,
      showReasoning: row.showReasoning === 1,
      streamResponse: row.streamResponse === 1,
      customSamplers: row.customSamplers === 1,
      isActive: row.isActive === 1,
      visionModel: row.visionModel ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapCachedModelRow(row: typeof cachedModels.$inferSelect): CachedModel {
    const parsed = JSON.parse(row.capabilitiesJson) as { thinking?: boolean; reasoning?: boolean; tools?: boolean; vision?: boolean };
    return {
      id: row.id,
      providerProfileId: row.providerProfileId,
      modelSlug: row.modelSlug,
      modelName: row.modelName,
      contextLength: row.contextLength,
      capabilities: {
        ...(parsed.reasoning !== undefined ? { reasoning: parsed.reasoning } : parsed.thinking !== undefined ? { reasoning: parsed.thinking } : {}),
        ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}),
        ...(parsed.vision !== undefined ? { vision: parsed.vision } : {}),
      },
      fetchedAt: row.fetchedAt,
    };
  }

  private mapFavoriteModelRow(row: typeof providerModelFavorites.$inferSelect): FavoriteModel {
    return {
      id: row.id,
      providerProfileId: row.providerProfileId,
      modelId: row.modelId,
      scope: row.scope as ModelFavoriteScope,
      label: row.label,
      contextLength: row.contextLength,
      createdAt: row.createdAt,
    };
  }
}
