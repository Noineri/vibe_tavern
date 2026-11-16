/**
 * Director message-editor delegate (DIRECTOR_MESSAGE_TOOLS_PLAN DMT-14).
 *
 * The Director's mechanical-correction tool REUSES the ordinary AI message
 * editor: the same `message_edit` task (`runMessageEditorTask`), the same
 * saved editor settings (the shared `resolveMessageEditorModelPair` domain
 * rule — the exact pair the ordinary modal seeds from), the same model
 * resolution. The ONLY difference is the instruction author: the Director
 * supplies the instruction instead of the user. The delegate returns the
 * candidate + provenance WITHOUT applying it — no message edit, no variant
 * append, no persistence (DMT-21 assembles the pending proposal; DMT-22
 * resolves it; DMT-23/24 are out of scope here). No tool wiring, no UI and
 * no enablement live in this module.
 *
 * Editor-not-configured mirrors the ordinary modal's Generate gate: with no
 * saved editor provider AND no legacy provider the modal cannot Generate,
 * and the delegate likewise reports `editor_not_configured` and makes NO
 * provider call — never an active-profile or Director-model fallback (the
 * tool must not silently bill a different model). An existing selected
 * provider with a blank model keeps the ordinary editor's downstream
 * profile-default resolution.
 *
 * Failure surface: preparation failures (unknown chat/target/source,
 * missing provider profile, non-canonical target) THROW the shared task's
 * route-grade errors — the caller (DMT-21) maps them to model-correctable
 * tool failures; generation failures come back as the `failed` outcome.
 * The target/sources are validated by the task against THIS delegate's
 * internal branch scope (the thread's chat/branch passed by the caller),
 * never the browser's active chat.
 */

import {
  resolveMessageEditorModelPair,
  type MessageEditorModelPairSource,
} from "@vibe-tavern/domain";
import {
  runMessageEditorTask,
  type MessageEditorTaskDeps,
} from "../ai-assistant/message-editor-task.js";

export interface DirectorMessageEditorDelegateInput {
  /** The thread's chat, resolved by the caller from the sidechat thread — never the browser's active chat. */
  readonly chatId: string;
  /** INTERNAL branch scope: the thread's pinned branch for this correction; the task validates the target and sources against it. */
  readonly branchId: string;
  /** The committed assistant reply being corrected. */
  readonly targetMessageId: string;
  /** The ONE source swipe the correction edits (`message_edit` takes exactly one source). */
  readonly sourceVariantId: string;
  /** The Director's instruction — the only field that differs from the ordinary editor. */
  readonly instruction: string;
  readonly signal?: AbortSignal;
}

export interface DirectorMessageEditorDelegateDeps extends MessageEditorTaskDeps {
  /** Server-side ui settings — the same persisted pairs the web modal seeds from. */
  readonly getUiSettings: () => Promise<MessageEditorModelPairSource | null>;
}

/** The editor's ACTUAL provenance — the fields `AddEditorVariantInput` persists for editor variants and the DMT-11 `directorMessageEditProposalSchema` freezes. */
export interface DirectorMessageEditorProvenance {
  readonly modelId: string;
  readonly presetName?: string;
  readonly finishReason?: string;
}

export type DirectorMessageEditorDelegateResult =
  | { readonly status: "completed"; readonly candidate: string; readonly editor: DirectorMessageEditorProvenance }
  | { readonly status: "editor_not_configured" }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly reason: string };

export async function runDirectorMessageEditorDelegate(
  input: DirectorMessageEditorDelegateInput,
  deps: DirectorMessageEditorDelegateDeps,
): Promise<DirectorMessageEditorDelegateResult> {
  // One shared pair rule (packages/domain): the ordinary modal and this
  // delegate resolve the same saved editor settings.
  const pair = resolveMessageEditorModelPair(await deps.getUiSettings());
  if (!pair.providerId) {
    return { status: "editor_not_configured" };
  }
  const outcome = await runMessageEditorTask({
    mode: "message_edit",
    chatId: input.chatId,
    branchId: input.branchId,
    targetMessageId: input.targetMessageId,
    sourceVariantIds: [input.sourceVariantId],
    instruction: input.instruction,
    providerProfileId: pair.providerId,
    model: pair.modelName || undefined, // blank keeps the ordinary downstream model resolution
    enabledLayers: [], // the ordinary editor modal generates with the empty layer set
  }, deps, input.signal);
  switch (outcome.status) {
    case "completed":
      return {
        status: "completed",
        candidate: outcome.result.candidate,
        editor: {
          modelId: outcome.result.modelId,
          ...(outcome.result.presetName ? { presetName: outcome.result.presetName } : {}),
          ...(outcome.result.finishReason ? { finishReason: outcome.result.finishReason } : {}),
        },
      };
    case "cancelled":
      return { status: "cancelled" };
    case "failed":
      return { status: "failed", reason: outcome.reason };
  }
}
