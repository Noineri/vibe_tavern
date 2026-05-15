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
export type PersonaId = Brand<"PersonaId">;
export type LorebookId = Brand<"LorebookId">;
export type LoreEntryId = Brand<"LoreEntryId">;
export type ChatId = Brand<"ChatId">;
export type ChatBranchId = Brand<"ChatBranchId">;
export type MessageId = Brand<"MessageId">;
export type MessageVariantId = Brand<"MessageVariantId">;
export type SummaryMemorySnapshotId = Brand<"SummaryMemorySnapshotId">;
export type RetrievedMemoryHitId = Brand<"RetrievedMemoryHitId">;
export type PromptTraceId = Brand<"PromptTraceId">;
export type ToolProfileId = Brand<"ToolProfileId">;
export type PromptPresetId = Brand<"PromptPresetId">;

/** Unsafe cast from a plain string to a branded ID. Use only at layer boundaries (DB, API). */
export function brandId<TId extends Id>(value: string): TId {
  return value as TId;
}
