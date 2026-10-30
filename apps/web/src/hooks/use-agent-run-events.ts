import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { isRecord, type AgentThreadOwner } from "@vibe-tavern/domain";
import { getGatewayBaseUrl } from "../api/client.js";
import { appendTokenQuery } from "../lib/mobile-token.js";
import { getAgentHost } from "../lib/agent-host-registry.js";
import { isAgentThreadVisible } from "../lib/agent-run-visibility.js";
import { useT } from "../i18n/context.js";
import { openCoauthorChat } from "../lib/agent-host-navigation.js";

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
    const source = new EventSource(appendTokenQuery(`${getGatewayBaseUrl()}/api/agent-runs/events`));
    const onRun = (message: MessageEvent) => {
      if (!mounted) return;
      let event: unknown;
      try { event = JSON.parse(message.data); } catch { return; }
      if (!isRecord(event) || typeof event.threadId !== "string" || event.threadId.length === 0 || typeof event.kind !== "string" || typeof event.title !== "string") return;
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
    source.addEventListener("agent.run", onRun as EventListener);
    return () => {
      mounted = false;
      source.removeEventListener("agent.run", onRun as EventListener);
      source.close();
    };
  }, []);
}
