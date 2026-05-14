import type { PromptTraceRecordDto } from "@rp-platform/domain";
import type { LoreEntry, Message, MessageVariant } from "@rp-platform/domain";
import type { PromptTrace as DbPromptTrace } from "@rp-platform/db";

// Re-export canonical domain type — single source of truth
export type { StoredProviderProfileRecord } from "@rp-platform/domain";

export interface ClientProviderProfileRecord {
  id: string;
  name: string;
  providerPreset: string;
  endpoint: string;
  defaultModel: string | null;
  contextBudget: number | null;
  maxTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  topA: number;
  frequencyPenalty: number;
  presencePenalty: number;
  repetitionPenalty: number;
  stopSequences: string[];
  seed: string | null;
  reasoningEffort: string;
  showReasoning: boolean;
  streamResponse: boolean;
  customSamplers: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  hasStoredApiKey: boolean;
}

export interface CachedProviderModelsRecord {
  models: Array<{
    id: string;
    label: string;
    contextLength?: number;
    capabilities?: { thinking?: boolean; tools?: boolean; vision?: boolean };
  }>;
  cachedAt: string;
}

export interface FavoriteProviderModelRecord {
  id: string;
  providerProfileId: string;
  modelId: string;
  label: string | null;
  contextLength: number | null;
  createdAt: string;
}

export interface MessageDto extends Message {
  variants: MessageVariant[];
  selectedVariantIndex: number | null;
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
    prefill: trace.prefill ?? null,
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

export function toClientProviderProfile(profile: import("@rp-platform/domain").StoredProviderProfileRecord): ClientProviderProfileRecord {
  return {
    id: profile.id,
    name: profile.name,
    providerPreset: profile.providerPreset,
    endpoint: profile.endpoint,
    defaultModel: profile.defaultModel,
    contextBudget: profile.contextBudget,
    maxTokens: profile.maxTokens,
    temperature: profile.temperature,
    topP: profile.topP,
    topK: profile.topK,
    minP: profile.minP,
    topA: profile.topA,
    frequencyPenalty: profile.frequencyPenalty,
    presencePenalty: profile.presencePenalty,
    repetitionPenalty: profile.repetitionPenalty,
    stopSequences: profile.stopSequences,
    seed: profile.seed,
    reasoningEffort: profile.reasoningEffort,
    showReasoning: profile.showReasoning,
    streamResponse: profile.streamResponse,
    customSamplers: profile.customSamplers,
    isActive: profile.isActive,
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
