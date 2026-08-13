/**
 * Star-prompt trigger — the imperative half of the policy in star-prompt.ts.
 *
 * The counter is authoritative on the server (ChatRuntime.prepareLiveTurn bumps
 * it per committed live user turn), but the frontend never re-reads it
 * mid-session, so it keeps a local mirror and bumps it by the same 1 per turn.
 * The two converge on the next bootstrap; a mirror that drifts because the
 * client died mid-turn only shifts a nag prompt by one message.
 */
import * as buildConfig from "../build-config.js";
import { useBootstrapStore } from "../stores/api-actions/bootstrap-actions.js";
import { useChatStore } from "../stores/chat-store.js";
import { useModalStore } from "../stores/modal-store.js";
import { isStarPromptDue } from "./star-prompt.js";

export interface StarPromptGuards {
  wizardVisible: boolean;
  anyModalOpen: boolean;
  anyGenerationActive: boolean;
}

/**
 * Whether the screen is quiet enough to interrupt. Guards only delay — they
 * never advance the due point, so a suppressed prompt is retried after the next
 * reply.
 */
export function canShowStarPrompt(guards: StarPromptGuards): boolean {
  return !guards.wizardVisible && !guards.anyModalOpen && !guards.anyGenerationActive;
}

/**
 * Called once per settled live user turn.
 *
 * The mirror advances on EVERY settled outcome, not just a completed reply: the
 * server increments as soon as the user message is committed, so a cancelled or
 * provider-failed turn still counts there. Only the modal is gated on
 * `replyCompleted` — interrupting right after a failure would be the worst
 * possible moment to ask for a favour.
 */
export function notifyUserTurnSettled(replyCompleted: boolean): void {
  const data = useBootstrapStore.getState().data;
  if (!data) return;

  const uiSettings = {
    ...data.uiSettings,
    userMessageCount: (data.uiSettings.userMessageCount ?? 0) + 1,
  };
  useBootstrapStore.setState({ data: { ...data, uiSettings } });

  if (!replyCompleted) return;

  if (!isStarPromptDue({
    githubStarred: uiSettings.githubStarred ?? false,
    userMessageCount: uiSettings.userMessageCount,
    nextStarPromptAt: uiSettings.nextStarPromptAt ?? 100,
  })) return;

  const modals = useModalStore.getState();
  const anyModalOpen = Object.entries(modals).some(
    ([key, value]) => key !== "isStarPromptOpen" && typeof value === "boolean" && value,
  );
  const anyGenerationActive = Object.values(useChatStore.getState().generations).some((g) => g.isSending);
  // Mirrors SetupWizard.tsx — the wizard is on screen for exactly this
  // condition, and reading it here avoids threading a prop through the chat
  // controller. It also stays true for the rest of a first-run session even
  // after the wizard is dismissed, which is the desired bias: the very first
  // session is not the moment for a second ask.
  const wizardVisible = (data.isFirstRun ?? false) || buildConfig.FORCE_FIRST_RUN;

  if (!canShowStarPrompt({ wizardVisible, anyModalOpen, anyGenerationActive })) return;
  modals.setStarPromptOpen(true);
}
