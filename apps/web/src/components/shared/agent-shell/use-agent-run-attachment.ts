import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { getT } from "../../../i18n/locale-helpers.js";
import { agentThreadKey, type AgentHostTransport, type CopilotStreamOpts } from "../../../lib/agent-host-registry.js";
import { useAgentTurnStore } from "../../../stores/agent-turn-store.js";
import { showProviderErrorToast } from "./use-agent-turn-actions.js";
import { isAgentRunActiveError } from "./agent-stream-guard.js";

type StreamResult = Awaited<ReturnType<AgentHostTransport["sendStream"]>>;
interface AttachmentArgs {
  kind: string;
  threadId: string | null;
  transport: AgentHostTransport;
  abortRef: { current: AbortController | null };
  isSendingRef: { current: boolean };
  reset: () => void;
  clearOptimistic: () => void;
  setIsSending: (value: boolean) => void;
  buildCallbacks: (threadId: string, saw: { current: boolean }) => CopilotStreamOpts;
  settled: (result: StreamResult | null, error?: unknown) => void;
}

/** Owns a view's subscription, never a producer. A fresh view rebuilds from
 * cursor zero (text/segments are not cached); GET replay still carries its
 * numbered cursor and rejects duplicate frames at the transport boundary. */
export function useAgentRunAttachment(args: AttachmentArgs) {
  const latest = useRef(args);
  latest.current = args;
  const mounted = useRef(true);
  const serverOwned = useRef(false);
  const stopping = useRef<AbortController | null>(null);
  const discovery = useRef<Promise<void> | null>(null);
  const { kind, threadId, transport, abortRef, isSendingRef } = args;
  const key = threadId === null ? null : agentThreadKey(kind, threadId);
  const currentKey = useRef(key);
  currentKey.current = key;
  const isCurrent = useCallback((controller: AbortController, id: string) =>
    mounted.current && currentKey.current === agentThreadKey(kind, id) && abortRef.current === controller,
  [kind, abortRef]);

  const preparing = useCallback(() => { serverOwned.current = false; }, []);
  const observing = useCallback(() => { serverOwned.current = true; }, []);
  const subscribe = useCallback((id: string, controller: AbortController, callbacks: CopilotStreamOpts) => {
    let reset = false;
    return transport.runs!.subscribe(id, 0, {
      ...callbacks, signal: controller.signal,
      onStatus: (status) => {
        // Buffer transports hydrate first. Clearing here (at the actual GET)
        // cannot invalidate an in-flight host hydration or its ready flag.
        if (!reset && status === "preparing" && isCurrent(controller, id)) {
          reset = true;
          useAgentTurnStore.getState().clearTurn(kind, id);
        }
        callbacks.onStatus(status);
      },
    });
  }, [transport, kind, isCurrent]);

  useEffect(() => {
    mounted.current = true;
    serverOwned.current = false;
    latest.current.reset();
    if (threadId !== null && transport.runs) {
      const controller = new AbortController();
      let resolveDiscovery!: () => void;
      const pendingDiscovery = new Promise<void>((resolve) => { resolveDiscovery = resolve; });
      discovery.current = pendingDiscovery;
      const discovered = () => {
        resolveDiscovery();
        if (discovery.current === pendingDiscovery) discovery.current = null;
      };
      abortRef.current = controller;
      isSendingRef.current = true;
      void (async () => {
        let observingRun = false;
        try {
          const running = await transport.runs!.isRunning(threadId, controller.signal);
          discovered();
          if (!isCurrent(controller, threadId) || controller.signal.aborted || !running) return;
          observingRun = true;
          serverOwned.current = true;
          latest.current.setIsSending(true);
          const result = await subscribe(threadId, controller, latest.current.buildCallbacks(threadId, { current: false }));
          if (isCurrent(controller, threadId)) latest.current.settled(result);
        } catch (error) {
          if (!isCurrent(controller, threadId) || controller.signal.aborted) return;
          if (observingRun) latest.current.settled(null, error);
          else console.warn("[agent-run] discovery failed", error);
        } finally {
          discovered();
          if (isCurrent(controller, threadId)) {
            abortRef.current = null;
            isSendingRef.current = false;
            latest.current.reset();
          }
        }
      })();
    }
    return () => {
      mounted.current = false;
      // This signal belongs ONLY to discovery/the HTTP reader. The server
      // registry owns a different signal; no stop request on cleanup.
      abortRef.current?.abort();
      abortRef.current = null;
      isSendingRef.current = false;
    };
  }, [kind, threadId, transport, isCurrent, abortRef, isSendingRef, subscribe]);

  const followExisting = useCallback(async (error: unknown, id: string, controller: AbortController, callbacks: CopilotStreamOpts): Promise<StreamResult> => {
    if (!isAgentRunActiveError(error) || !transport.runs || !isCurrent(controller, id)) throw error;
    // The refused POST created no new user/answer row. Follow the winner,
    // without preparation/checkpoint or a transient failure card.
    latest.current.clearOptimistic();
    latest.current.setIsSending(true);
    serverOwned.current = true;
    return subscribe(id, controller, callbacks);
  }, [transport, isCurrent, subscribe]);

  const cancel = useCallback(() => {
    const controller = abortRef.current;
    if (!controller || threadId === null) return;
    if (!serverOwned.current || !transport.runs) controller.abort();
    else if (stopping.current !== controller) {
      stopping.current = controller;
      void transport.runs.stop(threadId).catch((error: unknown) => {
        if (isCurrent(controller, threadId)) showProviderErrorToast(error, getT());
      }).finally(() => { if (stopping.current === controller) stopping.current = null; });
    }
    toast.info(getT()("cancelling_generation"));
  }, [abortRef, threadId, transport, isCurrent]);

  const waitForDiscovery = useCallback((id: string): Promise<boolean> | undefined => {
    const pending = discovery.current;
    if (pending) return pending.then(() => mounted.current && currentKey.current === agentThreadKey(kind, id));
  }, [kind]);

  return { isCurrent, preparing, observing, followExisting, cancel, waitForDiscovery };
}
