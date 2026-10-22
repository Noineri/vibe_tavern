import type { UiSettingsRecord } from "../../api/types.js";

type EditorPairSource = Pick<
  UiSettingsRecord,
  "messageEditorProviderId" | "messageEditorModelName" | "aiAssistantProviderId" | "aiAssistantModelName"
>;

/**
 * SUM-5: the message editor owns its context slot. Seed order: the editor's own
 * persisted pair (its model may be empty — that provider's default), then the
 * legacy ai-assistant pair (upgrade fallback — a selection made before the
 * split keeps working and STOPS writing there), then empty (active-profile
 * default resolves downstream). The pair is taken whole: a model belongs to the
 * provider it was saved with, so the editor's provider never borrows the legacy
 * pair's model.
 */
export function resolveMessageEditorSeed(ui: EditorPairSource | null): { providerId: string; modelName: string } {
  if (ui?.messageEditorProviderId) {
    return { providerId: ui.messageEditorProviderId, modelName: ui.messageEditorModelName ?? "" };
  }
  return { providerId: ui?.aiAssistantProviderId ?? "", modelName: ui?.aiAssistantModelName ?? "" };
}
