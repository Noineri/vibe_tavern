/**
 * Send-conflict handlers (DICE-F3 / IR-70H) — extracted from
 * use-chat-controller.ts (SM-8 file-size ratchet; the controller keeps its
 * budget by owning only orchestration).
 *
 * Subtractive-only by design: when Dice is disabled, the lane is absent/empty,
 * or there is nothing bindable, every helper here collapses to "no conflict"
 * so a no-Dice send stays byte-identical to before. These conflicts can only
 * ever divert a send away from the generic provider-error path, never unblock
 * anything.
 */
import type { Attachment, ChatId } from "@vibe-tavern/domain";
import { restoreDraftAfterSendError } from "../lib/failed-send-draft.js";
import { useDiceStore } from "../stores/dice-store.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";
import type { DiceSendCommitIntent } from "../api/types.js";
import { diceConflictCode, experienceConflictCode } from "./chat-controller-error-codes.js";
import { diceSendBlockReason, type DiceSendBlock } from "./dice-send-gate.js";

/** Imperative read (at send time) of the dice commit intent + any block, for the
 *  CURRENT `{chatId, branchId}` and the chat's configured `diceMode`. The intent
 *  is captured ONLY when the active lane has a bindable (included) roll —
 *  otherwise it is undefined and the send body is byte-identical to a no-Dice
 *  send. */
export function readDiceSendState(): { commitIntent: DiceSendCommitIntent | undefined; blockReason: DiceSendBlock | null } {
  const snapshot = useSnapshotStore.getState();
  const chatId = snapshot.activeChat?.id ?? null;
  const branchId = snapshot.activeBranch?.id ?? null;
  const insights = snapshot.activeChat?.insightsConfig;
  if (!insights?.diceEnabled || !chatId || !branchId) return { commitIntent: undefined, blockReason: null };
  const diceMode = insights.diceMode;
  const lane = useDiceStore.getState().byScope[`${chatId}|${branchId}`]?.lanes?.[diceMode] ?? null;
  const blockReason = diceSendBlockReason(lane, snapshot.persona?.id ?? null, snapshot.activeChat?.characterId ?? null);
  if (blockReason) return { commitIntent: undefined, blockReason };
  const hasBindable = lane !== null && lane.rolls.some((roll) => roll.included);
  const commitIntent = lane && hasBindable ? { diceMode, pendingRevision: lane.revision } : undefined;
  return { commitIntent, blockReason: null };
}

/** A send that failed with a dice commit conflict (stale lane revision /
 * unresolved choose) is NOT a provider error — the lane moved under us. Resync
 * the pending lane and KEEP the draft so the user can re-review and resend.
 * Returns true when the error was a dice conflict (caller must skip the generic
 * provider-error path). */
export function tryHandleDiceSendConflict(
  error: unknown,
  chatId: ChatId,
  pendingUserContent: string | null | undefined,
  pendingAttachments: Attachment[] | undefined,
): boolean {
  if (diceConflictCode(error) === undefined) return false;
  restoreDraftAfterSendError(pendingUserContent, pendingAttachments);
  const branchId = useSnapshotStore.getState().activeBranch?.id ?? null;
  if (branchId) void useDiceStore.getState().refreshPending(chatId, branchId);
  return true;
}

/** A send that failed with an experience bind conflict (not_found /
 * already_bound / stale_queue / stale_session — IR-70H) is NOT a provider
 * error — the attachment moved under us. Restore the draft so the user can
 * re-review and resend. The authoritative attachment refresh is handled by the
 * post-settlement refresh in handleSend (requirement 3), not here. Returns
 * true when the error was an experience conflict (caller must skip the generic
 * provider-error path). */
export function tryHandleExperienceSendConflict(
  error: unknown,
  pendingUserContent: string | null | undefined,
  pendingAttachments: Attachment[] | undefined,
): boolean {
  if (experienceConflictCode(error) === undefined) return false;
  restoreDraftAfterSendError(pendingUserContent, pendingAttachments);
  return true;
}
