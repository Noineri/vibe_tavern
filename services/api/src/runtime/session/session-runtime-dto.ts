import { brandId, type ChatId, type ChatBranchId, type MessageId, type PromptTraceRecordDto, type ModelSettingsOverlay } from "@vibe-tavern/domain";
import type { LoreEntry, Message, MessageVariant, Attachment } from "@vibe-tavern/domain";
import { parseStoredAttachments } from "@vibe-tavern/domain";
import type { PromptTrace as DbPromptTrace, Message as DbMessage, MessageVariant as DbMessageVariant } from "@vibe-tavern/db";
import type {
	ClientProviderProfileRecord,
	CachedProviderModelsRecord,
	FavoriteProviderModelRecord,
	ProviderModelSettingsRecord,
} from "@vibe-tavern/api-contracts";

// Re-export canonical types — single source of truth.
// The wire-DTO interfaces live in @vibe-tavern/api-contracts (shared with the
// frontend) so drift becomes a compile error. Re-exported here so existing
// backend importers (provider-profile-service, runtime-api, provider-adapter)
// keep resolving without changing their import paths.
export type { StoredProviderProfileRecord } from "@vibe-tavern/domain";
export type {
	ClientProviderProfileRecord,
	CachedProviderModelsRecord,
	FavoriteProviderModelRecord,
	ProviderModelSettingsRecord,
};

export interface MessageDto extends Message {
  variants: MessageVariant[];
  selectedVariantIndex: number | null;
  modelId: string | null;
  attachments?: Attachment[];
}

export function mapPromptTraceRecord(trace: DbPromptTrace): PromptTraceRecordDto {
  return {
    id: trace.id,
    chatId: brandId<ChatId>(trace.chatId),
    branchId: brandId<ChatBranchId>(trace.branchId),
    messageId: brandId<MessageId>(trace.messageId),
    model: trace.model,
    presetName: trace.presetName,
    latencyMs: trace.latencyMs,
    createdAt: trace.createdAt,
    layers: trace.assembledLayers as PromptTraceRecordDto["layers"],
    tokenAccounting: trace.tokenAccounting,
    activatedLoreEntries: (trace.activatedLoreEntries ?? []) as string[],
    activatedLoreDetail: trace.activatedLoreDetail ?? [],
    scriptInjections: (trace.scriptInjections ?? []) as PromptTraceRecordDto["scriptInjections"],
    retrievedMemories: (trace.retrievedMemories ?? []) as Array<Record<string, unknown>>,
    finalPayload: trace.finalPayload,
    prefill: trace.prefill ?? null,
    compactionSummary: trace.compactionSummary ?? null,
    sentConfig: trace.sentConfig ?? undefined,
  };
}

export function mapMessageDto(message: Message, variants: MessageVariant[]): MessageDto;
export function mapMessageDto(message: DbMessage, variants: DbMessageVariant[]): MessageDto;
export function mapMessageDto(message: Message | DbMessage, variants: MessageVariant[] | DbMessageVariant[]): MessageDto {
  const selectedVariant = variants.find((variant) => variant.isSelected) ?? null;
  const attachments = parseStoredAttachments('attachmentsJson' in message ? message.attachmentsJson : null);
  return {
    id: message.id as MessageId,
    chatId: message.chatId as ChatId,
    branchId: message.branchId as ChatBranchId,
    role: message.role as Message['role'],
    authorType: message.authorType as Message['authorType'],
    position: message.position,
    content: selectedVariant?.content ?? message.content,
    modelId: selectedVariant?.modelId ?? null,
    state: message.state as Message['state'],
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    variants: variants as MessageVariant[],
    selectedVariantIndex: selectedVariant?.variantIndex ?? null,
    ...(attachments ? { attachments } : {}),
  } satisfies MessageDto;
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

export function toClientProviderProfile(profile: import("@vibe-tavern/domain").StoredProviderProfileRecord): ClientProviderProfileRecord {
  return {
    id: profile.id,
    name: profile.name,
    providerPreset: profile.providerPreset,
    endpoint: profile.endpoint,
    defaultModel: profile.defaultModel,
    visionModel: profile.visionModel,
    contextBudget: profile.contextBudget,
    pinContextBudget: profile.pinContextBudget,
    bindPerModel: profile.bindPerModel,
    maxTokens: profile.maxTokens,
    temperature: profile.temperature,
    topP: profile.topP,
    topK: profile.topK,
    minP: profile.minP,
    topA: profile.topA,
    typicalP: profile.typicalP,
    tfsZ: profile.tfsZ,
    repeatLastN: profile.repeatLastN,
    mirostat: profile.mirostat,
    mirostatTau: profile.mirostatTau,
    mirostatEta: profile.mirostatEta,
    dryMultiplier: profile.dryMultiplier,
    dryBase: profile.dryBase,
    dryAllowedLength: profile.dryAllowedLength,
    drySequenceBreakers: profile.drySequenceBreakers,
    xtcThreshold: profile.xtcThreshold,
    xtcProbability: profile.xtcProbability,
    frequencyPenalty: profile.frequencyPenalty,
    presencePenalty: profile.presencePenalty,
    repetitionPenalty: profile.repetitionPenalty,
    stopSequences: profile.stopSequences,
    logitBias: profile.logitBias,
    seed: profile.seed,
    reasoningEffort: profile.reasoningEffort,
    showReasoning: profile.showReasoning,
    streamResponse: profile.streamResponse,
    customSamplers: profile.customSamplers,
    hasStoredApiKey: !!profile.apiKey,
    isActive: profile.isActive,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
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
