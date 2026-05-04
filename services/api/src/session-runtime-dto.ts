import type { PromptTraceRecordDto } from "@rp-platform/domain";
import type { LoreEntry, Message, MessageVariant } from "@rp-platform/domain";
import type { ProviderProfile, PromptTrace as DbPromptTrace } from "@rp-platform/db";

// Re-export for backward compat — services that import this type will migrate
// their field access in the service layer, not here.
export type StoredProviderProfileRecord = {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  apiKey: string | null;
  defaultModel?: string | null;
  contextBudget?: number | null;
  temperature?: number;
  topP?: number;
  minP?: number;
  topK?: number;
  typicalP?: number;
  repPen?: number;
  freqPen?: number;
  presPen?: number;
  maxTokens?: number;
  stopSeq?: string;
  seed?: string | null;
  reasoningEffort?: string;
  streamResponse?: boolean;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export interface ClientProviderProfileRecord {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  defaultModel?: string | null;
  contextBudget?: number | null;
  temperature?: number;
  topP?: number;
  minP?: number;
  topK?: number;
  typicalP?: number;
  repPen?: number;
  freqPen?: number;
  presPen?: number;
  maxTokens?: number;
  stopSeq?: string;
  seed?: string | null;
  reasoningEffort?: string;
  streamResponse?: boolean;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
  hasStoredApiKey: boolean;
}

export interface CachedProviderModelsRecord {
  models: Array<{ id: string; label: string }>;
  cachedAt: string;
}

export interface MessageDto extends Message {
  variants: MessageVariant[];
  selectedVariantIndex: number | null;
}

// ─── Adapter: new ProviderProfile → old StoredProviderProfileRecord ──────────

export function providerProfileToStoredRecord(profile: ProviderProfile): StoredProviderProfileRecord {
  return {
    id: profile.id,
    name: profile.name,
    type: profile.providerPreset,
    endpoint: profile.endpoint,
    apiKey: profile.apiKey,
    defaultModel: profile.defaultModel,
    contextBudget: profile.contextBudget,
    temperature: profile.temperature,
    topP: profile.topP,
    minP: profile.minP,
    topK: profile.topK,
    typicalP: 1.0,
    repPen: profile.repetitionPenalty,
    freqPen: profile.frequencyPenalty,
    presPen: profile.presencePenalty,
    maxTokens: profile.maxTokens,
    stopSeq: profile.stopSequences.join(","),
    seed: profile.seed,
    reasoningEffort: profile.reasoningEffort,
    streamResponse: profile.streamResponse,
    isActive: profile.isActive,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

// ─── Adapter: old patch shape → new UpdateProviderData ────────────────────────

export function providerPatchToUpdateData(patch: {
  name?: string;
  type?: string;
  endpoint?: string;
  apiKey?: unknown;
  defaultModel?: string | null;
  contextBudget?: number | null;
  temperature?: number;
  topP?: number;
  minP?: number;
  topK?: number;
  typicalP?: number;
  repPen?: number;
  freqPen?: number;
  presPen?: number;
  maxTokens?: number;
  stopSeq?: string;
  seed?: string | null;
  reasoningEffort?: string;
  streamResponse?: boolean;
}): import("@rp-platform/db").UpdateProviderData {
  const data: import("@rp-platform/db").UpdateProviderData = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.type !== undefined) data.providerPreset = patch.type;
  if (patch.endpoint !== undefined) data.endpoint = patch.endpoint;
  if (patch.apiKey !== undefined) data.apiKey = typeof patch.apiKey === "string" ? patch.apiKey : undefined;
  if (patch.defaultModel !== undefined) data.defaultModel = patch.defaultModel;
  if (patch.contextBudget !== undefined) data.contextBudget = patch.contextBudget;
  if (patch.temperature !== undefined) data.temperature = patch.temperature;
  if (patch.topP !== undefined) data.topP = patch.topP;
  if (patch.minP !== undefined) data.minP = patch.minP;
  if (patch.topK !== undefined) data.topK = patch.topK;
  if (patch.repPen !== undefined) data.repetitionPenalty = patch.repPen;
  if (patch.freqPen !== undefined) data.frequencyPenalty = patch.freqPen;
  if (patch.presPen !== undefined) data.presencePenalty = patch.presPen;
  if (patch.maxTokens !== undefined) data.maxTokens = patch.maxTokens;
  if (patch.stopSeq !== undefined) data.stopSequences = patch.stopSeq ? patch.stopSeq.split(",").map(s => s.trim()).filter(Boolean) : [];
  if (patch.seed !== undefined) data.seed = patch.seed;
  if (patch.reasoningEffort !== undefined) data.reasoningEffort = patch.reasoningEffort;
  if (patch.streamResponse !== undefined) data.streamResponse = patch.streamResponse;
  return data;
}

export function mapPromptTraceRecord(trace: DbPromptTrace): PromptTraceRecordDto {
  return {
    id: trace.id,
    chatId: trace.chatId as any,
    branchId: trace.branchId as any,
    messageId: trace.messageId as any,
    model: trace.model,
    presetName: trace.presetName,
    latencyMs: trace.latencyMs,
    createdAt: trace.createdAt,
    layers: trace.assembledLayers as PromptTraceRecordDto["layers"],
    tokenAccounting: trace.tokenAccounting,
    activatedLoreEntries: [],
    retrievedMemories: [],
    finalPayload: trace.finalPayload,
  };
}

export function mapMessageDto(message: Message, variants: MessageVariant[]): MessageDto;
export function mapMessageDto(message: Record<string, unknown>, variants: Array<Record<string, unknown>>): MessageDto;
export function mapMessageDto(message: any, variants: any[]): MessageDto {
  const selectedVariant = variants.find((variant) => variant.isSelected) ?? null;
  return {
    ...message,
    content: selectedVariant?.content ?? message.content,
    variants,
    selectedVariantIndex: selectedVariant?.variantIndex ?? null,
  };
}

export function entryMatchesRecentText(entry: LoreEntry, lowerText: string): boolean {
  if (!entry.enabled) {
    return false;
  }

  const primaryMatched =
    entry.keys.length === 0
      ? Boolean((entry.metadata.stConstant as boolean | undefined) ?? false)
      : entry.keys.some((key) => lowerText.includes(key.toLowerCase()));

  if (!primaryMatched) {
    return false;
  }

  if (entry.secondaryKeys.length === 0) {
    return true;
  }

  const matchedSecondary = entry.secondaryKeys.filter((key) =>
    lowerText.includes(key.toLowerCase()),
  );

  switch (entry.logic) {
    case "and_all":
      return matchedSecondary.length === entry.secondaryKeys.length;
    case "not_all":
      return matchedSecondary.length < entry.secondaryKeys.length;
    case "not_any":
      return matchedSecondary.length === 0;
    case "and_any":
    default:
      return matchedSecondary.length > 0;
  }
}

export function toClientProviderProfile(profile: StoredProviderProfileRecord): ClientProviderProfileRecord {
  return {
    id: profile.id,
    name: profile.name,
    type: profile.type,
    endpoint: profile.endpoint,
    defaultModel: profile.defaultModel ?? null,
    contextBudget: profile.contextBudget ?? null,
    temperature: profile.temperature ?? 0.9,
    topP: profile.topP ?? 1.0,
    minP: profile.minP ?? 0.05,
    topK: profile.topK ?? 40,
    typicalP: profile.typicalP ?? 1.0,
    repPen: profile.repPen ?? 1.1,
    freqPen: profile.freqPen ?? 0.0,
    presPen: profile.presPen ?? 0.0,
    maxTokens: profile.maxTokens ?? 8192,
    stopSeq: profile.stopSeq ?? '',
    seed: profile.seed ?? null,
    reasoningEffort: profile.reasoningEffort ?? 'medium',
    streamResponse: profile.streamResponse !== false,
    isActive: profile.isActive === true,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    hasStoredApiKey: Boolean(profile.apiKey),
  };
}

export function resolveStoredApiKey(input: unknown, fallback: string | null): string | null {
  if (input === null) {
    return null;
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed || fallback;
  }

  return fallback;
}
