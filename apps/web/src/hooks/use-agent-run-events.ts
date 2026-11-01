import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { isRecord, type AgentThreadOwner } from "@vibe-tavern/domain";
import { getGatewayBaseUrl } from "../api/client.js";
import { appendTokenQuery } from "../lib/mobile-token.js";
import { getAgentHost } from "../lib/agent-host-registry.js";
import { isAgentThreadVisible } from "../lib/agent-run-visibility.js";
import { useT } from "../i18n/context.js";
import { openCoauthorChat, openRoleplayChat } from "../lib/agent-host-navigation.js";
import { getGenerationQueue } from "../api/chat-generation-queue-api.js";
import { useChatStore } from "../stores/chat-store.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";
import { useNavigationStore } from "../stores/navigation-store.js";
import { listActiveAgentRuns } from "../api/agent-run-api.js";
import { nativeRunChatId, useChatRunActivityStore } from "../stores/chat-run-activity-store.js";

function navigableOwner(value: unknown): AgentThreadOwner | null {
  if (!isRecord(value)) return null;
  if (value.kind === "script" && typeof value.scriptId === "string" && value.scriptId.length > 0) return { kind: "script", scriptId: value.scriptId };
  if (value.kind === "chat" && typeof value.chatId === "string" && value.chatId.length > 0
    && typeof value.branchId === "string" && value.branchId.length > 0
    && typeof value.agentKind === "string" && value.agentKind.length > 0) {
    return { kind: "chat", chatId: value.chatId, branchId: value.branchId, agentKind: value.agentKind };
  }
  return null;
}

/** One app-lifetime, authenticated lifecycle channel. It never subscribes to
 * generation deltas or owns a run; EventSource reconnects silently as usual. */
export function useAgentRunEvents(): void {
  const { t } = useT();
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    let mounted = true;
    let discovery: AbortController | null = null;
    let changes = new Map<string, boolean>();
    // The server subscribes before ready. Reconcile on EVERY ready (including
    // reconnect), overlaying events received while the list was in flight.
    const onReady = async () => {
      discovery?.abort();
      const controller = new AbortController();
      discovery = controller;
      const duringRead = new Map<string, boolean>();
      changes = duringRead;
      try {
        const runs = await listActiveAgentRuns(controller.signal);
        if (!mounted || controller.signal.aborted) return;
        const running: Record<string, true> = {};
        for (const run of runs) {
          const chatId = nativeRunChatId(run);
          if (chatId) running[chatId] = true;
        }
        for (const [chatId, active] of duringRead) {
          if (active) running[chatId] = true;
          else delete running[chatId];
        }
        useChatRunActivityStore.getState().replaceRunning(running);
      } catch (error) {
        if (mounted && !controller.signal.aborted) console.warn("[chat-run] active run discovery failed", error);
      }
    };
    const replies = new Map<string, { revision: number; notified: boolean }>();
    const finishedCoauthorChats = new Set<string>();
    const visibleChat = (id: string) => useNavigationStore.getState().mode === "play"
      && useChatStore.getState().activeChatId === id && useSnapshotStore.getState().activeChat?.id === id;
    const notifyReply = async (chatId: string, name: string, revision: number) => {
      try {
        const jobs = await getGenerationQueue(chatId);
        const current = replies.get(chatId);
        if (!mounted || !current || current.revision !== revision || current.notified || visibleChat(chatId)
          || jobs.some((job) => job.status === "pending" || job.status === "running")) return;
        current.notified = true;
        useChatRunActivityStore.getState().markReady(chatId);
        toast.success(tRef.current("chat_new_reply_toast", { name }), {
          action: { label: tRef.current("agent_run_open"), onClick: async () => {
            try { await openRoleplayChat(chatId); }
            catch (error) { toast.error(error instanceof Error ? error.message : tRef.current("request_failed")); }
          } },
        });
      } catch (error) { if (mounted) console.warn("[chat-run] completion queue check failed", error); }
    };
    const source = new EventSource(appendTokenQuery(`${getGatewayBaseUrl()}/api/agent-runs/events`));
    const onRun = (message: MessageEvent) => {
      if (!mounted) return;
      let event: unknown;
      try { event = JSON.parse(message.data); } catch { return; }
      if (!isRecord(event) || typeof event.threadId !== "string" || event.threadId.length === 0 || typeof event.kind !== "string" || typeof event.title !== "string") return;
      const nativeChatId = nativeRunChatId(event);
      if (nativeChatId && ["started", "finished", "failed", "stopped", "asking"].includes(String(event.state))) {
        const running = event.state === "started";
        changes.set(nativeChatId, running);
        useChatRunActivityStore.getState().setRunning(nativeChatId, running);
        if (event.kind === "coauthor") {
          if (running) finishedCoauthorChats.delete(nativeChatId);
          else if (event.state === "finished" && !finishedCoauthorChats.has(nativeChatId)) {
            finishedCoauthorChats.add(nativeChatId);
            if (!visibleChat(nativeChatId) && !isAgentThreadVisible("coauthor", event.threadId)) {
              useChatRunActivityStore.getState().markReady(nativeChatId);
            }
          }
        }
      }
      if (event.kind === "rp") {
        const owner = event.owner;
        if (!isRecord(owner) || owner.kind !== "chat" || owner.mode !== "rp" || typeof owner.chatId !== "string"
          || !owner.chatId || event.threadId !== `chat:${owner.chatId}`) return;
        if (!["started", "finished", "failed", "stopped", "asking"].includes(String(event.state))) return;
        const previous = replies.get(owner.chatId);
        const state = { revision: (previous?.revision ?? 0) + 1, notified: event.state === "started" ? false : previous?.notified ?? false };
        replies.set(owner.chatId, state);
        // RP headers use the chat character's name (no RP authorOverride); the
        // registry title comes from that same character row, not chat.title.
        if (event.state === "finished") {
          if (visibleChat(owner.chatId)) state.notified = true;
          else if (!state.notified) void notifyReply(owner.chatId, event.title, state.revision);
        }
        return;
      }
      const key = event.state === "finished" ? "agent_run_finished_toast"
        : event.state === "asking" ? "agent_run_asking_toast"
        : event.state === "failed" ? "agent_run_failed_toast" : null;
      if (key === null || isAgentThreadVisible(event.kind, event.threadId)) return;
      let open: (() => void | Promise<void>) | undefined;
      if (event.kind === "coauthor") {
        const owner = event.owner;
        if (!isRecord(owner) || owner.kind !== "chat" || owner.mode !== "coauthor"
          || typeof owner.chatId !== "string" || owner.chatId.length === 0 || event.threadId !== `chat:${owner.chatId}`) return;
        const chatId = owner.chatId;
        open = () => openCoauthorChat(chatId);
      } else {
        const owner = navigableOwner(event.owner);
        if (!owner || (owner.kind === "chat" && owner.agentKind !== event.kind)) return;
        try {
          const navigate = getAgentHost(event.kind).open;
          if (navigate) open = () => navigate(owner);
        } catch { return; }
      }
      if (!open) return;
      const notify = event.state === "failed" ? toast.error : event.state === "asking" ? toast.info : toast.success;
      notify(tRef.current(key, { name: event.title }), {
        action: {
          label: tRef.current("agent_run_open"),
          onClick: async () => {
             try { await open(); }
            catch (error) { toast.error(error instanceof Error ? error.message : tRef.current("request_failed")); }
          },
        },
      });
    };
    // A character selection is not a read. Acknowledge only after the actual
    // chat snapshot and navigation agree that its conversation is on screen.
    const acknowledgeVisible = () => {
      const chatId = useChatStore.getState().activeChatId;
      if (!chatId || !visibleChat(chatId)) return;
      useChatRunActivityStore.getState().markRead(chatId);
      const pending = replies.get(chatId);
      if (pending) pending.notified = true; // Invalidate a slow completion check even if the user leaves again.
    };
    const offChat = useChatStore.subscribe((state, previous) => {
      if (state.activeChatId !== previous.activeChatId) acknowledgeVisible();
    });
    const offSnapshot = useSnapshotStore.subscribe((state, previous) => {
      if (state.activeChat?.id !== previous.activeChat?.id) acknowledgeVisible();
    });
    const offNavigation = useNavigationStore.subscribe((state, previous) => {
      if (state.mode !== previous.mode) acknowledgeVisible();
    });
    acknowledgeVisible();
    source.addEventListener("agent.run", onRun as EventListener);
    source.addEventListener("ready", onReady);
    return () => {
      mounted = false;
      offChat(); offSnapshot(); offNavigation();
      discovery?.abort();
      useChatRunActivityStore.getState().replaceRunning({});
      source.removeEventListener("agent.run", onRun as EventListener);
      source.removeEventListener("ready", onReady);
      source.close();
    };
  }, []);
}
