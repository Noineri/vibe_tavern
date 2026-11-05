import { memo, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AgentFeedEventSummary, AgentThreadEventWire, ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import type { AgentFeedWindow } from "./agent-feed-reconcile.js";
import type { Attachment } from "@vibe-tavern/domain";
import { useAgentTurnStore, type AgentFeedEntry, type AgentToolActivity } from "../../../stores/agent-turn-store.js";
import { agentLiveReasoningOf, agentLiveTextOf, useAgentLiveStreamStore } from "../../../stores/agent-live-stream-store.js";
import { selectAgentLiveAsk } from "../../../stores/agent-live-ask.js";
import type { CopilotAnswerInput } from "../../../api/experience-copilot-api.js";
import type { AgentPendingAskAnswer, AgentPendingPermissionAnswer, AgentTurnFailure } from "./use-agent-controller.js";
import { buildAgentTurnRow, type AgentTurnRowCallbacks } from "./use-agent-turn-actions.js";
import { agentThreadKey, getAgentHost, type AgentI18nKey, type AgentKind } from "../../../lib/agent-host-registry.js";
import type { AgentBuiltinProfileHandoff } from "../../../lib/agent-builtin-profiles.js";
import { AgentFeedScroller } from "./agent-feed-scroller.js";
import { AgentJumpToBottom } from "./AgentJumpToBottom.js";
import { AgentMessageBlock } from "./AgentMessageBlock.js";
import { AgentTimelineSeparator } from "./AgentTimelineSeparator.js";
import { syntheticAgentMessage, PENDING_USER_MESSAGE_ID } from "./agent-synthetic-message.js";
import { AgentAnchorItems, recordProposalOf, buildAgentAnchorContext, renderAskActivity, renderPermissionActivity, renderProposalActivity } from "./agent-anchor-items.js";
import { AgentToolAccordion } from "./AgentToolAccordion.js";
import { AgentTurnErrorSlot, hasAgentTurnError } from "./AgentTurnErrorSlot.js";
import { AgentHostCaption } from "./AgentHostCaption.js";
import { withLiveReasoning, type TurnCaption } from "./agent-turn-captions.js";
import { MessageReasoning } from "../../chat/MessageReasoning.js";
import { AgentEmptyState } from "./AgentEmptyState.js";
import { useT } from "../../../i18n/context.js";
import { buildAgentFeedModel, memoizedAgentFeedModel, EMPTY_AGENT_FEED_EVENTS, EMPTY_AGENT_FEED_LIVE_TOOL_CALL_IDS } from "./agent-feed-model.js";
import { agentFeedRenderUnits, agentFeedUnitIds, agentFeedCaptionUnitId, agentFeedMessageUnitId, agentFeedEventUnitId, agentFeedAccordionUnitId, partitionAgentFeedWindow, type AgentFeedLiveRow } from "./agent-feed-window.js";
import { useOptionalAgentFeedUiStateStore, useAgentFeedDisclosure } from "./agent-feed-ui-state.js";

const EMPTY: AgentToolActivity[] = [];
const EMPTY_FEED: AgentFeedEntry[] = [];
const EMPTY_ATTACHMENTS: readonly Attachment[] = [];
const EMPTY_MESSAGES: ExperienceCopilotMessageWire[] = [];
const EMPTY_HIDDEN_IDS: ReadonlySet<string> = new Set();
const EMPTY_MODEL = buildAgentFeedModel({ messages: [], events: EMPTY_AGENT_FEED_EVENTS, liveToolCallIds: EMPTY_AGENT_FEED_LIVE_TOOL_CALL_IDS });

/** The live join subscribes in this caption, not in the historical row map.
 * All other history elements remain referentially identical during a flush. */
const HistoryCaption = memo(function HistoryCaption({ kind, threadId, title, caption, stateKey, joinLive }: {
  kind: AgentKind; threadId: string; title: string; caption: TurnCaption;
  stateKey: string; joinLive: boolean;
}) {
  const live = useAgentLiveStreamStore((s) => joinLive ? agentLiveReasoningOf(s, kind, threadId) : "");
  const value = live.trim() ? withLiveReasoning(caption, live) : caption;
  return <AgentHostCaption title={title} reasoning={value.reasoning} reasoningDurationMs={value.reasoningDurationMs} stateKey={stateKey} />;
});

/** Props-driven persisted history with the live stores as the only per-flush
 * text source (LAG-3). The core owns geometry; the model owns historical folds. */
export interface AgentMessageListProps {
  kind: AgentKind;
  threadId: string;
  /** AFP-14: readonly — the legacy path feeds the shell's full-list state,
   *  the paged path the feed hook's reconciled covered-window rows. */
  messages?: readonly ExperienceCopilotMessageWire[];
  /** AFP-15: authoritative covered intervals, never treated as full history. */
  pageWindows?: readonly AgentFeedWindow[];
  /** Optional host override; the shared separator otherwise renders summaries. */
  renderEventSummary?: (event: AgentFeedEventSummary) => ReactNode;
  pendingUserContent: string;
  pendingUserAttachments?: readonly Attachment[];
  isSending?: boolean;
  isRegenerating?: boolean;
  hiddenRegeneratedIds?: readonly string[] | null;
  onAnswer?: (toolCallId: string, answer: CopilotAnswerInput) => void;
  pendingAskAnswer?: AgentPendingAskAnswer | null;
  pendingPermissionAnswer?: AgentPendingPermissionAnswer | null;
  emptyTitle?: string;
  emptySub?: string;
  events?: readonly AgentThreadEventWire[];
  turnRow?: AgentTurnRowCallbacks;
  onEditLast?: (content: string) => void;
  onEditAssistant?: (messageId: string, content: string) => Promise<boolean>;
  turnFailure?: AgentTurnFailure | null;
  onRetryTurn?: () => void;
  onStarterPick?: (text: string) => void;
  emptyIcon?: ReactNode;
  starterKeysOverride?: readonly AgentI18nKey[];
  handoffRow?: AgentBuiltinProfileHandoff & { onActivate: () => void };
}

export function AgentMessageList({
  kind, threadId, messages: legacyMessages = EMPTY_MESSAGES, pageWindows, renderEventSummary,
  pendingUserContent, pendingUserAttachments = EMPTY_ATTACHMENTS,
  isSending = false, isRegenerating = false, hiddenRegeneratedIds = null,
  onAnswer, pendingAskAnswer = null, pendingPermissionAnswer = null,
  turnRow, onEditLast, onEditAssistant, turnFailure = null, onRetryTurn,
  onStarterPick, emptyTitle, emptySub, emptyIcon, starterKeysOverride, handoffRow,
  events: legacyEvents = EMPTY_AGENT_FEED_EVENTS,
}: AgentMessageListProps) {
  const { t } = useT();
  const messages = useMemo(() => pageWindows?.flatMap(w => w.messages) ?? legacyMessages, [pageWindows, legacyMessages]);
  const events = useMemo(() => pageWindows?.flatMap(w => w.events) ?? legacyEvents, [pageWindows, legacyEvents]);
  const sessionKey = agentThreadKey(kind, threadId);
  const activities = useAgentTurnStore(useShallow((s) => s.turnsByThread[sessionKey] ?? EMPTY));
  const feed = useAgentTurnStore(useShallow((s) => s.feedByThread[sessionKey] ?? EMPTY_FEED));
  const liveText = useAgentLiveStreamStore((s) => agentLiveTextOf(s, kind, threadId));
  const liveReasoning = useAgentLiveStreamStore((s) => agentLiveReasoningOf(s, kind, threadId));
  const liveToolCallIds = useMemo(() => new Set(activities.map((a) => a.toolCallId)), [activities]);
  const model = useMemo(() => memoizedAgentFeedModel({ messages, events: legacyEvents, liveToolCallIds, windows: pageWindows }), [messages, legacyEvents, liveToolCallIds, pageWindows]);
  const { visibleMessages, boundaries, captions } = model;
  const { lastUserVisibleIndex, lastDigestAnchorVisibleIndex } = boundaries;
  const activityById = useMemo(() => new Map(activities.map((a) => [a.toolCallId, a])), [activities]);
  const lastActivityId = useMemo(() => {
    for (let i = feed.length - 1; i >= 0; i--) {
      const entry = feed[i]!;
      if (entry.kind === "activity") return entry.id;
    }
    return model.lastHistoryActivityId;
  }, [feed, model]);
  const liveAsk = useMemo(() => model.atThreadHead ? selectAgentLiveAsk({ feed, activities,
    messages: pageWindows?.at(-1)?.messages ?? messages, pendingAskAnswer, isSending }) : null,
    [feed, activities, messages, pendingAskAnswer, isSending, model.atThreadHead, pageWindows]);
  const anchorCtx = useMemo(() => buildAgentAnchorContext({ kind, threadId, liveAsk, lastActivityId, isSending: isSending || !model.atThreadHead, onAnswer, pendingAskAnswer, pendingPermissionAnswer }),
    [kind, threadId, liveAsk, lastActivityId, isSending, onAnswer, pendingAskAnswer, pendingPermissionAnswer, model.atThreadHead]);
  const host = useMemo(() => {
    try { return getAgentHost(kind); } catch { return undefined; }
  }, [kind]);
  const messageActions = host?.messageActions?.length ? host.messageActions : undefined;
  const messageMarkup = host?.messageMarkup ?? "plain";
  const hostTitle = host ? t(host.i18n.title) : null;
  const activeHiddenIds = useMemo(() => {
    if (!hiddenRegeneratedIds?.length) return EMPTY_HIDDEN_IDS;
    const visibleIds = new Set(visibleMessages.map((entry) => entry.message.id));
    return new Set(hiddenRegeneratedIds.filter((id) => visibleIds.has(id)));
  }, [visibleMessages, hiddenRegeneratedIds]);
  const hiddenIds = useMemo(() => {
    if (!isRegenerating) return activeHiddenIds;
    const hidden = new Set(activeHiddenIds);
    visibleMessages.forEach(({ message }, index) => {
      if (message.role === "assistant" && index > lastUserVisibleIndex) hidden.add(message.id);
    });
    return hidden;
  }, [visibleMessages, activeHiddenIds, isRegenerating, lastUserVisibleIndex]);
  const hideActive = isRegenerating || activeHiddenIds.size > 0;
  const hasPendingText = liveText.trim().length > 0;
  const hasPendingUserContent = pendingUserContent.trim().length > 0 || pendingUserAttachments.length > 0;
  const hasLiveReasoning = liveReasoning.trim().length > 0;
  const liveTurnHasVisibleText = useMemo(() => {
    if (hasPendingUserContent) return false;
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      const m = visibleMessages[i]!.message;
      if (hiddenIds.has(m.id)) continue;
      if (m.role === "user") return false;
      if (m.role === "assistant" && m.content.trim()) return true;
    }
    return false;
  }, [visibleMessages, hasPendingUserContent, hiddenIds]);
  const liveJoinsLastTurn = !hideActive && hostTitle !== null && !hasPendingUserContent
    && visibleMessages.length > 0 && captions.lastTurnEarnsCaption;

  // Tight text-only captions stay IN their message's virtual unit. Otherwise
  // the old flex-column caption/message pair would acquire a new 12px gap.
  const historyUnits = useMemo(() => agentFeedRenderUnits({ model, hiddenMessageIds: hiddenIds, hideTrailingAnchors: hideActive }).filter((unit) => {
    if (unit.kind === "caption") return hostTitle !== null && (unit.slotId === "trailing" || model.anchoredIds.has(unit.slotId));
    if (unit.kind === "message") return unit.message.content.trim().length > 0 || (unit.message.attachments?.length ?? 0) > 0;
    return true;
  }), [model, hiddenIds, hideActive, hostTitle !== null]);
  const historyNodes = useMemo(() => {
    const nodes = new Map<string, ReactNode>();
    const visibleIndexes = new Map(visibleMessages.map((entry, index) => [entry.message.id, index]));
    const captionNode = (slotId: string) => {
      const caption = slotId === "trailing" ? captions.trailingCaption : captions.captionBefore.get(slotId);
      return caption && hostTitle !== null ? <HistoryCaption kind={kind} threadId={threadId} title={hostTitle}
        caption={caption} stateKey={agentFeedCaptionUnitId(pageWindows ? captions.stateKeys.get(slotId) ?? slotId : slotId)} joinLive={liveJoinsLastTurn && captions.lastTurnSlotId === slotId} /> : null;
    };
    for (const unit of historyUnits) {
      let node: ReactNode;
      if (unit.kind === "event") node = <AgentTimelineSeparator event={unit.event} />;
      else if (unit.kind === "event-summary") {
        node = renderEventSummary ? renderEventSummary(unit.event) : <AgentTimelineSeparator event={unit.event} />;
      }
      else if (unit.kind === "caption") node = captionNode(unit.slotId);
      else if ("item" in unit) node = <AgentAnchorItems items={[unit.item]} ctx={anchorCtx} />;
      else if (unit.kind === "message" || unit.kind === "digest") {
        const row = turnRow ? buildAgentTurnRow({ message: unit.message, visibleIndex: visibleIndexes.get(unit.message.id)!,
          lastUserVisibleIndex, lastDigestAnchorVisibleIndex, isSending: isSending || !model.atThreadHead, hostActions: messageActions, callbacks: turnRow })
          : { hostActions: messageActions, turnActions: undefined };
        const block = <AgentMessageBlock message={unit.message} messageMarkup={messageMarkup}
          coveredCount={unit.kind === "digest" ? unit.coveredCount : null} messageActions={row.hostActions} turnActions={row.turnActions}
          canEditLast={row.canEditLast === true} onEditLast={onEditLast} canEditAssistant={row.canEditAssistant === true}
          onEditAssistant={onEditAssistant} isBusy={isSending} />;
        node = !model.anchoredIds.has(unit.message.id) && captions.captionBefore.has(unit.message.id) && hostTitle !== null
          ? <div className="flex min-w-0 flex-col">{captionNode(unit.message.id)}{block}</div> : block;
      } else continue;
      nodes.set(unit.unitId, <div className="px-4 pt-3">{node}</div>);
    }
    return nodes;
  }, [historyUnits, visibleMessages, model, captions, hostTitle, kind, threadId, liveJoinsLastTurn, anchorCtx,
    turnRow, lastUserVisibleIndex, lastDigestAnchorVisibleIndex, isSending, messageActions, messageMarkup, onEditLast, onEditAssistant, renderEventSummary, pageWindows]);

  const liveToolActivities = useMemo(() => feed.flatMap((entry) => {
    const a = entry.kind === "activity" ? activityById.get(entry.id) : undefined;
    return a && !a.ask && !a.permission && recordProposalOf(a) === undefined ? [a] : [];
  }), [feed, activityById]);
  const liveRows = useMemo(() => {
    const rows: AgentFeedLiveRow[] = [];
    let accordionPlaced = false;
    for (const entry of feed) {
      if (entry.kind !== "activity") {
        if (hasPendingText) rows.push({ kind: "text", id: entry.id, streaming: !entry.closed });
        continue;
      }
      const activity = activityById.get(entry.id);
      if (!activity) continue;
      if (activity.ask) rows.push({ kind: "ask", id: entry.id });
      else if (activity.permission) rows.push({ kind: "permission", id: entry.id });
      else if (recordProposalOf(activity) !== undefined) rows.push({ kind: "proposal", id: entry.id });
      else if (!accordionPlaced) { accordionPlaced = true; rows.push({ kind: "accordion", id: entry.id }); }
    }
    return rows;
  }, [feed, activityById, hasPendingText]);
  const errorProps = { turnFailure, visibleMessages, isSending, onRetryTurn };
  const hasFailure = hasAgentTurnError(errorProps);
  const hasLiveCaption = !liveTurnHasVisibleText && hostTitle !== null && (hasPendingText || hasLiveReasoning) && !liveJoinsLastTurn;
  const hasLiveReasoningRow = hasLiveReasoning && hostTitle === null;
  const hasPendingAssistant = hasPendingText && feed.length === 0;
  // Only the small live layout is serialized: token text is deliberately not
  // an input. Stable layout keeps the all-history id window unchanged per flush.
  const liveLayout = JSON.stringify(liveRows);
  const tailUnits = useMemo(() => agentFeedRenderUnits({ model: EMPTY_MODEL, tail: {
    hasPendingUser: hasPendingUserContent, hasLiveCaption, hasLiveReasoningRow,
    liveRows, hasPendingAssistant, hasFailure,
  } }), [liveLayout, hasPendingUserContent, hasLiveCaption, hasLiveReasoningRow, hasPendingAssistant, hasFailure]);
  const units = useMemo(() => [...historyUnits, ...tailUnits], [historyUnits, tailUnits]);
  const displayIds = useMemo(() => agentFeedUnitIds(units), [units]);
  const unitById = useMemo(() => new Map(units.map((unit) => [unit.unitId, unit])), [units]);
  const feedById = useMemo(() => new Map(feed.map((entry) => [entry.id, entry])), [feed]);

  // Stable append coordinates can be negative (partition math only). Actual
  // inverse-scroll indexes/cursors remain the paged-history owner's seam.
  const coordinates = useRef({ sessionKey, ids: displayIds, start: 0 });
  if (coordinates.current.sessionKey !== sessionKey) coordinates.current = { sessionKey, ids: displayIds, start: 0 };
  if (coordinates.current.ids !== displayIds) {
    const previous = coordinates.current;
    const positions = new Map(displayIds.map((id, index) => [id, index]));
    let start = previous.start;
    for (let i = 0; i < previous.ids.length; i++) {
      const nextIndex = positions.get(previous.ids[i]!);
      if (nextIndex !== undefined) { start += i - nextIndex; break; }
    }
    coordinates.current = { sessionKey, ids: displayIds, start };
  }
  const firstCoordinate = coordinates.current.start;
  const partition = useCallback((_ids: string[]) => {
    const window = partitionAgentFeedWindow(units, firstCoordinate);
    return { virtualizedIds: agentFeedUnitIds(window.virtualizedUnits), stableTailIds: agentFeedUnitIds(window.stableTailUnits), stableTailStartIndex: window.stableTailStartIndex };
  }, [units, firstCoordinate]);

  // A virtualized-away editor cannot run its own busy/deletion effect. Apply
  // those rules at the loaded-session boundary too, never on row unmount.
  const uiStore = useOptionalAgentFeedUiStateStore();
  const liveAccordionId = liveToolActivities[0]?.toolCallId;
  const retainedKeys = useMemo(() => new Set([
    ...messages.map((m) => agentFeedMessageUnitId(m.id)), ...events.map((e) => agentFeedEventUnitId(e.id)),
    ...[...captions.captionBefore.keys()].map((id) => agentFeedCaptionUnitId(pageWindows ? captions.stateKeys.get(id) ?? id : id)), agentFeedCaptionUnitId(pageWindows ? captions.stateKeys.get("trailing") ?? "trailing" : "trailing"),
    "live-caption", "live-reasoning",
    ...[...model.anchorItems.values(), model.trailingItems].flat().flatMap((item) => item.kind === "accordion" ? [item.stateKey ?? agentFeedAccordionUnitId(item.activities[0]!.toolCallId)] : []),
    ...(liveAccordionId ? [agentFeedAccordionUnitId(liveAccordionId)] : []),
  ]), [messages, events, captions, model, liveAccordionId, pageWindows]);
  const previousKeys = useRef({ store: uiStore, keys: retainedKeys });
  useEffect(() => {
    if (uiStore) {
      if (previousKeys.current.store === uiStore) for (const key of previousKeys.current.keys) if (!retainedKeys.has(key)) uiStore.clearRowState(key);
      if (isSending) for (const message of messages) uiStore.setRowState(agentFeedMessageUnitId(message.id), { draft: undefined });
    }
    previousKeys.current = { store: uiStore, keys: retainedKeys };
  }, [uiStore, retainedKeys, isSending, messages]);
  const fallbackReasoning = useAgentFeedDisclosure("live-reasoning", false);

  const renderItem = useCallback((_index: number, id: string) => {
    const historical = historyNodes.get(id);
    if (historical !== undefined) return historical;
    const unit = unitById.get(id)!;
    let node: ReactNode;
    if (unit.kind === "pending-user") node = <AgentMessageBlock messageMarkup={messageMarkup} message={syntheticAgentMessage({
      id: PENDING_USER_MESSAGE_ID, threadId, role: "user", content: pendingUserContent,
      ...(pendingUserAttachments.length ? { attachments: pendingUserAttachments } : {}),
    })} />;
    else if (unit.kind === "live-caption") node = <AgentHostCaption title={hostTitle!} reasoning={hasLiveReasoning ? liveReasoning : null} stateKey={unit.unitId} />;
    else if (unit.kind === "live-reasoning") node = <div className="flex flex-wrap items-center gap-2.5" data-role="assistant" data-testid="copilot-pending-reasoning-row">
      <MessageReasoning reasoning={liveReasoning} reasoningDurationMs={null} variant="inline" open={fallbackReasoning.open} onOpenChange={fallbackReasoning.toggle} />
    </div>;
    else if (unit.kind === "pending-assistant") node = <AgentMessageBlock messageMarkup={messageMarkup} isStreaming
      message={syntheticAgentMessage({ id: "__pending-assistant", threadId, role: "assistant", content: liveText })} />;
    else if (unit.kind === "failure") node = <AgentTurnErrorSlot {...errorProps} />;
    else if (unit.kind === "live") {
      const activity = activityById.get(unit.row.id);
      if (unit.row.kind === "accordion") node = <AgentToolAccordion activities={liveToolActivities} kind={kind} isSending />;
      else if (unit.row.kind === "ask" && activity) node = renderAskActivity(activity, anchorCtx);
      else if (unit.row.kind === "permission" && activity) node = renderPermissionActivity(activity, anchorCtx);
      else if (unit.row.kind === "proposal" && activity) node = renderProposalActivity(activity, recordProposalOf(activity)!, anchorCtx);
      else {
        const entry = feedById.get(unit.row.id);
        if (!entry || entry.kind === "activity") return null;
        node = <AgentMessageBlock messageMarkup={messageMarkup} isStreaming={!entry.closed}
          message={syntheticAgentMessage({ id: entry.id, threadId, role: "assistant", content: entry.text })} />;
      }
    } else return null;
    return <div className="px-4 pt-3">{node}</div>;
  }, [historyNodes, unitById, messageMarkup, threadId, pendingUserContent, pendingUserAttachments, hostTitle,
    hasLiveReasoning, liveReasoning, fallbackReasoning.open, fallbackReasoning.toggle, liveText, turnFailure,
    visibleMessages, isSending, onRetryTurn, activityById, liveToolActivities, kind, anchorCtx, feedById]);

  const isEmpty = historyUnits.length === 0 && !hasPendingUserContent
    && !hasPendingText && !liveReasoning && feed.length === 0;
  if (isEmpty) return <AgentEmptyState kind={kind} title={emptyTitle ?? t("agent_title")} sub={emptySub ?? t("agent_subtitle")}
    icon={emptyIcon} starterKeys={starterKeysOverride} handoffRow={handoffRow} onStarterPick={onStarterPick} />;
  return (
    <div data-testid="copilot-message-list" className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <AgentFeedScroller resetKey={sessionKey} displayIds={displayIds} partition={partition} renderItem={renderItem}
        topSpacerHeight={0} renderJumpToBottom={(jump) => <AgentJumpToBottom onClick={jump} />} />
    </div>
  );
}
