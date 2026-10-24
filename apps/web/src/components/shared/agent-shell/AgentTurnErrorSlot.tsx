/**
 * AgentTurnErrorSlot (AGENT_SHELL_POLISH, Wave 3 / AP-13) — the error card's
 * feed-end slot, extracted from `AgentMessageList.tsx` under the file-size
 * ratchet (the list sits at the 800-line cap). Owns the AP-13 render
 * decision: the loud live card (the controller's per-thread failure) wins;
 * otherwise the quiet after-reload derivation (the thread's last VISIBLE row
 * is an unanswered user message and nothing streams) renders. A failed turn
 * has neither pending block, so the card is last wherever the list places
 * this slot. No retry target = no card (the retry needs a handler). The card
 * itself lives in `AgentTurnErrorCard.tsx`.
 */
import type { OrderedCopilotMessage } from "../../../lib/copilot-context.js";
import { AgentTurnErrorCard } from "./AgentTurnErrorCard.js";
import type { AgentTurnFailure } from "./use-agent-controller.js";

export interface AgentTurnErrorSlotProps {
  /** The thread's live turn failure (null = no live failure this thread). */
  turnFailure: AgentTurnFailure | null;
  /** The digest-ordered flow the list renders — the quiet derivation reads
   *  its last FLOW row, skipping trailing digest rows (AP-33 keeps a digest
   *  at its chronological slot, so a compaction that died before answering
   *  leaves the separator after the unanswered user row — never masked). */
  visibleMessages: readonly OrderedCopilotMessage[];
  /** True while a turn streams (its optimistic user row is pending, not
   *  unanswered — fresh threads stream their first turn, so this also keeps
   *  the empty-state's successor quiet). */
  isSending: boolean;
  /** Retry the failed turn — absent renders nothing. */
  onRetryTurn?: () => void;
}

export function AgentTurnErrorSlot({ turnFailure, visibleMessages, isSending, onRetryTurn }: AgentTurnErrorSlotProps) {
  // The quiet after-reload card — the live failure state is gone (a reload
  // drops it), but the thread still waits. Content order: the loud card
  // wins when both hold (a retry's failure replaces the quiet content).
  // AP-33: a digest row can sit at the visible end (it stays where the
  // compaction ran) — the unanswered question reads the last FLOW row, so a
  // trailing separator never masks it.
  let lastVisibleRole: string | null = null;
  for (let i = visibleMessages.length - 1; i >= 0; i--) {
    const role = visibleMessages[i]!.message.role;
    if (role === "digest") continue;
    lastVisibleRole = role;
    break;
  }
  const showUnansweredCard = lastVisibleRole === "user" && !isSending;
  if (onRetryTurn === undefined || (turnFailure === null && !showUnansweredCard)) return null;
  return <AgentTurnErrorCard failure={turnFailure} onRetry={onRetryTurn} />;
}
