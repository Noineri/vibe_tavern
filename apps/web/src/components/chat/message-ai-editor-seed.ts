import { resolveMessageEditorModelPair } from "@vibe-tavern/domain";

import type { UiSettingsRecord } from "../../api/types.js";

type EditorPairSource = Pick<
  UiSettingsRecord,
  "messageEditorProviderId" | "messageEditorModelName" | "aiAssistantProviderId" | "aiAssistantModelName"
>;

/**
 * SUM-5 web compatibility shim (DMT-14): the editor-pair selection rule moved
 * to `@vibe-tavern/domain/message-editor-model` so the Director's editor
 * delegate resolves the SAME pair — this file is a consumer of that one
 * derivation, not a second copy. The exported shape is unchanged so the
 * modal's call site is untouched.
 */
export function resolveMessageEditorSeed(ui: EditorPairSource | null): { providerId: string; modelName: string } {
  return resolveMessageEditorModelPair(ui);
}
