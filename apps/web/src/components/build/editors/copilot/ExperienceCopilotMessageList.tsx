import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import {
  extractHistoricalTurnActivities,
  useExperienceCopilotTurnStore,
  type CopilotAskState,
  type CopilotFeedEntry,
  type ExperienceCopilotToolActivity,
} from "../../../../stores/experience-copilot-turn-store.js";
import type { CopilotAskAnswerInput } from "../../../../api/experience-copilot-api.js";
import type { ExperienceCopilotPendingAskAnswer } from "../../../../hooks/use-experience-copilot-controller.js";
import { orderMessagesWithDigests } from "../../../../lib/copilot-context.js";
import { ExperienceCopilotMessageBlock } from "./ExperienceCopilotMessageBlock.js";
import { CopilotActivityCard } from "./CopilotActivityCard.js";
import { CopilotAskCard } from "./CopilotAskCard.js";
import { MessageReasoning } from "../../../chat/MessageReasoning.js";
import { Icons } from "../../../shared/icons.js";
import { EmptyState } from "../../../shared/empty-state.js";
import { useT } from "../../../../i18n/context.js";

const EMPTY: ExperienceCopilotToolActivity[] = [];
const EMPTY_FEED: CopilotFeedEntry[] = [];

/**
 * Experience-copilot message surface (ER-11c). Props-driven: the shell (ER-11d)
 * owns the persisted message list and the two-buffer state; this component
 * reads ONLY the ephemeral turn store (the one store read allowed inside these
 * presentation components, mirroring how `CoauthorMessageList` reads its turn
 * store) and renders the current turn's ordered feed (text segments + tool
 * activity cards, TF-4/TF-5) inline.
 *
 * Auto-scroll mirrors the co-author surface's bottom-pinning intent (stick to
 * the bottom while the user is already there; a jump-to-bottom button appears
 * when they scroll up). The copilot editor is an embedded surface, so this is a
 * plain scroll container rather than the chat `MessageScroller` (which is bound
 * to the RP chat stores).
 */
export interface ExperienceCopilotMessageListProps {
  threadId: string;
  messages: ExperienceCopilotMessageWire[];
  /** Live assistant text accumulated this turn (cleared by the shell on settle). */
  pendingText: string;
  /** Live model reasoning for the pending turn — rendered above the pending
   *  bubble with the co-author's MessageReasoning "minimal" pattern (UX
   *  2026-08-16 remark 4). Live-only: cleared on settle, not persisted. */
  pendingReasoning: string;
  /** The user's just-sent message, shown optimistically while the model
   *  generates (the persisted user row only lands after the turn settles). */
  pendingUserContent: string;
  /** TAG-9: disables ask-card interactivity while a stream runs. */
  isSending?: boolean;
  /** TAG-9: answer handler for the live awaiting ask card — bound by the
   *  shell with the current draft buffers (mirrors the input area's onSend). */
  onAnswer?: (toolCallId: string, answer: CopilotAskAnswerInput) => void;
  /** TAG-9: the controller's optimistic resolution of the just-answered ask —
   *  flips the card immediately, before the settle+refetch round-trip. */
  pendingAskAnswer?: ExperienceCopilotPendingAskAnswer | null;
}

export function ExperienceCopilotMessageList({
  threadId,
  messages,
  pendingText,
  pendingReasoning,
  pendingUserContent,
  isSending = false,
  onAnswer,
  pendingAskAnswer = null,
}: ExperienceCopilotMessageListProps) {
  const { t } = useT();
  const activities = useExperienceCopilotTurnStore(
    useShallow((s) => s.turnsByThread[threadId] ?? EMPTY),
  );
  const feed = useExperienceCopilotTurnStore(
    useShallow((s) => s.feedByThread[threadId] ?? EMPTY_FEED),
  );

  // CD-1 (TF-5 inline form): persisted tool rows render as audit cards at their
  // chronological position, not anchored before/after a turn's final reply.
  // Rebuilt purely from the wire messages; the live turn store keeps feeding
  // ONLY the current/last turn's feed below (dedupe by toolCallId: after
  // settle+refetch the latest turn exists in BOTH sources — the live feed owns
  // it until cleared by the next turn / Apply / Reject, then history takes over).
  const liveToolCallIds = useMemo(
    () => new Set(activities.map((activity) => activity.toolCallId)),
    [activities],
  );
  const historyActivities = useMemo(() => {
    const map = new Map<string, ExperienceCopilotToolActivity>();
    for (const turn of extractHistoricalTurnActivities(messages)) {
      for (const activity of turn.activities) map.set(activity.toolCallId, activity);
    }
    return map;
  }, [messages]);

  // Each tool row's card attaches to the NEXT flow message (user/assistant,
  // carriers included — they render as null, so the position is identical);
  // tool rows with no following flow message trail at the list's end. Digest
  // rows do NOT flush the accumulator (CM-9 moves them; cards keep their
  // chronological neighbors).
  const { anchorCards, trailingCards } = useMemo(() => {
    const anchor = new Map<string, ExperienceCopilotToolActivity[]>();
    let pending: ExperienceCopilotToolActivity[] = [];
    for (const m of messages) {
      if (m.role === "tool") {
        const activity = historyActivities.get(m.toolCallId ?? m.id);
        if (activity && !liveToolCallIds.has(activity.toolCallId)) pending.push(activity);
        continue;
      }
      if (m.role === "user" || m.role === "assistant") {
        if (pending.length > 0) {
          anchor.set(m.id, pending);
          pending = [];
        }
      }
    }
    return { anchorCards: anchor, trailingCards: pending };
  }, [messages, historyActivities, liveToolCallIds]);

  const activityById = useMemo(
    () => new Map(activities.map((a) => [a.toolCallId, a])),
    [activities],
  );

  // TAG-9: the chronologically LAST activity of the thread (live feed first —
  // it is the current turn; then trailing history cards; then the anchor
  // cards of the last flow message). Only an awaiting `ask_user` activity
  // that IS this last one renders interactively; an awaiting ask with any
  // later activity renders as expired (the user moved on). Raw `messages`
  // order is chronological for flow rows (digests are a separate role and
  // never hold anchor cards), so the scan runs on `messages` directly.
  const lastActivityId = useMemo(() => {
    for (let i = feed.length - 1; i >= 0; i--) {
      const entry = feed[i];
      if (entry && entry.kind === "activity") return entry.id;
    }
    const lastTrailing = trailingCards[trailingCards.length - 1];
    if (lastTrailing) return lastTrailing.toolCallId;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
      const cards = anchorCards.get(m.id);
      const last = cards?.[cards.length - 1];
      if (last) return last.toolCallId;
    }
    return null;
  }, [feed, trailingCards, anchorCards, messages]);

  // TAG-9: render an `ask_user` activity as the interactive ask card instead
  // of the generic activity card — everywhere an activity can appear (history
  // anchors, trailing cards, the live feed). The optimistic controller
  // override (`pendingAskAnswer`) flips the just-answered card immediately.
  const renderActivity = (activity: ExperienceCopilotToolActivity) => {
    const ask = activity.ask;
    if (ask) {
      const resolved: CopilotAskState =
        pendingAskAnswer && pendingAskAnswer.toolCallId === activity.toolCallId
          ? {
              ...ask,
              status: pendingAskAnswer.status,
              ...(pendingAskAnswer.answer !== undefined ? { answer: pendingAskAnswer.answer } : {}),
            }
          : ask;
      return (
        <CopilotAskCard
          key={activity.toolCallId}
          ask={resolved}
          interactive={
            resolved.status === "awaiting_answer" &&
            activity.toolCallId === lastActivityId &&
            !isSending &&
            onAnswer !== undefined
          }
          onSubmit={onAnswer ? (a) => onAnswer(activity.toolCallId, a) : undefined}
        />
      );
    }
    return <CopilotActivityCard key={activity.toolCallId} activity={activity} />;
  };

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  // CM-9: digest messages are APPENDED at the end by the backend (anchor in
  // `toolCallId`), so reorder each digest to sit immediately before its anchor
  // message and derive its covered-count caption. Tool-role rows are not part
  // of this flow ordering — they render inline via `anchorCards`/`trailingCards`
  // (TF-5).
  const visibleMessages = orderMessagesWithDigests(messages);
  const hasPendingText = pendingText.trim().length > 0;
  const hasPendingUserContent = pendingUserContent.trim().length > 0;

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    pinnedRef.current = nearBottom;
    setShowJumpToBottom(!nearBottom);
  };

  const contentCount =
    visibleMessages.length +
    (hasPendingUserContent ? 1 : 0) +
    feed.length;

  useLayoutEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [contentCount, pendingText, feed.length]);

  const isEmpty =
    visibleMessages.length === 0 &&
    !hasPendingUserContent &&
    !hasPendingText &&
    !pendingReasoning &&
    feed.length === 0;

  if (isEmpty) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          icon={<Icons.Sparkles className="h-6 w-6 text-t3" />}
          title={t("experience_copilot_title")}
          sub={t("experience_copilot_subtitle")}
        />
      </div>
    );
  }

  return (
    <div data-testid="copilot-message-list" className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-3">
        <div className="flex flex-col gap-3">
          {visibleMessages.map((entry) => (
            <Fragment key={entry.message.id}>
              {anchorCards.get(entry.message.id)?.map((activity) => renderActivity(activity))}
              <ExperienceCopilotMessageBlock
                message={entry.message}
                coveredCount={entry.coveredCount}
              />
            </Fragment>
          ))}

          {trailingCards.map((activity) => renderActivity(activity))}

          {hasPendingUserContent && (
            <ExperienceCopilotMessageBlock
              message={{
                id: "__pending-user",
                threadId,
                role: "user",
                content: pendingUserContent,
                toolCallsJson: null,
                toolCallId: null,
                createdAt: "",
              }}
            />
          )}

          {pendingReasoning && (
            <div className="flex gap-2.5" data-role="assistant" data-testid="copilot-pending-reasoning-row">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-s3">
                <Icons.Sparkles className="h-4 w-4 text-accent-t" />
              </div>
              <div className="min-w-0 max-w-[80%]">
                <MessageReasoning reasoning={pendingReasoning} reasoningDurationMs={null} variant="minimal" />
              </div>
            </div>
          )}

          {feed.map((entry) => {
            if (entry.kind === "activity") {
              const activity = activityById.get(entry.id);
              return activity ? renderActivity(activity) : null;
            }
            // Post-settle: the controller clears `pendingText`, so feed text is
            // suppressed while the refetched history owns the persisted rows;
            // the open text segment renders as the pending bubble below.
            if (!hasPendingText) return null;
            return (
              <ExperienceCopilotMessageBlock
                key={entry.id}
                message={{
                  id: entry.id,
                  threadId,
                  role: "assistant",
                  content: entry.text,
                  toolCallsJson: null,
                  toolCallId: null,
                  createdAt: "",
                }}
              />
            );
          })}

          {hasPendingText && feed.length === 0 && (
            <ExperienceCopilotMessageBlock
              message={{
                id: "__pending-assistant",
                threadId,
                role: "assistant",
                content: pendingText,
                toolCallsJson: null,
                toolCallId: null,
                createdAt: "",
              }}
            />
          )}
        </div>
      </div>

      {showJumpToBottom && (
        <button
          type="button"
          className="absolute bottom-4 right-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-accent text-on-accent shadow-lg transition-transform hover:scale-110 active:scale-95"
          onClick={() => {
            pinnedRef.current = true;
            scrollToBottom();
          }}
        >
          <Icons.Caret direction="d" />
        </button>
      )}
    </div>
  );
}


