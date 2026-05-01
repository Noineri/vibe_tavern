import type { PromptTraceRecordDto } from "@rp-platform/domain";
import type { LoreEntry, Message, MessageVariant, PromptTrace, StoredProviderProfileRecord } from "@rp-platform/domain";

export type { StoredProviderProfileRecord };



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

export function mapPromptTraceRecord(trace: PromptTrace): PromptTraceRecordDto {
  return {
    id: trace.id,
    chatId: trace.chatId,
    branchId: trace.branchId,
    messageId: trace.messageId,
    model: trace.model,
    presetName: trace.presetName,
    latencyMs: trace.latencyMs,
    createdAt: trace.createdAt,
    layers: trace.assembledLayers as PromptTraceRecordDto["layers"],
    tokenAccounting: trace.tokenAccounting,
    activatedLoreEntries: trace.activatedLoreEntries,
    retrievedMemories: trace.retrievedMemories,
    finalPayload: trace.finalPayload,
  };
}

export function mapMessageDto(message: Message, variants: MessageVariant[]): MessageDto {
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
