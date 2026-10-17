import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import {
  extractHistoricalTurnActivities,
  useExperienceCopilotTurnStore,
  type CopilotAskState,
  type CopilotFeedEntry,
  type ExperienceCopilotToolActivity,
} from "../../../stores/experience-copilot-turn-store.js";
import type { CopilotAskAnswerInput } from "../../../api/experience-copilot-api.js";
import type { AgentPendingAskAnswer } from "./use-agent-controller.js";
import { orderMessagesWithDigests } from "../../../lib/copilot-context.js";
import { agentThreadKey, type AgentKind } from "../../../lib/agent-host-registry.js";
import { AgentMessageBlock } from "./AgentMessageBlock.js";
import { AgentAskCard } from "./AgentAskCard.js";
import { AgentToolAccordion } from "./AgentToolAccordion.js";
import { MessageReasoning } from "../../chat/MessageReasoning.js";
import { Icons } from "../icons.js";
import { EmptyState } from "../empty-state.js";
import { useT } from "../../../i18n/context.js";

const EMPTY: ExperienceCopilotToolActivity[] = [];
const EMPTY_FEED: CopilotFeedEntry[] = [];

/** One ordered render item pinned between two flow messages (TA-1, owner
 *  ruling 2026-10-12: ONE accordion per assistant turn hides ALL of that
 *  turn's tool calls). `"accordion"` is the turn's single tool group —
 *  placed at the turn's FIRST non-ask tool activity's slot, collecting every
 *  non-ask activity of the turn (interleaved text does not split it);
 *  `"ask"` is an `ask_user` card kept OUTSIDE the accordion, rendered in
 *  place (TAG-9: it stays interactive). Items within one anchor list keep
 *  their chronological slot order. */
type CopilotTurnAnchorItem =
  | { kind: "accordion"; activities: ExperienceCopilotToolActivity[] }
  | { kind: "ask"; activity: ExperienceCopilotToolActivity };
const EMPTY_ITEMS: CopilotTurnAnchorItem[] = [];

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
export interface AgentMessageListProps {
  /** The host kind driving the shell — store keys go through
   *  `agentThreadKey(kind, threadId)` (AS-6c-ii). */
  kind: AgentKind;
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
  pendingAskAnswer?: AgentPendingAskAnswer | null;
  /** AS-8c3a: already-translated empty-state title override — the shell
   *  resolves the host's `emptyTitle` key through `useT` and passes the
   *  string down, so this list never imports the host registry itself. */
  emptyTitle?: string;
  /** AS-8c3a: already-translated empty-state subtitle override — omitted
   *  (undefined) falls back to the shared `agent_subtitle` line, exactly
   *  as before, so existing hosts render byte-identically without it. */
  emptySub?: string;
}

export function AgentMessageList({
  kind,
  threadId,
  messages,
  pendingText,
  pendingReasoning,
  pendingUserContent,
  isSending = false,
  onAnswer,
  pendingAskAnswer = null,
  emptyTitle,
  emptySub,
}: AgentMessageListProps) {
  const { t } = useT();
  const activities = useExperienceCopilotTurnStore(
    useShallow((s) => s.turnsByThread[agentThreadKey(kind, threadId)] ?? EMPTY),
  );
  const feed = useExperienceCopilotTurnStore(
    useShallow((s) => s.feedByThread[agentThreadKey(kind, threadId)] ?? EMPTY_FEED),
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

  // TA-1 (owner ruling 2026-10-12): persisted tool rows group PER TURN, not
  // per consecutive run — a turn with interleaved text renders ONE accordion
  // holding all of the turn's tool calls. Turns are delimited by user rows
  // (the same key `extractHistoricalTurnActivities` uses, which rebuilt the
  // `historyActivities` map below). The accordion item is pinned to the turn's
  // FIRST non-ask tool activity's slot: the NEXT flow message (user/assistant,
  // carriers included — they render as null, so the position is identical).
  // Later tool rows of the same turn only grow the array the item references
  // (the pass is synchronous, so the array is complete before render reads it);
  // interleaved text never splits the group. `ask_user` rows render as their
  // own cards in place (TAG-9), never inside the accordion. Tool rows with no
  // following flow message trail at the list's end. Digest rows do NOT flush
  // the pending items (CM-9 moves them; cards keep their chronological
  // neighbors).
  const { anchorItems, trailingItems, lastHistoryActivityId } = useMemo(() => {
    const anchor = new Map<string, CopilotTurnAnchorItem[]>();
    let pending: CopilotTurnAnchorItem[] = [];
    let turnTools: ExperienceCopilotToolActivity[] | null = null;
    let lastActivityId: string | null = null;
    for (const m of messages) {
      if (m.role === "tool") {
        const activity = historyActivities.get(m.toolCallId ?? m.id);
        if (!activity || liveToolCallIds.has(activity.toolCallId)) continue;
        lastActivityId = activity.toolCallId;
        if (activity.ask) {
          pending.push({ kind: "ask", activity });
          continue;
        }
        if (!turnTools) {
          turnTools = [];
          pending.push({ kind: "accordion", activities: turnTools });
        }
        turnTools.push(activity);
        continue;
      }
      if (m.role === "user" || m.role === "assistant") {
        if (pending.length > 0) {
          anchor.set(m.id, pending);
          pending = [];
        }
        // A user row starts the next turn — the accordion state resets;
        // an assistant row is interleaved text within the SAME turn.
        if (m.role === "user") turnTools = null;
      }
    }
    return { anchorItems: anchor, trailingItems: pending, lastHistoryActivityId: lastActivityId };
  }, [messages, historyActivities, liveToolCallIds]);

  const activityById = useMemo(
    () => new Map(activities.map((a) => [a.toolCallId, a])),
    [activities],
  );

  // TA-1: the live feed IS the current turn — every non-ask activity it
  // references collapses into that turn's single accordion (rendered at the
  // first tool activity's slot in the feed loop below).
  const liveToolActivities = useMemo(() => {
    const out: ExperienceCopilotToolActivity[] = [];
    for (const entry of feed) {
      if (entry.kind !== "activity") continue;
      const activity = activityById.get(entry.id);
      if (activity && !activity.ask) out.push(activity);
    }
    return out;
  }, [feed, activityById]);

  // TAG-9: the chronologically LAST activity of the thread (live feed first —
  // it is the current turn; then the last history activity, tracked in the
  // anchor pass above in raw `messages` order). Only an awaiting `ask_user`
  // activity that IS this last one renders interactively; an awaiting ask
  // with any later activity renders as expired (the user moved on).
  const lastActivityId = useMemo(() => {
    for (let i = feed.length - 1; i >= 0; i--) {
      const entry = feed[i];
      if (entry && entry.kind === "activity") return entry.id;
    }
    return lastHistoryActivityId;
  }, [feed, lastHistoryActivityId]);

  // TAG-9: `ask_user` remains its own interactive card, rendered IN PLACE at
  // its chronological slot — never inside a turn's tool accordion (TA-1
  // collects only non-ask activities).
  const renderAskActivity = (activity: ExperienceCopilotToolActivity) => {
    const ask = activity.ask!;
    const resolved: CopilotAskState =
      pendingAskAnswer && pendingAskAnswer.toolCallId === activity.toolCallId
        ? {
            ...ask,
            status: pendingAskAnswer.status,
            ...(pendingAskAnswer.answer !== undefined ? { answer: pendingAskAnswer.answer } : {}),
          }
        : ask;
    return (
      <AgentAskCard
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
  };

  // TA-1: history renders each turn as ONE accordion (at the first tool
  // activity's slot) plus in-place ask cards, in the items' slot order. Only
  // the live feed receives `isSending`: historical groups stay collapsed even
  // while a newer turn is in flight.
  const renderAnchorItems = (items: readonly CopilotTurnAnchorItem[]) =>
    items.map((item) =>
      item.kind === "accordion" ? (
        <AgentToolAccordion
          key={item.activities[0]!.toolCallId}
          activities={item.activities}
          isSending={false}
        />
      ) : (
        renderAskActivity(item.activity)
      ),
    );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  // CM-9: digest messages are APPENDED at the end by the backend (anchor in
  // `toolCallId`), so reorder each digest to sit immediately before its anchor
  // message and derive its covered-count caption. Tool-role rows are not part
  // of this flow ordering — they render inline via `anchorItems`/`trailingItems`
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
          title={emptyTitle ?? t("agent_title")}
          sub={emptySub ?? t("agent_subtitle")}
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
              {renderAnchorItems(anchorItems.get(entry.message.id) ?? EMPTY_ITEMS)}
              <AgentMessageBlock
                message={entry.message}
                coveredCount={entry.coveredCount}
              />
            </Fragment>
          ))}

          {renderAnchorItems(trailingItems)}

          {hasPendingUserContent && (
            <AgentMessageBlock
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

          {(() => {
            const rendered = [];
            let accordionPlaced = false;
            for (const entry of feed) {
              if (entry.kind === "activity") {
                const activity = activityById.get(entry.id);
                if (!activity) continue;
                if (activity.ask) {
                  rendered.push(renderAskActivity(activity));
                  continue;
                }
                // TA-1: the turn's FIRST non-ask tool activity renders the
                // turn's single accordion (ALL non-ask activities of the
                // feed — one turn); interleaved text does not split it and
                // later tool activities are already inside.
                if (!accordionPlaced) {
                  accordionPlaced = true;
                  rendered.push(
                    <AgentToolAccordion
                      key={activity.toolCallId}
                      activities={liveToolActivities}
                      isSending
                    />,
                  );
                }
                continue;
              }
              // Post-settle: the controller clears `pendingText`, so feed text
              // is suppressed while refetched history owns the persisted rows.
              if (!hasPendingText) continue;
              rendered.push(
                <AgentMessageBlock
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
                />,
              );
            }
            return rendered;
          })()}

          {hasPendingText && feed.length === 0 && (
            <AgentMessageBlock
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


