import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { rafScheduler, type RevealScheduler } from "../../../lib/streaming-reveal.js";
import type { AgentKind } from "../../../lib/agent-host-registry.js";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";

/**
 * Frame-coalesced stream deltas (LAG-2, AGENT_SHELL_RENDER_LAG_REPORT fix
 * step 3) — the ONE derivation of the agent streams' delta buffering.
 *
 * Text/reasoning deltas accumulate in a REF (no state write per token) and
 * flush ONCE per frame through the injected `scheduler` (default: the rAF
 * scheduler `lib/streaming-reveal.ts` owns): ONE `setPendingText` /
 * `setPendingReasoning` and ONE `appendTextDelta` per flush, so the shell
 * root and the scroll hook fire per flush, not per token.
 *
 * The buffer drains SYNCHRONOUSLY before every tool event (text must never
 * land after the activity that followed it), before every settle/abort/
 * failure clear, and on unmount — no delta is ever dropped; the feed's final
 * text is byte-identical to the per-token writes this replaced
 * (`appendTextDelta` appends into the open text segment, so N small deltas
 * and one concatenated delta produce the same segment). The draining thread
 * id is captured at PUSH time — the callbacks close over the sending turn,
 * never a render closure a re-render could age.
 *
 * Split from `use-agent-controller.ts` under the file-size ratchet (LAG-2);
 * the controller passes its state writers in and drains the returned flush
 * handle at every clear site (its send/answer paths and the regenerate path
 * in `use-agent-turn-actions.ts`).
 */
export interface UseAgentDeltaBufferArgs {
  /** Store-key half of `agentThreadKey` — the kind of the owning controller. */
  kind: AgentKind;
  /** LAG-2: the flush scheduler. Defaults to the rAF scheduler from
   *  `lib/streaming-reveal.ts`; tests inject a manual stepper. */
  scheduler?: RevealScheduler;
  /** The controller's `pendingText` writer (accumulated per flush). */
  setPendingText: Dispatch<SetStateAction<string>>;
  /** The controller's `pendingReasoning` writer (accumulated per flush). */
  setPendingReasoning: Dispatch<SetStateAction<string>>;
}

/** The push/flush pair the controller routes its stream callbacks through. */
export interface AgentDeltaBuffer {
  /** Buffer one delta for the flushing turn; schedules the frame if idle. */
  pushStreamDelta: (activeThreadId: string, slot: "text" | "reasoning", delta: string) => void;
  /** Drain the buffer NOW (write + reset); no-op when nothing is buffered. */
  flushDeltaBuffer: () => void;
}

export function useAgentDeltaBuffer(
  args: UseAgentDeltaBufferArgs,
): AgentDeltaBuffer {
  const { kind, scheduler = rafScheduler, setPendingText, setPendingReasoning } = args;

  const deltaBufferRef = useRef<{ threadId: string | null; text: string; reasoning: string }>({
    threadId: null,
    text: "",
    reasoning: "",
  });
  const cancelFlushRef = useRef<(() => void) | null>(null);

  /** Drain the buffer NOW — cancel the pending frame, write the buffered
   *  deltas through (one store append + one state accumulation per buffer),
   *  reset the buffer. No-op when nothing is buffered. */
  const flushDeltaBuffer = useCallback((): void => {
    cancelFlushRef.current?.();
    cancelFlushRef.current = null;
    const buffer = deltaBufferRef.current;
    const { threadId, text, reasoning } = buffer;
    if (threadId === null || (text === "" && reasoning === "")) {
      buffer.threadId = null;
      return;
    }
    buffer.threadId = null;
    buffer.text = "";
    buffer.reasoning = "";
    if (text !== "") {
      setPendingText((p) => p + text);
      useAgentTurnStore.getState().appendTextDelta(kind, threadId, text);
    }
    if (reasoning !== "") setPendingReasoning((p) => p + reasoning);
  }, [kind, setPendingText, setPendingReasoning]);

  /** Buffer one delta for the flushing turn and ensure exactly ONE frame is
   *  scheduled while anything is buffered. */
  const pushStreamDelta = useCallback(
    (activeThreadId: string, slot: "text" | "reasoning", delta: string): void => {
      const buffer = deltaBufferRef.current;
      if (buffer.threadId === null) buffer.threadId = activeThreadId;
      buffer[slot] += delta;
      if (cancelFlushRef.current === null) {
        cancelFlushRef.current = scheduler(() => flushDeltaBuffer());
      }
    },
    [scheduler, flushDeltaBuffer],
  );

  // Drain on unmount — the turn store survives the component, so a delta
  // that arrived before the unmount must still land in the feed (the React
  // state writes above are no-ops on an unmounted component).
  useEffect(() => () => flushDeltaBuffer(), [flushDeltaBuffer]);

  return { pushStreamDelta, flushDeltaBuffer };
}
