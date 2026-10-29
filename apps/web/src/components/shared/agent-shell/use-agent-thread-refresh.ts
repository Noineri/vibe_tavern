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
 *    refetch path, never a second one.
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
  const { transport, fetchEvents, setMessages, setEvents, host, ownerRef, scriptId, threadId, hostProps, bridge } = args;

  const refreshThread = useCallback((id: string) => {
    transport.listMessages(id)
      .then(setMessages)
      .catch(() => {
        // Best-effort refetch — swallow so a transient list failure leaves the
        // last-known messages on screen rather than surfacing a spurious error.
      });
    // SC-19b: the separators refetch alongside the messages (a host without
    // the member keeps its empty list — no separators, exactly as today).
    void fetchEvents(id).then(setEvents);
  }, [transport, fetchEvents, setMessages, setEvents]);
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
