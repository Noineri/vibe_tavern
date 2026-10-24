import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { type AgentThreadEventWire, type ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import type { Attachment } from "@vibe-tavern/domain";
import {
  extractHistoricalTurnActivities,
  useAgentTurnStore,
  type AgentFeedEntry,
  type AgentToolActivity,
} from "../../../stores/agent-turn-store.js";
import { selectAgentLiveAsk } from "../../../stores/agent-live-ask.js";
import type { CopilotAnswerInput } from "../../../api/experience-copilot-api.js";
import type { AgentPendingAskAnswer, AgentPendingPermissionAnswer, AgentTurnFailure } from "./use-agent-controller.js";
import { orderMessagesWithDigests } from "../../../lib/copilot-context.js";
import { buildAgentTurnRow, type AgentTurnRowCallbacks, type AgentTurnRowResult } from "./use-agent-turn-actions.js";
import { agentThreadKey, getAgentHost, type AgentKind, type AgentMessageAction, type AgentMessageMarkup } from "../../../lib/agent-host-registry.js";
import { AgentMessageBlock } from "./AgentMessageBlock.js";
import { AgentTimelineSeparator } from "./AgentTimelineSeparator.js";
import { syntheticAgentMessage, PENDING_USER_MESSAGE_ID } from "./agent-synthetic-message.js";
import {
  AgentAnchorItems,
  recordProposalOf,
  renderAskActivity,
  renderPermissionActivity,
  renderProposalActivity,
  type AgentAnchorContext,
  type CopilotTurnAnchorItem,
} from "./agent-anchor-items.js";
import { AgentToolAccordion } from "./AgentToolAccordion.js";
import { AgentTurnErrorSlot } from "./AgentTurnErrorSlot.js";
import { AgentHostCaption } from "./AgentHostCaption.js";
import { buildTurnCaptions, withLiveReasoning } from "./agent-turn-captions.js";
import { MessageReasoning } from "../../chat/MessageReasoning.js";
import { Icons } from "../icons.js";
import { AgentEmptyState } from "./AgentEmptyState.js";
import { useT } from "../../../i18n/context.js";

const EMPTY: AgentToolActivity[] = [];
const EMPTY_FEED: AgentFeedEntry[] = [];
const EMPTY_EVENTS: AgentThreadEventWire[] = [];

const EMPTY_ITEMS: CopilotTurnAnchorItem[] = [];

// AP-29 follow-up 3: the stable empty hide set (no id hide — failure /
// cancel / thread switch / landed refetch all converge here).
const EMPTY_HIDDEN_IDS: ReadonlySet<string> = new Set();

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
  /** Live model reasoning for the pending turn — rendered with the
   *  co-author's MessageReasoning `inline` preset on the live caption line
   *  (AP-29 — the same preset, same place as the persisted toggle). Live-only
   *  state: cleared on settle, when the reloaded turn carries the persisted
   *  pair (the handover shows no gap and no duplicate — the clear precedes
   *  the async refetch, so production never renders both at once). */
  pendingReasoning: string;
  /** The user's just-sent message, shown optimistically while the model
   *  generates (the persisted user row only lands after the turn settles). */
  pendingUserContent: string;
  /** CA-4e3: the optimistic row's attachments — the bubble shows when the
   *  row has text OR attachments, and the chips render from this list. */
  pendingUserAttachments?: readonly Attachment[];
  /** TAG-9: disables ask-card interactivity while a stream runs. */
  isSending?: boolean;
  /** AP-29 follow-up 2: a regenerate is in flight — the replaced turn
   *  (every assistant row after the last user row, with its tool accordion,
   *  its ask / permission / proposal cards, and its caption) hides until
   *  the settle refetch lands the stored truth. The last user row, the
   *  digest card, and everything before the replaced turn stay visible;
   *  the live part streams as a FRESH turn (its own hoisted caption with
   *  only the live reasoning, never joined to the replaced turn). Omitted
   *  / false = the fb55c477a behavior (a continuation still joins). */
  isRegenerating?: boolean;
  /** AP-29 follow-up 3: the replaced rows' ids recorded at regenerate start
   *  (the controller's `hiddenRegeneratedIds` — every assistant row after
   *  the last user row then). Hides EXACTLY these ids past the settle until
   *  the refetch lands without them, so the replaced turn never reappears
   *  for one frame; the flag above still covers the flight itself. Intersected
   *  with the current messages every render (a landed refetch carries none
   *  of them, so the new turn shows on that same render — never a blank).
   *  Omitted / null = no id hide (failure / cancel / thread switch drop it). */
  hiddenRegeneratedIds?: readonly string[] | null;
  /** TAG-9: answer handler for the live awaiting ask card — bound by the
   *  shell with the current draft buffers (mirrors the input area's onSend).
   *  SC-23f: also carries the permission card's decision (just another
   *  answer-union member on the same path). */
  onAnswer?: (toolCallId: string, answer: CopilotAnswerInput) => void;
  /** TAG-9: the controller's optimistic resolution of the just-answered ask —
   *  flips the card immediately, before the settle+refetch round-trip. */
  pendingAskAnswer?: AgentPendingAskAnswer | null;
  /** SC-23f: the controller's optimistic resolution of the just-decided
   *  permission card — flips the card immediately, before the
   *  settle+refetch round-trip. */
  pendingPermissionAnswer?: AgentPendingPermissionAnswer | null;
  /** AS-8c3a: already-translated empty-state title override — the shell
   *  resolves the host's `emptyTitle` key through `useT` and passes the
   *  string down, so this list never imports the host registry itself. */
  emptyTitle?: string;
  /** AS-8c3a: already-translated empty-state subtitle override — omitted
   *  (undefined) falls back to the shared `agent_subtitle` line, exactly
   *  as before, so existing hosts render byte-identically without it. */
  emptySub?: string;
  /** SC-19b: the thread's frozen context events in merged-timeline order —
   *  each renders as a one-line separator right BEFORE its anchor message
   *  (`beforeMessageId`); a null anchor (or an anchor naming no visible
   *  message) renders at the end, after the persisted rows. Omitted/empty =
   *  no separators — hosts without `transport.listEvents` render exactly as
   *  today. */
  events?: AgentThreadEventWire[];
  /** AP-11: the pane-wired turn callbacks (copy / regenerate / staged
   *  delete). Absent = no turn rows (the block renders exactly as before —
   *  the SC-16 host row is untouched). Present = each persisted bubble
   *  derives its row from `buildAgentTurnRow` (role / last-turn /
   *  streaming / digest-cover). */
  turnRow?: AgentTurnRowCallbacks;
  /** AP-12: submit an inline edit (the controller's `handleEditLast`).
   *  Threaded to every block; only the last user row renders the opener
   *  (the row's `canEditLast` gate). Absent = no edit affordance anywhere. */
  onEditLast?: (content: string) => void;
  /** AP-13: the thread's live turn failure (controller state, keyed per
   *  thread) — renders the loud error card at the feed end. Null/absent =
   *  no live failure (the quiet after-reload card below may still render). */
  turnFailure?: AgentTurnFailure | null;
  /** AP-13: retry the failed turn (the pane wires the controller's
   *  `handleRegenerate`). Absent = no error card renders at all (the
   *  card's retry needs a target). */
  onRetryTurn?: () => void;
  /** AP-18: starter click → the pane prefills the composer (never sent); absent = no starters. */
  onStarterPick?: (text: string) => void;
}

export function AgentMessageList({
  kind,
  threadId,
  messages,
  pendingText,
  pendingReasoning,
  pendingUserContent,
  pendingUserAttachments = [],
  isSending = false,
  isRegenerating = false,
  hiddenRegeneratedIds = null,
  onAnswer,
  pendingAskAnswer = null,
  pendingPermissionAnswer = null,
  turnRow,
  onEditLast,
  turnFailure = null,
  onRetryTurn,
  onStarterPick,
  emptyTitle,
  emptySub,
  events = EMPTY_EVENTS,
}: AgentMessageListProps) {
  const { t } = useT();
  const activities = useAgentTurnStore(
    useShallow((s) => s.turnsByThread[agentThreadKey(kind, threadId)] ?? EMPTY),
  );
  const feed = useAgentTurnStore(
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
    const map = new Map<string, AgentToolActivity>();
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
    let turnTools: AgentToolActivity[] | null = null;
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
        // SC-23f: a permission request renders in place outside the
        // accordion (the ask-card precedent) — it never joins the turn's
        // tool group, so a settled turn cannot hide it behind a closed list.
        if (activity.permission) {
          pending.push({ kind: "permission", activity });
          continue;
        }
        // SC-13a: a record proposal renders in place outside the accordion
        // (the ask-card precedent) — it never joins the turn's tool group,
        // so a settled turn cannot hide it behind a closed list.
        const proposal = recordProposalOf(activity);
        if (proposal !== undefined) {
          pending.push({ kind: "proposal", activity, proposal });
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

  // TA-1: the live feed IS the current turn — every non-ask non-permission
  // activity it references collapses into that turn's single accordion
  // (rendered at the first tool activity's slot in the feed loop below).
  const liveToolActivities = useMemo(() => {
    const out: AgentToolActivity[] = [];
    for (const entry of feed) {
      if (entry.kind !== "activity") continue;
      const activity = activityById.get(entry.id);
      // SC-13a: asks and record proposals render in place (never inside).
      // SC-23f: permission cards render in place too (the ask precedent).
      if (activity && !activity.ask && !activity.permission && recordProposalOf(activity) === undefined) out.push(activity);
    }
    return out;
  }, [feed, activityById]);

  // TAG-9 / SC-23f: the chronologically LAST activity of the thread (live
  // feed first — it is the current turn; then the last history activity,
  // tracked in the anchor pass above in raw `messages` order). AP-5: this
  // feeds the PERMISSION card's own inline rule; the ask card's interactive
  // rule reads the live-ask selector below (the ONE derivation of "is this
  // ask answerable", which encodes the same last-activity order).
  const lastActivityId = useMemo(() => {
    for (let i = feed.length - 1; i >= 0; i--) {
      const entry = feed[i];
      if (entry && entry.kind === "activity") return entry.id;
    }
    return lastHistoryActivityId;
  }, [feed, lastHistoryActivityId]);

  // AP-5: the thread's live awaiting ask — the ONE derivation in
  // stores/agent-live-ask.ts (last activity + awaiting + no stream + after
  // the optimistic override, ask_user family only). The ask card's
  // interactive rule below and the chat pane's composer routing read this
  // SAME selector, so the answerable card and the answering send can never
  // disagree.
  const liveAsk = useMemo(
    () => selectAgentLiveAsk({ feed, activities, messages, pendingAskAnswer, isSending }),
    [feed, activities, messages, pendingAskAnswer, isSending],
  );

  // TA-1/TAG-9/SC-13a/SC-23f: the in-place card cluster (accordion +
  // ask / permission / proposal cards) lives in `agent-anchor-items.tsx`
  // (extracted under the file-size ratchet); history, trailing, and live
  // call sites share it through one explicit context.
  const anchorCtx: AgentAnchorContext = {
    kind,
    threadId,
    liveAsk,
    lastActivityId,
    isSending,
    onAnswer,
    pendingAskAnswer,
    pendingPermissionAnswer,
  };

  // SC-16: the host's message actions for persisted assistant bubbles —
  // resolved once per kind (unknown kind = no row, never a throw). Pending
  // and feed bubbles below render without actions (the RP row hides its
  // actions while generating).
  const messageActions = useMemo<AgentMessageAction[] | undefined>(() => {
    try {
      const declared = getAgentHost(kind).messageActions;
      return declared !== undefined && declared.length > 0 ? declared : undefined;
    } catch {
      return undefined;
    }
  }, [kind]);

  // AP-2: the host's message markup for every bubble the list renders —
  // resolved once per kind, like the actions above (unknown kind = neutral
  // plain, never a throw — the block prop is required, so unlike actions
  // there is no undefined arm).
  const messageMarkup = useMemo<AgentMessageMarkup>(() => {
    try {
      return getAgentHost(kind).messageMarkup;
    } catch {
      return "plain";
    }
  }, [kind]);

  // AP-4: the host's title for the flat assistant caption («✦ {host title}»,
  // mockup §1) — resolved like the actions above (unknown kind = no caption,
  // never a throw; no new i18n key — the descriptor's existing title).
  const hostTitle = useMemo<string | null>(() => {
    try {
      return t(getAgentHost(kind).i18n.title);
    } catch {
      return null;
    }
  }, [kind, t]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  // CM-9: digest messages are APPENDED at the end by the backend (anchor in
  // `toolCallId`), so reorder each digest to sit immediately before its anchor
  // message and derive its covered-count caption. Tool-role rows are not part
  // of this flow ordering — they render inline via `anchorItems`/`trailingItems`
  // (TF-5).
  const visibleMessages = orderMessagesWithDigests(messages);
  // AP-11: the visible-flow boundaries the turn rows derive from — the last
  // user row's slot (regenerate = past it; -1 when the thread has no user
  // row, i.e. the whole feed is one turn) and the last digest card's slot
  // (delete hides at/before it; null = no digest). Indexes run over
  // `visibleMessages` (digest-ordered), the same order the rows render in.
  const { lastUserVisibleIndex, lastDigestVisibleIndex } = useMemo(() => {
    let userIdx = -1;
    let digestIdx: number | null = null;
    visibleMessages.forEach((entry, index) => {
      if (entry.message.role === "user") userIdx = index;
      else if (entry.message.role === "digest") digestIdx = index;
    });
    return { lastUserVisibleIndex: userIdx, lastDigestVisibleIndex: digestIdx };
  }, [visibleMessages]);
  // AP-29 follow-up 2: the replaced turn's cut — every ASSISTANT row after
  // the last user row (the exact span the server's regenerate mode deletes:
  // the last user row stays as the rerun's input, digest rows are the floor
  // and stay, user rows are never hidden). With no user row the whole feed
  // is one turn, so every assistant row hides. Tool-role rows never sit in
  // this flow (they render through the anchor maps below); the trailing
  // tool group and the trailing caption belong to the last turn, so the
  // render below hides them with the same flag.
  // AP-29 follow-up 3: the recorded id set hides EXACTLY its rows past the
  // settle (the flag above drops there) — intersected with the CURRENT
  // visible rows, so a landed refetch (which carries none of them) shows
  // the new turn on that same render; anchored accordion/cards/captions
  // ride their anchor's fragment, the trailing group rides `hideActive`.
  const activeHiddenIds = useMemo(() => {
    if (hiddenRegeneratedIds === null || hiddenRegeneratedIds.length === 0) return EMPTY_HIDDEN_IDS;
    const visibleIds = new Set(visibleMessages.map((entry) => entry.message.id));
    const active = new Set<string>();
    for (const id of hiddenRegeneratedIds) if (visibleIds.has(id)) active.add(id);
    return active;
  }, [visibleMessages, hiddenRegeneratedIds]);
  const hideActive = isRegenerating || activeHiddenIds.size > 0;
  const isHiddenReplacedRow = (role: string, visibleIndex: number, messageId: string): boolean =>
    (isRegenerating && role === "assistant" && visibleIndex > lastUserVisibleIndex) ||
    activeHiddenIds.has(messageId);
  const hasPendingText = pendingText.trim().length > 0;
  // CA-4e3: the optimistic user row shows when it has text OR attachments.
  const hasPendingUserContent = pendingUserContent.trim().length > 0 || pendingUserAttachments.length > 0;
  // AP-29: live reasoning streams as text-only (no duration lands until the
  // turn persists) — the duration slot stays null like the minimal row did.
  const hasLiveReasoning = pendingReasoning.trim().length > 0;

  // AP-4 (AP-29 follow-up): one caption per assistant turn, at the TOP of
  // the turn — above its tool accordion, an ask / permission / proposal
  // card, or its first text, whichever comes first (extracted under the
  // file-size ratchet; see `agent-turn-captions.ts`). The live turn uses
  // the same rule, so nothing moves when it lands.
  const turnCaptions = useMemo(() => {
    const anchoredIds = new Set<string>();
    for (const [id, items] of anchorItems) if (items.length > 0) anchoredIds.add(id);
    return buildTurnCaptions({
      visibleMessages,
      anchoredIds,
      hasTrailingAnchors: trailingItems.length > 0,
    });
  }, [visibleMessages, anchorItems, trailingItems]);

  // AP-4: the live feed and pending text continue the current turn — they
  // earn the caption only when the turn has shown no visible persisted text
  // yet (the same first-visible-segment rule). An optimistic pending user
  // row opens a fresh turn, so a reply streaming after it is trivially first.
  // AP-29 follow-up 2: a regenerate hides the replaced turn (see
  // `isHiddenReplacedRow`), so the scan skips it — the new turn streams as
  // a fresh turn with its own hoisted caption below.
  const liveTurnHasVisibleText = useMemo(() => {
    if (hasPendingUserContent) return false;
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      const m = visibleMessages[i]!.message;
      if (isHiddenReplacedRow(m.role, i, m.id)) continue;
      if (m.role === "user") return false;
      if (m.role === "assistant" && m.content.trim().length > 0) return true;
    }
    return false;
  }, [visibleMessages, hasPendingUserContent, isRegenerating, lastUserVisibleIndex, activeHiddenIds]);

  // AP-29 follow-up: the live part continues the last persisted turn (no
  // optimistic user row opens a fresh one) — when that turn already earns
  // a caption, the live stream joins it instead of hoisting a second one:
  // reasoning folds into the caption's block, text and tools render bare.
  // Fresh turns (empty thread / optimistic user row) keep the hoisted live
  // caption below. Unknown kinds keep the fallback pending row (no title).
  // AP-29 follow-up 2: a regenerate NEVER joins — the replaced turn hides
  // (see `isHiddenReplacedRow`), so the new turn streams as a fresh turn
  // with its own caption carrying only the live reasoning.
  // AP-29 follow-up 3: a still-hidden post-settle turn never joins either
  // (the flag dropped but the set holds) — joining a hidden caption would
  // swallow the live reasoning, so the fresh caption below owns it instead.
  const liveContinuesLastTurn = !hasPendingUserContent && visibleMessages.length > 0;
  const liveJoinsLastTurn =
    !isRegenerating && activeHiddenIds.size === 0 && hostTitle !== null && liveContinuesLastTurn && turnCaptions.lastTurnEarnsCaption;
  const { captionBefore, trailingCaption } = useMemo(() => {
    if (!liveJoinsLastTurn || !hasLiveReasoning || turnCaptions.lastTurnSlotId === null) {
      return { captionBefore: turnCaptions.captionBefore, trailingCaption: turnCaptions.trailingCaption };
    }
    if (turnCaptions.lastTurnSlotId === "trailing") {
      return {
        captionBefore: turnCaptions.captionBefore,
        trailingCaption: withLiveReasoning(
          turnCaptions.trailingCaption ?? undefined,
          pendingReasoning,
        ),
      };
    }
    const next = new Map(turnCaptions.captionBefore);
    next.set(
      turnCaptions.lastTurnSlotId,
      withLiveReasoning(next.get(turnCaptions.lastTurnSlotId), pendingReasoning),
    );
    return { captionBefore: next, trailingCaption: turnCaptions.trailingCaption };
  }, [liveJoinsLastTurn, hasLiveReasoning, turnCaptions, pendingReasoning]);

  // SC-19b: frozen events interleave as separators BEFORE their anchor
  // message; a null anchor — or an anchor naming no visible row — trails at
  // the end, after the persisted rows (before the live pending rows, which
  // only exist mid-turn and are cleared on the settle+refetch that refreshes
  // these events).
  const { eventAnchors, trailingEvents } = useMemo(() => {
    const anchors = new Map<string, AgentThreadEventWire[]>();
    const trailing: AgentThreadEventWire[] = [];
    if (events.length === 0) return { eventAnchors: anchors, trailingEvents: trailing };
    const visibleIds = new Set(visibleMessages.map((entry) => entry.message.id));
    for (const event of events) {
      const anchor = event.beforeMessageId;
      if (anchor !== null && visibleIds.has(anchor)) {
        const list = anchors.get(anchor);
        if (list) list.push(event);
        else anchors.set(anchor, [event]);
      } else {
        trailing.push(event);
      }
    }
    return { eventAnchors: anchors, trailingEvents: trailing };
  }, [events, visibleMessages]);

  const renderEventSeparators = (list: readonly AgentThreadEventWire[] | undefined) =>
    list?.map((event) => <AgentTimelineSeparator key={event.id} event={event} />);

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
    events.length +
    (hasPendingUserContent ? 1 : 0) +
    feed.length;

  useLayoutEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [contentCount, pendingText, feed.length]);

  const isEmpty =
    visibleMessages.length === 0 &&
    events.length === 0 &&
    !hasPendingUserContent &&
    !hasPendingText &&
    !pendingReasoning &&
    feed.length === 0;

  if (isEmpty) {
    return (
      <AgentEmptyState kind={kind} title={emptyTitle ?? t("agent_title")} sub={emptySub ?? t("agent_subtitle")} onStarterPick={onStarterPick} />
    );
  }

  return (
    <div data-testid="copilot-message-list" className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-3">
        <div className="flex flex-col gap-3">
          {visibleMessages.map((entry, visibleIndex) => {
            // AP-29 follow-up 2: the replaced turn hides whole — its
            // bubbles, its anchored accordion/cards, its caption, and its
            // event separators all render inside this fragment, so the one
            // cut covers them (the last user row, digests, and earlier
            // turns never match `isHiddenReplacedRow`).
            // AP-29 follow-up 3: the id cut covers the same fragment past
            // the settle (the flag dropped, the set holds).
            if (isHiddenReplacedRow(entry.message.role, visibleIndex, entry.message.id)) return null;
            // AP-11: one bubble's row — the turn callbacks merged with the
            // list's own boundaries (last turn, digest cover, streaming).
            // Without callbacks the block gets exactly what it got before
            // (the SC-16 host row, byte-identical).
            const row: AgentTurnRowResult = turnRow !== undefined
              ? buildAgentTurnRow({
                message: entry.message,
                visibleIndex,
                lastUserVisibleIndex,
                lastDigestVisibleIndex,
                isSending,
                hostActions: messageActions,
                callbacks: turnRow,
              })
              : { hostActions: messageActions, turnActions: undefined };
            // The caption sits above the turn's FIRST rendered item at this
            // slot: standalone above the anchored accordion/cards, or tight
            // above its text (the AP-4 look) when the slot carries none.
            const anchors = anchorItems.get(entry.message.id) ?? EMPTY_ITEMS;
            const caption = hostTitle !== null ? captionBefore.get(entry.message.id) : undefined;
            return (
              <Fragment key={entry.message.id}>
                {renderEventSeparators(eventAnchors.get(entry.message.id))}
                {caption !== undefined && anchors.length > 0 ? (
                  <AgentHostCaption
                    title={hostTitle!}
                    reasoning={caption.reasoning}
                    reasoningDurationMs={caption.reasoningDurationMs}
                  />
                ) : null}
                {<AgentAnchorItems items={anchors} ctx={anchorCtx} />}
                {caption !== undefined && anchors.length === 0 ? (
                  <div className="flex min-w-0 flex-col">
                    <AgentHostCaption
                      title={hostTitle!}
                      reasoning={caption.reasoning}
                      reasoningDurationMs={caption.reasoningDurationMs}
                    />
                    <AgentMessageBlock
                      message={entry.message}
                      messageMarkup={messageMarkup}
                      coveredCount={entry.coveredCount}
                      messageActions={row.hostActions}
                      turnActions={row.turnActions}
                      canEditLast={row.canEditLast === true}
                      onEditLast={onEditLast}
                      isBusy={isSending}
                    />
                  </div>
                ) : (
                  <AgentMessageBlock
                    message={entry.message}
                    messageMarkup={messageMarkup}
                    coveredCount={entry.coveredCount}
                    messageActions={row.hostActions}
                    turnActions={row.turnActions}
                    canEditLast={row.canEditLast === true}
                    onEditLast={onEditLast}
                    isBusy={isSending}
                  />
                )}
              </Fragment>
            );
          })}

          {/* AP-29 follow-up 2: the trailing tool group belongs to the last
              turn — it hides with the replaced turn (see
              `isHiddenReplacedRow`); the live feed below carries the new
              turn's tools.
              AP-29 follow-up 3: the id set hides it past the settle too
              (`hideActive`); the intersection inside `activeHiddenIds` empties
              on the landed refetch, so the new turn's group shows on that
              same render. */}
          {!hideActive && trailingCaption !== null && hostTitle !== null ? (
            <AgentHostCaption
              title={hostTitle}
              reasoning={trailingCaption.reasoning}
              reasoningDurationMs={trailingCaption.reasoningDurationMs}
            />
          ) : null}
          {!hideActive && <AgentAnchorItems items={trailingItems} ctx={anchorCtx} />}

          {renderEventSeparators(trailingEvents)}

          {hasPendingUserContent && (
            <AgentMessageBlock
              messageMarkup={messageMarkup}
              message={syntheticAgentMessage({
                id: PENDING_USER_MESSAGE_ID,
                threadId,
                role: "user",
                content: pendingUserContent,
                ...(pendingUserAttachments.length > 0 ? { attachments: pendingUserAttachments } : {}),
              })}
            />
          )}

          {/* AP-29: the live turn's caption — the inline reasoning toggle on
              the caption line (the same preset, same place as the persisted
              one, so the settle handover swaps data, not chrome). Hoisted
              above ALL live content: one site, never duplicated. A live
              continuation of a captioned turn joins that caption's block
              instead (no second caption — see `liveJoinsLastTurn` above).
              Unknown kinds keep the fallback pending row (no title). */}
          {!liveTurnHasVisibleText &&
            hostTitle !== null &&
            (hasPendingText || hasLiveReasoning) &&
            !liveJoinsLastTurn && (
              <AgentHostCaption title={hostTitle} reasoning={hasLiveReasoning ? pendingReasoning : null} />
            )}
          {/* AP-29 follow-up 2: the fallback live row (no host title) is
              the bare reasoning toggle — no avatar anywhere in the feed
              (AP-4). */}
          {hasLiveReasoning && hostTitle === null && (
            <div className="flex flex-wrap items-center gap-2.5" data-role="assistant" data-testid="copilot-pending-reasoning-row">
              <MessageReasoning reasoning={pendingReasoning} reasoningDurationMs={null} variant="inline" />
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
                  rendered.push(renderAskActivity(activity, anchorCtx));
                  continue;
                }
                // SC-23f: a live permission request renders in place
                // outside the turn's single accordion (the ask-card
                // precedent).
                if (activity.permission) {
                  rendered.push(renderPermissionActivity(activity, anchorCtx));
                  continue;
                }
                // SC-13a: a live record proposal renders in place outside
                // the turn's single accordion (the ask-card precedent).
                const liveProposal = recordProposalOf(activity);
                if (liveProposal !== undefined) {
                  rendered.push(renderProposalActivity(activity, liveProposal, anchorCtx));
                  continue;
                }
                // TA-1: the turn's FIRST non-ask non-permission tool
                // activity renders the turn's single accordion (ALL such
                // activities of the feed — one turn); interleaved text does
                // not split it and later tool activities are already inside.
                if (!accordionPlaced) {
                  accordionPlaced = true;
                  rendered.push(
                    <AgentToolAccordion
                      key={activity.toolCallId}
                      activities={liveToolActivities}
                      kind={kind}
                      isSending
                    />,
                  );
                }
                continue;
              }
              // Post-settle: the controller clears `pendingText`, so feed text
              // is suppressed while refetched history owns the persisted rows.
              // AP-29: live text never carries its own caption — the hoisted
              // live caption above (fresh turn) or the joined turn caption
              // (continuation) owns it (one site, never duplicated).
              if (!hasPendingText) continue;
              const segment = (
                <AgentMessageBlock
                  messageMarkup={messageMarkup}
                  message={syntheticAgentMessage({
                    id: entry.id,
                    threadId,
                    role: "assistant",
                    content: entry.text,
                  })}
                />
              );
              rendered.push(<Fragment key={entry.id}>{segment}</Fragment>);
            }
            return rendered;
          })()}

          {hasPendingText && feed.length === 0 && (() => {
            const pendingBlock = (
              <AgentMessageBlock
                messageMarkup={messageMarkup}
                message={syntheticAgentMessage({
                  id: "__pending-assistant",
                  threadId,
                  role: "assistant",
                  content: pendingText,
                })}
              />
            );
            // AP-29: the pending reply always streams bare — the hoisted
            // live caption above (fresh turn) or the joined turn caption
            // (continuation) owns the caption (one site).
            return pendingBlock;
          })()}

          {/* AP-13: the turn-failure card at the feed end — the slot owns
              the loud/quiet decision (extracted under the file-size
              ratchet; see AgentTurnErrorSlot). */}
          <AgentTurnErrorSlot
            turnFailure={turnFailure}
            visibleMessages={visibleMessages}
            isSending={isSending}
            onRetryTurn={onRetryTurn}
          />
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


