/**
 * The ONE editor-pair selection rule (DIRECTOR_MESSAGE_TOOLS_PLAN DMT-14).
 *
 * Moved verbatim from the web seed helper
 * (`apps/web/src/components/chat/message-ai-editor-seed.ts`) so the ordinary
 * editor modal and the Director's editor delegate (services/api) resolve the
 * SAME saved provider/model pair from one derivation — delegated editing is
 * the ordinary editor with a different instruction author, never a second
 * model rule.
 *
 * Seed order: the editor's own persisted pair (its model may be empty — that
 * provider's default), then the legacy ai-assistant pair (upgrade fallback —
 * a selection made before the split keeps working and STOPS writing there),
 * then empty (active-profile default resolves downstream). The pair is taken
 * WHOLE: a model belongs to the provider it was saved with, so the editor's
 * provider never borrows the legacy pair's model. A blank model is returned
 * as-is on purpose: the caller falls through to the ordinary downstream
 * resolution (the profile default) — the pair rule never invents a model.
 *
 * Pure and structural by domain-leaf law: the source is a field shape, not a
 * record type — the web bootstrap settings record and the server ui-settings
 * store row both satisfy it without importing either.
 */

/** The persisted ui-settings fields the pair is seeded from (both platforms' records satisfy this shape). */
export interface MessageEditorModelPairSource {
  readonly messageEditorProviderId?: string | null;
  readonly messageEditorModelName?: string | null;
  readonly aiAssistantProviderId?: string | null;
  readonly aiAssistantModelName?: string | null;
}

/** The resolved editor provider/model pair. An empty `modelName` means "downstream profile-default resolution"; an empty `providerId` means the editor is not configured. */
export interface MessageEditorModelPair {
  readonly providerId: string;
  readonly modelName: string;
}

export function resolveMessageEditorModelPair(ui: MessageEditorModelPairSource | null): MessageEditorModelPair {
  if (ui?.messageEditorProviderId) {
    return { providerId: ui.messageEditorProviderId, modelName: ui.messageEditorModelName ?? "" };
  }
  return { providerId: ui?.aiAssistantProviderId ?? "", modelName: ui?.aiAssistantModelName ?? "" };
}
