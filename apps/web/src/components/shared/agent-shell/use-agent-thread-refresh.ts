import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { AgentThreadOwner } from "@vibe-tavern/domain";
import type { AgentThreadEventWire, ExperienceCopilotMessageWire } from "@vibe-tavern/api-contracts";
import type {
  AgentHostBridge,
  AgentHostDescriptor,
  AgentHostTransport,
} from "../../../lib/agent-host-registry.js";

/**
 * The shell's thread-refresh trio (extracted from `AgentShell.ts` by the
 * file-size ratchet when DR-11 landed; behavior verbatim):
 *  - `refreshThread(id)` — the message/events reload half (ONE callback,
 *    CA-4f): the settle path calls it after a turn and the pane exposes it
 *    to sent-attachment actions through the CA-4f context — the same
 *    refetch path, never a second one. AFP-14: when the shell wires
 *    `feedRefresh` (a host with `transport.feed`), the callback routes
 *    through the paged feed hook instead — newest read + bounded bridge +
 *    typed-stale revalidation — and the legacy full-list reads below never
 *    run for that host.
 *  - `handleTurnSettled(ok)` — the controller's settle signal: the host
 *    learns the outcome first (SC-18: per-turn attachments clear on success
 *    and stay for a retry on failure), built fresh at call time from the
 *    ref-carried owner (the outcome lands after awaits, never the render
 *    closure); the only caller is the controller's settle path.
 *  - `refreshMessages()` — the pane-side current-thread refresh through the
 *    same `refreshThread` the settle path uses.
 */
export function useAgentThreadRefresh(args: {
  transport: AgentHostTransport;
  fetchEvents: (id: string) => Promise<AgentThreadEventWire[]>;
  setMessages: Dispatch<SetStateAction<ExperienceCopilotMessageWire[]>>;
  setEvents: Dispatch<SetStateAction<AgentThreadEventWire[]>>;
  /** AFP-14: the paged feed's refresh entry (`useAgentFeed`'s `refresh`),
   *  wired by the shell when the host transport carries `feed`. Present ⇒
   *  every refresh below routes through it; the `id` argument is advisory
   *  there — the hook is bound to the session's own thread and its pure
   *  apply refuses foreign-thread pages anyway. Absent = legacy host. */
  feedRefresh?: () => void;
  host: AgentHostDescriptor;
  ownerRef: RefObject<AgentThreadOwner>;
  scriptId: string | undefined;
  threadId: string | null;
  hostProps: unknown;
  bridge: AgentHostBridge;
}): {
  refreshThread: (id: string) => void;
  handleTurnSettled: (ok: boolean) => void;
  refreshMessages: () => void;
} {
  const { transport, fetchEvents, setMessages, setEvents, feedRefresh, host, ownerRef, scriptId, threadId, hostProps, bridge } = args;

  const refreshThread = useCallback((id: string) => {
    if (feedRefresh !== undefined) {
      // AFP-14: ONE refresh path — the feed hook's newest read + bounded
      // bridge (never a full-list fetch beside it; a >window settle walks
      // the gap, see use-agent-feed.ts).
      feedRefresh();
      return;
    }
    transport.listMessages(id)
      .then(setMessages)
      .catch(() => {
        // Best-effort refetch — swallow so a transient list failure leaves the
        // last-known messages on screen rather than surfacing a spurious error.
      });
    // SC-19b: the separators refetch alongside the messages (a host without
    // the member keeps its empty list — no separators, exactly as today).
    void fetchEvents(id).then(setEvents);
  }, [feedRefresh, transport, fetchEvents, setMessages, setEvents]);
  const handleTurnSettled = useCallback((ok: boolean) => {
    host.onSendSettled?.(
      { owner: ownerRef.current, scriptId, threadId, isSending: false, hostProps, bridge },
      ok,
    );
    if (!threadId) return;
    refreshThread(threadId);
  }, [threadId, host, scriptId, hostProps, bridge, ownerRef, refreshThread]);
  const refreshMessages = useCallback(() => {
    if (threadId !== null) refreshThread(threadId);
  }, [threadId, refreshThread]);

  return { refreshThread, handleTurnSettled, refreshMessages };
}
