import type { StoredProviderProfileRecord } from '@rp-platform/domain';
import { and, eq } from 'drizzle-orm';
import { providerProfiles, cachedModels, providerModelFavorites } from '../db-schema.js';
import type { AppDb } from '../db-connection.js';
import { resolveStoreRuntime, type StoreClock, type StoreIdGenerator } from '../persistence.js';

// ─── Return types ─────────────────────────────────────────────────────────────

// Re-export canonical domain type — all consumers use this name
export type ProviderProfile = StoredProviderProfileRecord;

export interface CachedModel {
  id: string;
  providerProfileId: string;
  modelSlug: string;
  modelName: string;
  contextLength: number | null;
  capabilities: { thinking?: boolean; tools?: boolean; vision?: boolean };
  fetchedAt: string;
}

export interface FavoriteModel {
  id: string;
  providerProfileId: string;
  modelId: string;
  label: string | null;
  contextLength: number | null;
  createdAt: string;
}

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreateProviderData {
  name: string;
  providerPreset: string;
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
  frequencyPenalty?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
  stopSequences?: string[];
  seed?: string | null;
  reasoningEffort?: string;
  showReasoning?: boolean;
  streamResponse?: boolean;
  customSamplers?: boolean;
}

export type UpdateProviderData = Partial<CreateProviderData>;

export interface CachedModelData {
  modelSlug: string;
  modelName: string;
  contextLength?: number | null;
  capabilities?: { thinking?: boolean; tools?: boolean; vision?: boolean };
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
    const rows = await this.db.select().from(providerProfiles).all();
    return rows.map((row) => this.mapRow(row));
  }

  async getActive(): Promise<ProviderProfile | null> {
    const row = await this.db.select().from(providerProfiles).where(eq(providerProfiles.isActive, 1)).get();
    return row ? this.mapRow(row) : null;
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  async create(data: CreateProviderData): Promise<ProviderProfile> {
    const id = this.idGen.next('prov');
    const now = this.clock.now();

    const [row] = await this.db
      .insert(providerProfiles)
      .values({
        id,
        name: data.name,
        providerPreset: data.providerPreset,
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
        frequencyPenalty: data.frequencyPenalty ?? 0,
        presencePenalty: data.presencePenalty ?? 0,
        repetitionPenalty: data.repetitionPenalty ?? 1.0,
        stopSequencesJson: data.stopSequences ? JSON.stringify(data.stopSequences) : null,
        seed: data.seed ?? null,
        reasoningEffort: data.reasoningEffort ?? 'auto',
        showReasoning: data.showReasoning ? 1 : 0,
        streamResponse: data.streamResponse !== undefined ? (data.streamResponse ? 1 : 0) : 1,
        customSamplers: data.customSamplers ? 1 : 0,
        isActive: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return this.mapRow(row!);
  }

  async update(id: string, data: UpdateProviderData): Promise<ProviderProfile> {
    const now = this.clock.now();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const values: Record<string, any> = { updatedAt: now };

    if (data.name !== undefined) values.name = data.name;
    if (data.providerPreset !== undefined) values.providerPreset = data.providerPreset;
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
    if (data.frequencyPenalty !== undefined) values.frequencyPenalty = data.frequencyPenalty;
    if (data.presencePenalty !== undefined) values.presencePenalty = data.presencePenalty;
    if (data.repetitionPenalty !== undefined) values.repetitionPenalty = data.repetitionPenalty;
    if (data.stopSequences !== undefined) values.stopSequencesJson = JSON.stringify(data.stopSequences);
    if (data.seed !== undefined) values.seed = data.seed;
    if (data.reasoningEffort !== undefined) values.reasoningEffort = data.reasoningEffort;
    if (data.showReasoning !== undefined) values.showReasoning = data.showReasoning ? 1 : 0;
    if (data.streamResponse !== undefined) values.streamResponse = data.streamResponse ? 1 : 0;
    if (data.customSamplers !== undefined) values.customSamplers = data.customSamplers ? 1 : 0;

    const [row] = await this.db
      .update(providerProfiles)
      .set(values)
      .where(eq(providerProfiles.id, id))
      .returning();

    if (!row) {
      throw new Error(`ProviderProfile '${id}' not found after update`);
    }
    return this.mapRow(row);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(providerProfiles).where(eq(providerProfiles.id, id)).run();
  }

  async activate(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(providerProfiles).set({ isActive: 0 }).run();
      await tx.update(providerProfiles).set({ isActive: 1 }).where(eq(providerProfiles.id, id)).run();
    });
  }

  async duplicate(id: string): Promise<ProviderProfile> {
    const original = await this.db.select().from(providerProfiles).where(eq(providerProfiles.id, id)).get();
    if (!original) {
      throw new Error(`ProviderProfile '${id}' not found`);
    }

    const newId = this.idGen.next('prov');
    const now = this.clock.now();

    const [row] = await this.db
      .insert(providerProfiles)
      .values({
        id: newId,
        name: `${original.name} (copy)`,
        providerPreset: original.providerPreset,
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
        frequencyPenalty: original.frequencyPenalty,
        presencePenalty: original.presencePenalty,
        repetitionPenalty: original.repetitionPenalty,
        stopSequencesJson: original.stopSequencesJson,
        seed: original.seed,
        reasoningEffort: original.reasoningEffort,
        showReasoning: original.showReasoning,
        streamResponse: original.streamResponse,
        customSamplers: original.customSamplers,
        isActive: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return this.mapRow(row!);
  }

  // ─── Cached models ─────────────────────────────────────────────────────────

  async saveCachedModels(providerId: string, models: CachedModelData[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(cachedModels).where(eq(cachedModels.providerProfileId, providerId)).run();
      if (models.length > 0) {
        const values = models.map((model) => ({
          id: this.idGen.next('cmod'),
          providerProfileId: providerId,
          modelSlug: model.modelSlug,
          modelName: model.modelName,
          contextLength: model.contextLength ?? null,
          capabilitiesJson: JSON.stringify(model.capabilities ?? {}),
          fetchedAt: this.clock.now(),
        }));
        await tx.insert(cachedModels).values(values).run();
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

  async listFavoriteModels(providerId: string): Promise<FavoriteModel[]> {
    const rows = await this.db
      .select()
      .from(providerModelFavorites)
      .where(eq(providerModelFavorites.providerProfileId, providerId))
      .all();
    return rows.map((row) => this.mapFavoriteModelRow(row));
  }

  async addFavoriteModel(providerId: string, model: FavoriteModelData): Promise<FavoriteModel> {
    const now = this.clock.now();
    const existing = await this.db
      .select()
      .from(providerModelFavorites)
      .where(and(
        eq(providerModelFavorites.providerProfileId, providerId),
        eq(providerModelFavorites.modelId, model.modelId),
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
        label: model.label ?? null,
        contextLength: model.contextLength ?? null,
        createdAt: now,
      })
      .returning();
    return this.mapFavoriteModelRow(row!);
  }

  async removeFavoriteModel(providerId: string, modelId: string): Promise<void> {
    await this.db
      .delete(providerModelFavorites)
      .where(and(
        eq(providerModelFavorites.providerProfileId, providerId),
        eq(providerModelFavorites.modelId, modelId),
      ))
      .run();
  }

  // ─── Row mappers ───────────────────────────────────────────────────────────

  private mapRow(row: typeof providerProfiles.$inferSelect): ProviderProfile {
    return {
      id: row.id,
      name: row.name,
      providerPreset: row.providerPreset,
      endpoint: row.endpoint,
      apiKey: row.apiKey,
      defaultModel: row.defaultModel,
      contextBudget: row.contextBudget,
      maxTokens: row.maxTokens,
      temperature: row.temperature,
      topP: row.topP,
      topK: row.topK,
      minP: row.minP,
      topA: row.topA,
      frequencyPenalty: row.frequencyPenalty,
      presencePenalty: row.presencePenalty,
      repetitionPenalty: row.repetitionPenalty,
      stopSequences: row.stopSequencesJson ? JSON.parse(row.stopSequencesJson) : [],
      seed: row.seed,
      reasoningEffort: row.reasoningEffort,
      showReasoning: row.showReasoning === 1,
      streamResponse: row.streamResponse === 1,
      customSamplers: row.customSamplers === 1,
      isActive: row.isActive === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapCachedModelRow(row: typeof cachedModels.$inferSelect): CachedModel {
    return {
      id: row.id,
      providerProfileId: row.providerProfileId,
      modelSlug: row.modelSlug,
      modelName: row.modelName,
      contextLength: row.contextLength,
      capabilities: JSON.parse(row.capabilitiesJson),
      fetchedAt: row.fetchedAt,
    };
  }

  private mapFavoriteModelRow(row: typeof providerModelFavorites.$inferSelect): FavoriteModel {
    return {
      id: row.id,
      providerProfileId: row.providerProfileId,
      modelId: row.modelId,
      label: row.label,
      contextLength: row.contextLength,
      createdAt: row.createdAt,
    };
  }
}
