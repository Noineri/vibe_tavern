import { useEffect, useRef } from "react";
import { brandId, type ChatId } from "@vibe-tavern/domain";
import { toast } from "sonner";
import { useT } from "../i18n/context.js";
import { useChatNotifications, useModalStore } from "../stores/index.js";
import { useChatStore } from "../stores/chat-store.js";
import { switchChatAction } from "../stores/api-actions/chat-actions.js";
import { publishChatSummaryEvent } from "../lib/chat-summary-events.js";
import { useGenerationQueueStore } from "../stores/generation-queue-store.js";
import { refreshGenerationQueue } from "../lib/chat-generation-queue-client.js";
import { getGatewayBaseUrl } from "../api/client.js";
import { appendTokenQuery } from "../lib/mobile-token.js";

// ────────────────────────────────────────────────────────────────────────────
// useChatEvents — per-chat SSE subscription (W7 / SPC-7b)
// ────────────────────────────────────────────────────────────────────────────
// Opens an EventSource on the reusable `GET /api/chats/:chatId/events` channel
// for each watched chat and dispatches typed notifications to chat-scoped state.
// Manual and automatic summary lifecycles drive the existing memory badge:
//   • `summary.started`   → badge flips to the spinner (generating)
//   • `summary.generated` → badge flips to the checkmark (ready) + a sonner
//     toast with a "review" action that opens the ContextMemory modal
//   • `summary.failed`    → badge back to idle + an error toast
//   • `summary.cancelled` → badge back to idle, without a toast
//
// Mounted once at the app-shell level. One channel per watched chat: the active
// one, plus background chats with active queue jobs, summaries or local requests.
// Idle background channels close; unmount closes all of them. Returning during
// a run reuses its existing channel instead of losing completion notifications.
//
// EventSource auto-reconnects on transient network errors (browser default);
// those are not surfaced — a flaky connection is not worth a user notification.
// ────────────────────────────────────────────────────────────────────────────

interface SummaryGeneratedPayload {
  summaryId: string;
  label: string;
  source?: "manual";
}

function manualSource(event: MessageEvent): "manual" | undefined {
  try {
    return JSON.parse(event.data)?.source === "manual" ? "manual" : undefined;
  } catch {
    return undefined;
  }
}

export function useChatEvents(activeChatId: string | null): void {
  const { t } = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const sources = useRef(new Map<string, EventSource>());
  const byChat = useChatNotifications((state) => state.byChat);
  const holdsByChat = useChatNotifications((state) => state.holdsByChat);
  const jobsByChat = useGenerationQueueStore((state) => state.jobsByChat);

  useEffect(() => {
    const watched = new Set<string>();
    if (activeChatId) watched.add(activeChatId);
    for (const [chatId, jobs] of Object.entries(jobsByChat)) {
      if (jobs.some((job) => job.status === "running" || job.status === "pending")) watched.add(chatId);
    }
    for (const [chatId, state] of Object.entries(byChat)) {
      if (state.pending > 0) watched.add(chatId);
    }
    for (const [chatId, holds] of Object.entries(holdsByChat)) {
      if (holds > 0) watched.add(chatId);
    }
    for (const [chatId, source] of sources.current) {
      if (watched.has(chatId)) continue;
      sources.current.delete(chatId);
      source.close();
    }

    for (const chatId of watched) {
      if (sources.current.has(chatId)) continue;
      const eventSource = new EventSource(appendTokenQuery(`${getGatewayBaseUrl()}/api/chats/${chatId}/events`));
      sources.current.set(chatId, eventSource);
      const isCurrent = () => sources.current.get(chatId) === eventSource;
      const { setGenerating, setReady, settle } = useChatNotifications.getState();
      const onStarted = (event: MessageEvent) => {
        if (!isCurrent()) return;
        setGenerating(chatId);
        publishChatSummaryEvent({ chatId, kind: "summary.started", source: manualSource(event) });
      };

      const onGenerated = (event: MessageEvent) => {
        if (!isCurrent()) return;
        let payload: SummaryGeneratedPayload;
        try {
          payload = JSON.parse(event.data) as SummaryGeneratedPayload;
        } catch {
          return;
        }
        if (!payload?.summaryId) return;
        setReady(chatId, payload.summaryId, payload.label ?? "");
        publishChatSummaryEvent({ chatId, kind: "summary.generated", summaryId: payload.summaryId, label: payload.label ?? "", source: payload.source });
        if (payload.source === "manual" && useChatStore.getState().activeChatId === chatId && useModalStore.getState().isContextMemoryOpen) return;
        toast.success(tRef.current("summary_generated_toast", { label: payload.label ?? "" }), {
          action: {
            label: tRef.current("summary_review"),
            onClick: async () => {
              try {
                if (useChatStore.getState().activeChatId !== chatId) {
                  await switchChatAction(brandId<ChatId>(chatId));
                  useChatStore.getState().setActiveChatId(brandId<ChatId>(chatId));
                }
                useModalStore.getState().setContextMemoryOpen(true);
              } catch (error) {
                toast.error(error instanceof Error ? error.message : tRef.current("request_failed"));
              }
            },
          },
        });
      };

      const onFailed = (event: MessageEvent) => {
        if (!isCurrent()) return;
        settle(chatId);
        publishChatSummaryEvent({ chatId, kind: "summary.failed", source: manualSource(event) });
        toast.error(tRef.current("summary_failed_toast"));
      };
      const onCancelled = () => {
        if (!isCurrent()) return;
        settle(chatId);
        publishChatSummaryEvent({ chatId, kind: "summary.cancelled", source: "manual" });
      };

      eventSource.addEventListener("summary.started", onStarted as EventListener);
      eventSource.addEventListener("summary.generated", onGenerated as EventListener);
      eventSource.addEventListener("summary.failed", onFailed as EventListener);
      eventSource.addEventListener("summary.cancelled", onCancelled as EventListener);
      const onQueue = () => {
        if (isCurrent()) void refreshGenerationQueue(chatId).catch((error: unknown) => console.warn("[chat-queue] refresh failed", error));
      };
      eventSource.addEventListener("queue.updated", onQueue);
      eventSource.addEventListener("ready", onQueue);
    }
  }, [activeChatId, byChat, holdsByChat, jobsByChat]);

  useEffect(() => {
    const current = sources.current;
    return () => {
      for (const source of current.values()) source.close();
      current.clear();
    };
  }, []);
}
