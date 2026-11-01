import { create } from "zustand";
import { agentThreadKey, type AgentKind } from "../lib/agent-host-registry.js";

/**
 * Agent live-stream store (LAG-3, AGENT_SHELL_RENDER_LAG_REPORT fix step 4)
 * — the per-thread LIVE turn text/reasoning, the ONE derivation of the
 * streaming state the message list renders.
 *
 * WHY A SEPARATE SLICE (not controller state, not the turn store's feed):
 * the live text used to accumulate in `useAgentController`'s hook state, so
 * every frame-coalesced flush (LAG-2) re-rendered the whole AgentShell tree
 * — the host editor pane, composer, header, model pills and context meter
 * included. Moving it here keeps the flush write OUTSIDE the shell's render
 * path: only components subscribed to this slice (the message list, and the
 * scroll hook through the list's render) re-render per flush; `isSending`
 * STAYS on the controller (it flips twice per turn, never per flush). The
 * feed slice of `agent-turn-store.ts` keeps the ORDERED rendering stream
 * (text segments + activity refs — it must persist post-settle for the
 * CD-1 dedupe while the live text is suppressed); this slice is the plain
 * accumulated pair the renderer's has-live-text checks read. The two are
 * written by the SAME flush (one write each per frame — LAG-2's cadence
 * preserved), so they never disagree.
 *
 * Lifecycle = the controller's old pendingText/pendingReasoning exactly:
 * appended per flush by the delta buffer (`use-agent-delta-buffer.ts` — the
 * ONE buffering derivation), cleared synchronously at every settle/abort/
 * failure clear and turn start (`clearLiveStreamText`; the turn store's
 * `clearTurn` drops the feed, this clear drops the live pair — the
 * controller/turn-actions call sites keep the same ordering as before).
 * Not persisted (no `persist` middleware), keyed by `agentThreadKey(kind,
 * threadId)` like the turn store — the experience kind keeps its legacy
 * bare threadId key, later kinds namespace.
 */
export interface AgentLiveStreamText {
  /** Live assistant text accumulated from text-deltas this turn. */
  text: string;
  /** Live model reasoning accumulated from reasoning-deltas this turn. */
  reasoning: string;
}

interface AgentLiveStreamState {
  liveByThread: Record<string, AgentLiveStreamText>;
  /** LAG-2/LAG-3: append one flush's coalesced deltas (empty deltas are a
   *  no-op — the buffer never schedules an empty frame, but the guard keeps
   *  the action total). ONE write per flush. */
  appendLiveDeltas: (kind: AgentKind, threadId: string, deltas: { text?: string; reasoning?: string }) => void;
  /** Clear the thread's live pair (settle / abort / failure / turn start).
   *  No-op when the thread has no live entry, so redundant clears do not
   *  notify subscribers. */
  clearLiveStreamText: (kind: AgentKind, threadId: string) => void;
}

const EMPTY_LIVE: AgentLiveStreamText = { text: "", reasoning: "" };

export const useAgentLiveStreamStore = create<AgentLiveStreamState>((set) => ({
  liveByThread: {},
  appendLiveDeltas: (kind, threadId, deltas) => {
    const text = deltas.text ?? "";
    const reasoning = deltas.reasoning ?? "";
    if (text === "" && reasoning === "") return;
    const key = agentThreadKey(kind, threadId);
    set((s) => {
      const prev = s.liveByThread[key] ?? EMPTY_LIVE;
      return {
        liveByThread: {
          ...s.liveByThread,
          [key]: { text: prev.text + text, reasoning: prev.reasoning + reasoning },
        },
      };
    });
  },
  clearLiveStreamText: (kind, threadId) => {
    const key = agentThreadKey(kind, threadId);
    set((s) => {
      if (s.liveByThread[key] === undefined) return s;
      const next = { ...s.liveByThread };
      delete next[key];
      return { liveByThread: next };
    });
  },
}));

/** The thread's live text ("" when none) — the ONE selector consumers use
 *  (the message list's `hasPendingText` / fallback bubble / scroll-hook
 *  input). Primitive result: an unchanged value never re-renders. */
export function agentLiveTextOf(state: AgentLiveStreamState, kind: AgentKind, threadId: string): string {
  return state.liveByThread[agentThreadKey(kind, threadId)]?.text ?? "";
}

/** The thread's live reasoning ("" when none) — the ONE selector for the
 *  AP-29 live caption line. Primitive result, same contract as above. */
export function agentLiveReasoningOf(state: AgentLiveStreamState, kind: AgentKind, threadId: string): string {
  return state.liveByThread[agentThreadKey(kind, threadId)]?.reasoning ?? "";
}
