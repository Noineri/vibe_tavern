/**
 * Branch fork entry point (SC-21) — extracted out of `use-chat-controller`
 * (file-size ratchet): the controller's `handleFork` delegates here, so all
 * three fork call sites (message action, `RichChatRow`, `SidebarFlyout`)
 * share the one confirm gate instead of three per-caller copies.
 *
 * When the source branch owns ACTIVE sidechat sessions, open the calm
 * three-button confirm first (with-sidechat / plain-fork / cancel);
 * otherwise — and on any summary failure — run exactly today's fork, no
 * confirm, no extra UI. The copy runs inside `forkBranchAction`'s deduped
 * request (see its `copySidechat` option), so two rapid fork clicks still
 * fork once and copy once.
 */
import type { ChatId } from "@vibe-tavern/domain";
import { getT } from "../i18n/locale-helpers.js";
import { getBranchSidechatSummary } from "../api/agent-chat-api.js";
import { useCharacterStore } from "../stores/character-store.js";
import { useChatStore } from "../stores/chat-store.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";
import { forkBranchAction } from "../stores/api-actions/chat-actions.js";

export async function forkBranchFlow(chatId: ChatId, messageId?: string): Promise<void> {
  async function runFork(copySidechat: boolean): Promise<void> {
    // Forking a long branch can take seconds. Avoid a distracting flash for
    // fast requests, but make the originating message visibly busy when it
    // crosses the interaction-feedback threshold.
    const feedbackTimer = messageId == null
      ? null
      : window.setTimeout(() => useChatStore.getState().setMessageActionId(messageId), 200);
    try {
      await forkBranchAction(chatId, messageId, copySidechat ? { copySidechat: true } : undefined);
    } finally {
      if (feedbackTimer != null) window.clearTimeout(feedbackTimer);
      if (messageId != null && useChatStore.getState().messageActionId === messageId) {
        useChatStore.getState().setMessageActionId(null);
      }
    }
  }

  // Best-effort gate: a failed summary NEVER blocks the primary action —
  // the fork proceeds as today and the confirm never opens.
  const sourceBranchId = useSnapshotStore.getState().activeBranch?.id ?? null;
  if (sourceBranchId) {
    const summary = await getBranchSidechatSummary(chatId, sourceBranchId).catch(() => null);
    if (summary?.hasSessions) {
      const t = getT();
      useCharacterStore.getState().setConfirmDestroy({
        title: t("sidechat_fork_confirm_title"),
        body: t("sidechat_fork_confirm_body"),
        confirmLabel: t("sidechat_fork_confirm_with"),
        secondaryLabel: t("sidechat_fork_confirm_plain"),
        onSecondary: () => void runFork(false),
        onConfirm: () => void runFork(true),
        tone: "calm",
      });
      return;
    }
  }
  await runFork(false);
}
