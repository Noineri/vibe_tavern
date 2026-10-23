import type { ComponentType, ReactNode } from "react";
import { isRecordProposal, type AgentProposal, type RecordProposal } from "@vibe-tavern/api-contracts";
import type { CopilotAnswerInput } from "../../../api/experience-copilot-api.js";
import {
  type AgentAskState,
  type AgentPermissionState,
  type AgentToolActivity,
} from "../../../stores/agent-turn-store.js";
import type { AgentPendingAskAnswer, AgentPendingPermissionAnswer } from "./use-agent-controller.js";
import {
  type AgentKind,
  type RecordProposalCardProps,
  getAgentHost,
} from "../../../lib/agent-host-registry.js";
import { parseAgentToolOutput } from "../../../lib/agent-tool-output.js";
import { AgentAskCard } from "./AgentAskCard.js";
import { AgentPermissionCard } from "./AgentPermissionCard.js";
import { AgentToolAccordion } from "./AgentToolAccordion.js";
import { RecordProposalFallbackCard } from "./RecordProposalFallbackCard.js";

/**
 * The TA-1 anchor cluster for the agent feed (extracted from
 * `AgentMessageList.tsx` under the file-size ratchet — verbatim move, no
 * behavior change). One ordered render item pinned between two flow messages
 * (TA-1, owner ruling 2026-10-12: ONE accordion per assistant turn hides ALL
 * of that turn's tool calls). `"accordion"` is the turn's single tool group —
 * placed at the turn's FIRST non-ask non-proposal tool activity's slot,
 * collecting every non-ask non-proposal activity of the turn (interleaved
 * text does not split it); `"ask"` is an `ask_user` card and `"proposal"`
 * a record-proposal card, both kept OUTSIDE the accordion, rendered in
 * place (TAG-9: the ask stays interactive; SC-13a: a settled turn collapses
 * its tools into the tools accordion, which would hide the proposal's
 * accept/reject behind a closed list). Items within one anchor list keep
 * their chronological slot order.
 */
export type CopilotTurnAnchorItem =
  | { kind: "accordion"; activities: AgentToolActivity[] }
  | { kind: "ask"; activity: AgentToolActivity }
  | { kind: "permission"; activity: AgentToolActivity }
  | { kind: "proposal"; activity: AgentToolActivity; proposal: RecordProposal };

/**
 * SC-13a: narrow a tool activity to the record proposal its output carries
 * (parsed through the shared `parseAgentToolOutput`, narrowed by the
 * contract's `isRecordProposal`) — undefined for every other tool (asks,
 * buffer writes, test digests). Pure.
 */
export function recordProposalOf(activity: AgentToolActivity): RecordProposal | undefined {
  const parsed: unknown = parseAgentToolOutput(activity);
  if (parsed === undefined) return undefined;
  const candidate = parsed as AgentProposal;
  if (isRecordProposal(candidate)) return candidate;
  return undefined;
}

/** The card renderers' shared context — everything they read from the list's
 *  scope (the live-ask derivation, the optimistic overrides, the stream
 *  flag), threaded explicitly so history, trailing, and live call sites share
 *  the same rules. */
export interface AgentAnchorContext {
  kind: AgentKind;
  threadId: string;
  /** AP-5: the thread's live awaiting ask (the ONE derivation). */
  liveAsk: AgentToolActivity | null;
  /** The thread's chronologically last activity id (the permission rule). */
  lastActivityId: string | null;
  isSending: boolean;
  onAnswer?: (toolCallId: string, answer: CopilotAnswerInput) => void;
  pendingAskAnswer: AgentPendingAskAnswer | null;
  pendingPermissionAnswer: AgentPendingPermissionAnswer | null;
}

// SC-23f: `read_message_prompt` remains its own interactive card,
// rendered IN PLACE at its chronological slot — never inside a turn's
// tool accordion (the ask-card precedent: TA-1 collects only non-ask
// non-permission activities). The optimistic override resolves the card
// immediately; the RESOLVED states read the rewritten row (granted →
// allowed, denied → denied), never local state alone.
export function renderPermissionActivity(activity: AgentToolActivity, ctx: AgentAnchorContext): ReactNode {
  const permission = activity.permission!;
  const resolved: AgentPermissionState =
    ctx.pendingPermissionAnswer && ctx.pendingPermissionAnswer.toolCallId === activity.toolCallId
      ? {
          ...permission,
          status: ctx.pendingPermissionAnswer.decision === "allow" ? "granted" : "denied",
        }
      : permission;
  return (
    <AgentPermissionCard
      key={activity.toolCallId}
      permission={resolved}
      interactive={
        resolved.status === "awaiting_permission" &&
        activity.toolCallId === ctx.lastActivityId &&
        !ctx.isSending &&
        ctx.onAnswer !== undefined
      }
      onDecision={ctx.onAnswer ? (decision) => ctx.onAnswer!(activity.toolCallId, { decision }) : undefined}
    />
  );
}

// TAG-9: `ask_user` remains its own interactive card, rendered IN PLACE at
// its chronological slot — never inside a turn's tool accordion (TA-1
// collects only non-ask activities). AP-5: the interactive rule reads the
// live-ask selector — awaiting + THE live ask + answerable (the selector
// folds the old `lastActivityId` + `!isSending` conjuncts).
export function renderAskActivity(activity: AgentToolActivity, ctx: AgentAnchorContext): ReactNode {
  const ask = activity.ask!;
  const resolved: AgentAskState =
    ctx.pendingAskAnswer && ctx.pendingAskAnswer.toolCallId === activity.toolCallId
      ? {
          ...ask,
          status: ctx.pendingAskAnswer.status,
          ...(ctx.pendingAskAnswer.answer !== undefined ? { answer: ctx.pendingAskAnswer.answer } : {}),
        }
      : ask;
  return (
    <AgentAskCard
      key={activity.toolCallId}
      ask={resolved}
      interactive={
        resolved.status === "awaiting_answer" &&
        ctx.liveAsk !== null &&
        ctx.liveAsk.toolCallId === activity.toolCallId &&
        ctx.onAnswer !== undefined
      }
      onSubmit={ctx.onAnswer ? (a) => ctx.onAnswer!(activity.toolCallId, a) : undefined}
    />
  );
}

// SC-13a: a record proposal renders through the host's per-recordType
// renderer (`host.recordProposalRenderers[proposal.recordType]`), falling
// back to the neutral `RecordProposalFallbackCard` for an unknown type
// (or an unknown host) — an unrendered op never crashes the feed. The
// thread id rides the props (the SC-13c card resolves against its thread).
export function renderProposalActivity(
  activity: AgentToolActivity,
  proposal: RecordProposal,
  ctx: AgentAnchorContext,
): ReactNode {
  let Renderer: ComponentType<RecordProposalCardProps>;
  try {
    Renderer = getAgentHost(ctx.kind).recordProposalRenderers[proposal.recordType] ?? RecordProposalFallbackCard;
  } catch {
    Renderer = RecordProposalFallbackCard;
  }
  return <Renderer key={activity.toolCallId} proposal={proposal} threadId={ctx.threadId} />;
}

/** TA-1: history renders each turn as ONE accordion (at the first tool
 *  activity's slot) plus in-place ask, permission and proposal cards, in
 *  the items' slot order. Only the live feed receives `isSending`:
 *  historical groups stay collapsed even while a newer turn is in flight. */
export function AgentAnchorItems({
  items,
  ctx,
}: {
  items: readonly CopilotTurnAnchorItem[];
  ctx: AgentAnchorContext;
}): ReactNode {
  return items.map((item) =>
    item.kind === "accordion" ? (
      <AgentToolAccordion
        key={item.activities[0]!.toolCallId}
        activities={item.activities}
        kind={ctx.kind}
        isSending={false}
      />
    ) : item.kind === "ask" ? (
      renderAskActivity(item.activity, ctx)
    ) : item.kind === "permission" ? (
      renderPermissionActivity(item.activity, ctx)
    ) : (
      renderProposalActivity(item.activity, item.proposal, ctx)
    ),
  );
}
