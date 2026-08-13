import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { getT, type TFunc } from "../i18n/locale-helpers.js";
import { streamExperienceCopilot } from "../api/experience-copilot-api.js";
import { useExperienceCopilotTurnStore } from "../stores/experience-copilot-turn-store.js";
import {
  coauthorSkillReadOutputSchema,
  experienceCopilotToolOutputSchema,
  type ExperienceCopilotStep,
} from "@vibe-tavern/api-contracts";
import { ProviderStreamError } from "../api/provider-stream-error.js";

/**
 * Experience-Copilot send/stream controller (EXPERIENCE_EDITOR_REFACTOR_PLAN,
 * Wave 4 / ER-11b).
 *
 * The copilot has its own transport (`streamExperienceCopilot`, ER-10) and its
 * own turn store (`useExperienceCopilotTurnStore`, ER-8), so it cannot reuse
 * the RP-chat `useChatController`. This hook ports the stream half of
 * `executeStreamAction`, retargeted and simplified: the copilot is stream-only,
 * with no dice/attachments/variants/regenerate/non-stream/insights and no
 * StreamingReveal — `pendingText` is a plain accumulated string.
 *
 * State is LOCAL (no new Zustand store): the copilot editor shell owns a single
 * controller instance and threads values down via props/context (ER-11c/11d).
 * The hook feeds the ER-8 turn store from the SSE tool events (exactly what the
 * shell renders as activity cards) and signals `onTurnSettled` so the shell can
 * refetch persisted messages once a turn settles.
 */

export interface UseExperienceCopilotControllerArgs {
  threadId: string | null;
  providerProfileId: string | null;
  model?: string;
  /** Called after a turn settles (done/cancelled/failed) so the shell can refetch persisted messages. */
  onTurnSettled?: () => void;
}

/** Live draft buffers + active authoring step to send with a copilot message so
 *  the model sees the current (possibly unsaved) source and knows which buffer
 *  the user is editing. */
export interface ExperienceCopilotSendOptions {
  rules?: string;
  visual?: string;
  step?: ExperienceCopilotStep;
}

export interface ExperienceCopilotController {
  isSending: boolean;
  /** Live assistant text accumulated from text-deltas this turn (cleared on settle). */
  pendingText: string;
  /** The user's just-sent message, shown optimistically while the model
   *  generates — the persisted user row only appears after the turn settles
   *  and the shell refetches, so without this the user's own message is
   *  invisible for the entire generation. Cleared in `finally`. */
  pendingUserContent: string;
  handleSend: (content: string, opts?: ExperienceCopilotSendOptions) => Promise<void>;
  handleCancel: () => void;
}

// Categories where the failure is likely transient (retry after a short wait) —
// the message alone is enough; we just add a "try again" hint. Mirrors the RP
// controller's `TRANSIENT_PROVIDER_CATEGORIES` set (see use-chat-controller.ts).
const TRANSIENT_PROVIDER_CATEGORIES = new Set(["rate_limit", "timeout", "network", "server_error"]);

/**
 * Category-aware provider-error toast. `showProviderErrorToast` in
 * use-chat-controller.ts is module-private, so this is its minimal replica
 * (same category → description mapping), minus the `open_provider_settings`
 * modal action (which is tied to the RP `useModalStore`; the copilot shell owns
 * its own provider selection).
 */
function showProviderErrorToast(error: unknown, t: TFunc): void {
  const message = error instanceof Error && error.message ? error.message : t("message_send_failed");
  const category = error instanceof ProviderStreamError ? error.category : "unknown";

  if (category === "authentication") {
    toast.error(message, { description: t("provider_error_auth_desc") });
    return;
  }
  if (TRANSIENT_PROVIDER_CATEGORIES.has(category)) {
    toast.error(message, { description: t("provider_error_transient_desc") });
    return;
  }
  if (category === "empty_response" || category === "parse_error") {
    toast.error(message, { description: t("provider_error_empty_desc") });
    return;
  }
  toast.error(message);
}

/**
 * Best-effort string summary of a tool-result `output`. The SSE parser hands
 * `output` already JSON-parsed (never circular), so `JSON.stringify` cannot
 * throw here and no try/catch is needed. Mirrors the persisted path's
 * `summary: message.content` (the raw tool-result string).
 */
function summarizeToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === null || output === undefined) return "";
  return JSON.stringify(output);
}

export function useExperienceCopilotController(
  args: UseExperienceCopilotControllerArgs,
): ExperienceCopilotController {
  const { threadId, providerProfileId, model, onTurnSettled } = args;

  const [isSending, setIsSending] = useState(false);
  const [pendingText, setPendingText] = useState("");
  // Optimistic user message: shown immediately on send so the user sees their
  // own message while the model generates (the persisted row only arrives
  // after the turn settles + the shell refetches). Cleared in `finally` so
  // every exit path (success / error / abort) drops it once the turn is done.
  const [pendingUserContent, setPendingUserContent] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  // Synchronous re-entrancy guard: `isSending` state flips on the next render,
  // so a rapid double-send in the same tick would otherwise both pass the
  // guard. Mirrors the RP controller reading generation state synchronously.
  const isSendingRef = useRef(false);

  const handleSend = useCallback(
    async (content: string, opts?: ExperienceCopilotSendOptions): Promise<void> => {
      const trimmed = content.trim();

      // Silent guards (no toast): empty content, missing thread, already sending.
      if (!trimmed || !threadId || isSendingRef.current) return;
      // Missing provider is the one guard that deserves feedback.
      if (!providerProfileId) {
        toast.error(getT()("message_unavailable_no_provider"));
        return;
      }

      // Start the turn fresh: drop the previous turn's tool activities (same
      // rationale as the RP controller's co-author clearTurn).
      useExperienceCopilotTurnStore.getState().clearTurn(threadId);

      const controller = new AbortController();
      abortRef.current = controller;
      isSendingRef.current = true;
      setIsSending(true);
      setPendingText("");
      setPendingUserContent(trimmed);

      try {
        await streamExperienceCopilot(
          threadId,
          {
            content: trimmed,
            providerProfileId,
            ...(model ? { model } : {}),
            ...(opts?.rules !== undefined ? { rules: opts.rules } : {}),
            ...(opts?.visual !== undefined ? { visual: opts.visual } : {}),
            ...(opts?.step ? { step: opts.step } : {}),
          },
          {
            signal: controller.signal,
            onStatus: () => {},
            onChunk: (delta) => setPendingText((p) => p + delta),
            onReasoningChunk: () => {},
            onToolCall: (info) => {
              useExperienceCopilotTurnStore.getState().upsertActivity(threadId, {
                toolCallId: info.toolCallId,
                toolName: info.toolName,
                args: info.args,
                status: "streaming",
              });
            },
            onToolInputStart: (info) => {
              useExperienceCopilotTurnStore.getState().upsertActivity(threadId, {
                toolCallId: info.toolCallId,
                toolName: info.toolName,
                status: "streaming",
              });
            },
            onToolResult: (info) => {
              // This routing MUST stay field-for-field with ER-8's
              // `extractPersistedExperienceCopilotActivities` so live activities
              // === persisted activities on snapshot refetch. The only addition
              // is the live-only `isError` signal, OR'd into the error status.
              if (info.toolName === "read_skill_file") {
                const read = coauthorSkillReadOutputSchema.safeParse(info.output);
                useExperienceCopilotTurnStore.getState().upsertActivity(threadId, {
                  toolCallId: info.toolCallId,
                  toolName: info.toolName,
                  status: info.isError || !read.success ? "error" : "done",
                  ...(read.success ? { readPath: read.data.path } : { summary: summarizeToolOutput(info.output) }),
                });
                return;
              }
              if (info.toolName === "write_buffer" || info.toolName === "edit_buffer") {
                const output = experienceCopilotToolOutputSchema.safeParse(info.output);
                useExperienceCopilotTurnStore.getState().upsertActivity(threadId, {
                  toolCallId: info.toolCallId,
                  toolName: info.toolName,
                  status: info.isError || !output.success ? "error" : "done",
                  ...(output.success
                    ? {
                        summary: output.data.summary,
                        target: output.data.target,
                        proposed: output.data.proposed,
                      }
                    : { summary: summarizeToolOutput(info.output) }),
                });
                return;
              }
              // run_test / run_simulate / suggest_visual_binding — non-proposal
              // informational digests (never parsed as a proposal). Always a
              // done card with a best-effort string summary.
              useExperienceCopilotTurnStore.getState().upsertActivity(threadId, {
                toolCallId: info.toolCallId,
                toolName: info.toolName,
                status: "done",
                summary: summarizeToolOutput(info.output),
              });
            },
          },
        );

        setPendingText("");
        setIsSending(false);
        isSendingRef.current = false;
        onTurnSettled?.();
      } catch (error) {
        if (controller.signal.aborted) {
          toast.info(getT()("generation_cancelled"));
        } else {
          showProviderErrorToast(error, getT());
        }
        setPendingText("");
        setIsSending(false);
        isSendingRef.current = false;
        onTurnSettled?.();
      } finally {
        abortRef.current = null;
        setPendingUserContent("");
      }
    },
    [threadId, providerProfileId, model, onTurnSettled],
  );

  const handleCancel = useCallback((): void => {
    abortRef.current?.abort();
    toast.info(getT()("cancelling_generation"));
  }, []);

  return { isSending, pendingText, pendingUserContent, handleSend, handleCancel };
}
