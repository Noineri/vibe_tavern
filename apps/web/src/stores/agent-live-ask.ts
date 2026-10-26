import type { ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import { extractHistoricalTurnActivities, type AgentFeedEntry, type AgentToolActivity } from "./agent-turn-store.js";

/**
 * AP-5 (AGENT_SHELL_POLISH): the ONE pure derivation of "the thread's live
 * awaiting ask" — the `ask_user` call the MAIN COMPOSER answers while it
 * exists. One source, two consumers: the message list's ask-card interactive
 * rule and the chat pane's composer routing both call this selector, so the
 * card that looks answerable and the send that answers it can never disagree
 * (a second hand-rolled derivation would be a defect from copy #2).
 *
 * The rule (the TAG-9 semantics the list encoded inline, unchanged): the
 * thread's chronologically LAST activity must be an `ask_user` activity still
 * `awaiting_answer`, no stream may be running, and the optimistic
 * `pendingAskAnswer` override must not have resolved it (the user already
 * clicked a chip — the composer send that follows is a normal message). The
 * `ask_user` family ONLY: a waiting permission card (`read_message_prompt`)
 * keeps its own inline rule and its own buttons (SC-23e/f behavior — a
 * composer send while it waits stays a normal message that leaves the card
 * in its unanswered/expired state).
 *
 * The last-activity order mirrors the list: the live feed first (it is the
 * current turn — its last activity entry is chronologically after every
 * history row), then the last history activity the live store does not
 * already own (the settle+refetch dedupe). Pure: store state and props in,
 * answer out — no I/O, no React, no store reads.
 */

/** Structural input satisfied by the controller's `AgentPendingAskAnswer`
 *  (only the toolCallId matters here — the override's status/answer render on
 *  the card; this selector only decides live-or-not, so stores import nothing
 *  from components). */
export interface AgentAskOverrideInput {
  toolCallId: string;
}

export interface SelectAgentLiveAskArgs {
  /** The thread's live feed — the ephemeral turn store's `feedByThread` slice. */
  feed: ReadonlyArray<AgentFeedEntry>;
  /** The thread's live activities — the store's `turnsByThread` slice. */
  activities: ReadonlyArray<AgentToolActivity>;
  /** The thread's persisted wire messages — the history-fallback source. */
  messages: ReadonlyArray<ExperienceCopilotMessageWire>;
  /** The controller's optimistic ask resolution (null when none). */
  pendingAskAnswer: AgentAskOverrideInput | null;
  /** True while a turn streams — no ask is live then. */
  isSending: boolean;
}

/** Select the thread's live awaiting ask — the `ask_user` activity the
 *  composer answers — or null when no ask is live. */
export function selectAgentLiveAsk(args: SelectAgentLiveAskArgs): AgentToolActivity | null {
  const { feed, activities, messages, pendingAskAnswer, isSending } = args;
  if (isSending) return null;

  // The live feed is the current turn: its LAST activity entry is the
  // thread's chronologically last activity. A dangling ref (no activity
  // behind it) still occupies the slot — nothing earlier is live.
  const activityById = new Map(activities.map((activity) => [activity.toolCallId, activity]));
  for (let i = feed.length - 1; i >= 0; i--) {
    const entry = feed[i];
    if (entry === undefined || entry.kind !== "activity") continue;
    const activity = activityById.get(entry.id);
    if (activity === undefined) return null;
    return liveAskOf(activity, pendingAskAnswer);
  }

  // No live activity entries — history owns the last activity (the state a
  // reload or thread switch leaves). Skip rows the live store already owns
  // (the same dedupe the message list applies after settle+refetch).
  const liveIds = new Set(activities.map((activity) => activity.toolCallId));
  const turns = extractHistoricalTurnActivities(messages);
  for (let t = turns.length - 1; t >= 0; t--) {
    const acts = turns[t]!.activities;
    for (let i = acts.length - 1; i >= 0; i--) {
      const activity = acts[i]!;
      if (liveIds.has(activity.toolCallId)) continue;
      return liveAskOf(activity, pendingAskAnswer);
    }
  }
  return null;
}

/** The ask-family live check for the last-activity candidate: an awaiting
 *  `ask_user` not resolved by the optimistic override. Everything else —
 *  permission cards, other tools, answered/skipped asks — is not the
 *  composer's ask. */
function liveAskOf(
  activity: AgentToolActivity,
  pendingAskAnswer: AgentAskOverrideInput | null,
): AgentToolActivity | null {
  if (activity.ask === undefined) return null;
  if (activity.ask.status !== "awaiting_answer") return null;
  if (pendingAskAnswer !== null && pendingAskAnswer.toolCallId === activity.toolCallId) return null;
  return activity;
}
