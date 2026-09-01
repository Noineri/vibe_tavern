export type Id = string;

/**
 * Phantom brand type that prevents accidental mixing of ID types at compile time.
 *
 * `brandId()` performs an unsafe cast intended only at serialization boundaries
 * (database rows, API payloads) where the brand guarantee is already established.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type Brand<TBrand extends string> = string & { readonly __brand: TBrand };

export type CharacterId = Brand<"CharacterId">;
export type CharacterVersionId = Brand<"CharacterVersionId">;
export type CharacterAssetId = Brand<"CharacterAssetId">;
export type PersonaId = Brand<"PersonaId">;
export type LorebookId = Brand<"LorebookId">;
export type LoreEntryId = Brand<"LoreEntryId">;
export type ChatId = Brand<"ChatId">;
export type ChatBranchId = Brand<"ChatBranchId">;
export type ChatSummaryId = Brand<"ChatSummaryId">;
export type MessageId = Brand<"MessageId">;
export type MessageVariantId = Brand<"MessageVariantId">;
export type SummaryMemorySnapshotId = Brand<"SummaryMemorySnapshotId">;
export type RetrievedMemoryHitId = Brand<"RetrievedMemoryHitId">;
export type PromptTraceId = Brand<"PromptTraceId">;
export type ToolProfileId = Brand<"ToolProfileId">;
export type PromptPresetId = Brand<"PromptPresetId">;
export type ScriptId = Brand<"ScriptId">;
export type RegexPresetId = Brand<"RegexPresetId">;
export type RegexProfileId = Brand<"RegexProfileId">;
export type ServicePromptProfileId = Brand<"ServicePromptProfileId">;
export type DiceRollId = Brand<"DiceRollId">;
export type DicePendingLaneId = Brand<"DicePendingLaneId">;
// TTS voice profiles (TTS_PLAN TS-1).
export type TtsProfileId = Brand<"TtsProfileId">;
// STT (speech-to-text) profiles (STT_PLAN ST-1).
export type SttProfileId = Brand<"SttProfileId">;

// ─── Interactive Runtime (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 1) ─────────
export type ExperienceVisualId = Brand<"ExperienceVisualId">;
export type ExperienceSessionId = Brand<"ExperienceSessionId">;
export type ExperienceStepId = Brand<"ExperienceStepId">;
export type ExperienceEffectId = Brand<"ExperienceEffectId">;
export type ExperienceContextBundleId = Brand<"ExperienceContextBundleId">;
export type ExperienceAttachmentId = Brand<"ExperienceAttachmentId">;
// Experience copilot thread/message persistence (EXPERIENCE_EDITOR_REFACTOR_PLAN, ER-3).
export type ExperienceCopilotThreadId = Brand<"ExperienceCopilotThreadId">;
export type ExperienceCopilotMessageId = Brand<"ExperienceCopilotMessageId">;

/** Unsafe cast from a plain string to a branded ID. Use only at layer boundaries (DB, API). */
export function brandId<TId extends Id>(value: string): TId {
  return value as TId;
}
