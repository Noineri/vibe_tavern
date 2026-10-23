import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useShallow } from "zustand/react/shallow";
import { isRecordProposal, type AgentProposal, type AgentThreadEventWire, type ExperienceCopilotMessageWire, type RecordProposal } from "@vibe-tavern/api-contracts";
import {
  extractHistoricalTurnActivities,
  useAgentTurnStore,
  type AgentAskState,
  type AgentFeedEntry,
  type AgentPermissionState,
  type AgentToolActivity,
} from "../../../stores/agent-turn-store.js";
import { selectAgentLiveAsk } from "../../../stores/agent-live-ask.js";
import type { CopilotAnswerInput } from "../../../api/experience-copilot-api.js";
import type { AgentPendingAskAnswer, AgentPendingPermissionAnswer, AgentTurnFailure } from "./use-agent-controller.js";
import { orderMessagesWithDigests } from "../../../lib/copilot-context.js";
import { buildAgentTurnRow, type AgentTurnRowCallbacks, type AgentTurnRowResult } from "./use-agent-turn-actions.js";
import { agentThreadKey, getAgentHost, type AgentKind, type AgentMessageAction, type AgentMessageMarkup, type RecordProposalCardProps } from "../../../lib/agent-host-registry.js";
import { parseAgentToolOutput } from "../../../lib/agent-tool-output.js";
import { AgentMessageBlock } from "./AgentMessageBlock.js";
import { AgentTimelineSeparator } from "./AgentTimelineSeparator.js";
import { syntheticAgentMessage } from "./agent-synthetic-message.js";
import { AgentAskCard } from "./AgentAskCard.js";
import { AgentPermissionCard } from "./AgentPermissionCard.js";
import { AgentToolAccordion } from "./AgentToolAccordion.js";
import { AgentTurnErrorSlot } from "./AgentTurnErrorSlot.js";
import { RecordProposalFallbackCard } from "./RecordProposalFallbackCard.js";
import { MessageReasoning } from "../../chat/MessageReasoning.js";
import { Icons } from "../icons.js";
import { AgentEmptyState } from "./AgentEmptyState.js";
import { useT } from "../../../i18n/context.js";

const EMPTY: AgentToolActivity[] = [];
const EMPTY_FEED: AgentFeedEntry[] = [];
const EMPTY_EVENTS: AgentThreadEventWire[] = [];

/** One ordered render item pinned between two flow messages (TA-1, owner
 *  ruling 2026-10-12: ONE accordion per assistant turn hides ALL of that
 *  turn's tool calls). `"accordion"` is the turn's single tool group —
 *  placed at the turn's FIRST non-ask non-proposal tool activity's slot,
 *  collecting every non-ask non-proposal activity of the turn (interleaved
 *  text does not split it); `"ask"` is an `ask_user` card and `"proposal"`
 *  a record-proposal card, both kept OUTSIDE the accordion, rendered in
 *  place (TAG-9: the ask stays interactive; SC-13a: a settled turn collapses
 *  its tools into the tools accordion, which would hide the proposal's
 *  accept/reject behind a closed list). Items within one anchor list keep
 *  their chronological slot order. */
type CopilotTurnAnchorItem =
  | { kind: "accordion"; activities: AgentToolActivity[] }
  | { kind: "ask"; activity: AgentToolActivity }
  | { kind: "permission"; activity: AgentToolActivity }
  | { kind: "proposal"; activity: AgentToolActivity; proposal: RecordProposal };
const EMPTY_ITEMS: CopilotTurnAnchorItem[] = [];

/** SC-13a: narrow a tool activity to the record proposal its output carries
 *  (parsed through the shared `parseAgentToolOutput`, narrowed by the
 *  contract's `isRecordProposal`) — undefined for every other tool (asks,
 *  buffer writes, test digests). Pure. */
function recordProposalOf(activity: AgentToolActivity): RecordProposal | undefined {
  const parsed: unknown = parseAgentToolOutput(activity);
  if (parsed === undefined) return undefined;
  const candidate = parsed as AgentProposal;
  if (isRecordProposal(candidate)) return candidate;
  return undefined;
}

/** AP-4: the flat assistant feed's per-turn caption («✦ {host title}»,
 *  mockup §1) — a quiet secondary small `font-ui` line, NOT a heading, with
 *  mockup spacing above the turn's first visible text segment. Rendered by
 *  the list (the block stays caption-agnostic); the title is the host
 *  descriptor's existing title, resolved through `useT` — no new i18n key. */
function AgentHostCaption({ title }: { title: string }) {
  return (
    <div className="mb-[3px] font-ui text-[calc(var(--ui-fs)-3px)] text-t3" data-testid="copilot-host-caption">
      ✦ {title}
    </div>
  );
}

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
  isSending = false,
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

  // SC-23f: `read_message_prompt` remains its own interactive card,
  // rendered IN PLACE at its chronological slot — never inside a turn's
  // tool accordion (the ask-card precedent: TA-1 collects only non-ask
  // non-permission activities). The optimistic override resolves the card
  // immediately; the RESOLVED states read the rewritten row (granted →
  // allowed, denied → denied), never local state alone.
  const renderPermissionActivity = (activity: AgentToolActivity) => {
    const permission = activity.permission!;
    const resolved: AgentPermissionState =
      pendingPermissionAnswer && pendingPermissionAnswer.toolCallId === activity.toolCallId
        ? {
            ...permission,
            status: pendingPermissionAnswer.decision === "allow" ? "granted" : "denied",
          }
        : permission;
    return (
      <AgentPermissionCard
        key={activity.toolCallId}
        permission={resolved}
        interactive={
          resolved.status === "awaiting_permission" &&
          activity.toolCallId === lastActivityId &&
          !isSending &&
          onAnswer !== undefined
        }
        onDecision={onAnswer ? (decision) => onAnswer(activity.toolCallId, { decision }) : undefined}
      />
    );
  };

  // TAG-9: `ask_user` remains its own interactive card, rendered IN PLACE at
  // its chronological slot — never inside a turn's tool accordion (TA-1
  // collects only non-ask activities). AP-5: the interactive rule reads the
  // live-ask selector — awaiting + THE live ask + answerable (the selector
  // folds the old `lastActivityId` + `!isSending` conjuncts).
  const renderAskActivity = (activity: AgentToolActivity) => {
    const ask = activity.ask!;
    const resolved: AgentAskState =
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
          liveAsk !== null &&
          liveAsk.toolCallId === activity.toolCallId &&
          onAnswer !== undefined
        }
        onSubmit={onAnswer ? (a) => onAnswer(activity.toolCallId, a) : undefined}
      />
    );
  };

  // SC-13a: a record proposal renders through the host's per-recordType
  // renderer (`host.recordProposalRenderers[proposal.recordType]`), falling
  // back to the neutral `RecordProposalFallbackCard` for an unknown type
  // (or an unknown host) — an unrendered op never crashes the feed. The
  // thread id rides the props (the SC-13c card resolves against its thread).
  const renderProposalActivity = (activity: AgentToolActivity, proposal: RecordProposal) => {
    let Renderer: ComponentType<RecordProposalCardProps>;
    try {
      Renderer = getAgentHost(kind).recordProposalRenderers[proposal.recordType] ?? RecordProposalFallbackCard;
    } catch {
      Renderer = RecordProposalFallbackCard;
    }
    return <Renderer key={activity.toolCallId} proposal={proposal} threadId={threadId} />;
  };

  // TA-1: history renders each turn as ONE accordion (at the first tool
  // activity's slot) plus in-place ask, permission and proposal cards, in
  // the items' slot order. Only the live feed receives `isSending`:
  // historical groups stay collapsed even while a newer turn is in flight.
  const renderAnchorItems = (items: readonly CopilotTurnAnchorItem[]) =>
    items.map((item) =>
      item.kind === "accordion" ? (
        <AgentToolAccordion
          key={item.activities[0]!.toolCallId}
          activities={item.activities}
          kind={kind}
          isSending={false}
        />
      ) : item.kind === "ask" ? (
        renderAskActivity(item.activity)
      ) : item.kind === "permission" ? (
        renderPermissionActivity(item.activity)
      ) : (
        renderProposalActivity(item.activity, item.proposal)
      ),
    );

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
  const hasPendingText = pendingText.trim().length > 0;
  const hasPendingUserContent = pendingUserContent.trim().length > 0;

  // AP-4: one caption per assistant turn, above the turn's first VISIBLE text
  // segment (a turn that starts with hidden tool calls shows it above its
  // first rendered text; a turn with no visible text shows none). Turns are
  // delimited by user rows — the same boundary the TA-1 anchor pass above
  // uses. Digest rows never touch the flag (the anchor pass does not flush
  // on them either); only user rows reset it, only non-empty assistant rows
  // set it. Tool rows are absent here by construction
  // (`orderMessagesWithDigests` keeps user/assistant/digest only).
  const captionMessageIds = useMemo(() => {
    const ids = new Set<string>();
    let turnHasVisibleText = false;
    for (const entry of visibleMessages) {
      const m = entry.message;
      if (m.role === "user") {
        turnHasVisibleText = false;
        continue;
      }
      if (m.role === "assistant" && m.content.trim().length > 0 && !turnHasVisibleText) {
        ids.add(m.id);
        turnHasVisibleText = true;
      }
    }
    return ids;
  }, [visibleMessages]);

  // AP-4: the live feed and pending text continue the current turn — they
  // earn the caption only when the turn has shown no visible persisted text
  // yet (the same first-visible-segment rule). An optimistic pending user
  // row opens a fresh turn, so a reply streaming after it is trivially first.
  const liveTurnHasVisibleText = useMemo(() => {
    if (hasPendingUserContent) return false;
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      const m = visibleMessages[i]!.message;
      if (m.role === "user") return false;
      if (m.role === "assistant" && m.content.trim().length > 0) return true;
    }
    return false;
  }, [visibleMessages, hasPendingUserContent]);

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
            return (
              <Fragment key={entry.message.id}>
                {renderEventSeparators(eventAnchors.get(entry.message.id))}
                {renderAnchorItems(anchorItems.get(entry.message.id) ?? EMPTY_ITEMS)}
                {captionMessageIds.has(entry.message.id) && hostTitle !== null ? (
                  <div className="flex min-w-0 flex-col">
                    <AgentHostCaption title={hostTitle} />
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

          {renderAnchorItems(trailingItems)}

          {renderEventSeparators(trailingEvents)}

          {hasPendingUserContent && (
            <AgentMessageBlock
              messageMarkup={messageMarkup}
              message={syntheticAgentMessage({
                id: "__pending-user",
                threadId,
                role: "user",
                content: pendingUserContent,
              })}
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
            // AP-4: the feed is the current turn — its first VISIBLE text
            // segment carries the turn caption when the turn has shown no
            // persisted text yet (the same list rule as the persisted pass).
            let liveCaptionTitle: string | null = liveTurnHasVisibleText ? null : hostTitle;
            for (const entry of feed) {
              if (entry.kind === "activity") {
                const activity = activityById.get(entry.id);
                if (!activity) continue;
                if (activity.ask) {
                  rendered.push(renderAskActivity(activity));
                  continue;
                }
                // SC-23f: a live permission request renders in place
                // outside the turn's single accordion (the ask-card
                // precedent).
                if (activity.permission) {
                  rendered.push(renderPermissionActivity(activity));
                  continue;
                }
                // SC-13a: a live record proposal renders in place outside
                // the turn's single accordion (the ask-card precedent).
                const liveProposal = recordProposalOf(activity);
                if (liveProposal !== undefined) {
                  rendered.push(renderProposalActivity(activity, liveProposal));
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
              if (!hasPendingText) continue;
              const showLiveCaption = liveCaptionTitle !== null && entry.text.trim().length > 0;
              const liveTitle = liveCaptionTitle;
              if (showLiveCaption) liveCaptionTitle = null;
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
              if (showLiveCaption && liveTitle !== null) {
                rendered.push(
                  <div key={entry.id} className="flex min-w-0 flex-col">
                    <AgentHostCaption title={liveTitle} />
                    {segment}
                  </div>,
                );
              } else {
                rendered.push(<Fragment key={entry.id}>{segment}</Fragment>);
              }
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
            // AP-4: the pending reply is its turn's first visible text when
            // the turn has shown no persisted text yet (same list rule) — it
            // earns the caption; otherwise it streams bare under the
            // captioned turn.
            if (!liveTurnHasVisibleText && hostTitle !== null) {
              return (
                <div className="flex min-w-0 flex-col">
                  <AgentHostCaption title={hostTitle} />
                  {pendingBlock}
                </div>
              );
            }
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


