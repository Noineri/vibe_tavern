import { useEffect } from "react";
import { toast } from "sonner";
import { useT } from "../i18n/context.js";
import { useChatNotifications, useModalStore } from "../stores/index.js";

// ────────────────────────────────────────────────────────────────────────────
// useChatEvents — per-chat SSE subscription (W7 / SPC-7b)
// ────────────────────────────────────────────────────────────────────────────
// Opens an EventSource on the reusable `GET /api/chats/:chatId/events` channel
// for the active chat and dispatches typed notifications to UI state. The
// auto-summary lifecycle drives the memory badge:
//   • `summary.started`   → badge flips to the spinner (generating)
//   • `summary.generated` → badge flips to the checkmark (ready) + a sonner
//     toast with a "review" action that opens the ContextMemory modal
//   • `summary.failed`    → badge back to idle + an error toast
//
// Mounted once at the app-shell level (always mounted while a chat is active),
// so there is exactly one subscription per active chat. On chat change the
// previous EventSource is closed before the new one opens; on unmount it closes
// too — no leaks across chats.
//
// EventSource auto-reconnects on transient network errors (browser default);
// those are not surfaced — a flaky connection is not worth a user notification.
// ────────────────────────────────────────────────────────────────────────────

interface SummaryGeneratedPayload {
  summaryId: string;
  label: string;
}

export function useChatEvents(activeChatId: string | null): void {
  const { t } = useT();

  useEffect(() => {
    if (!activeChatId) return;

    const eventSource = new EventSource(`/api/chats/${activeChatId}/events`);
    const { setGenerating, setReady, setIdle } = useChatNotifications.getState();
    const setContextMemoryOpen = useModalStore.getState().setContextMemoryOpen;

    const onStarted = () => setGenerating();

    const onGenerated = (event: MessageEvent) => {
      let payload: SummaryGeneratedPayload;
      try {
        payload = JSON.parse(event.data) as SummaryGeneratedPayload;
      } catch {
        return;
      }
      if (!payload.summaryId) return;
      setReady(payload.summaryId, payload.label ?? "");
      toast.success(t("summary_generated_toast", { label: payload.label ?? "" }), {
        action: {
          label: t("summary_review"),
          onClick: () => setContextMemoryOpen(true),
        },
      });
    };

    const onFailed = () => {
      setIdle();
      toast.error(t("summary_failed_toast"));
    };

    eventSource.addEventListener("summary.started", onStarted as EventListener);
    eventSource.addEventListener("summary.generated", onGenerated as EventListener);
    eventSource.addEventListener("summary.failed", onFailed as EventListener);

    return () => {
      eventSource.close();
    };
  }, [activeChatId, t]);
}
