import { streamSSE } from "hono/streaming";
import type { FeatureModule, FeatureDeps } from "../../shared/feature-module.js";
import type { ChatNotification } from "@vibe-tavern/domain";
import { logSendDebug } from "../../shared/send-debug-log.js";

// ────────────────────────────────────────────────────────────────────────────
// Chat Events Feature — reusable per-chat SSE channel (W7 / SPC-7a)
// ────────────────────────────────────────────────────────────────────────────
// Mounts GET /api/chats/:chatId/events and forwards typed `chat.notification`
// EventBus events to the browser as Server-Sent Events. Auto-summary is the
// first producer of these notifications (see chat-summary-service.ts); the
// transport is intentionally generic so future background events (script-error,
// insights-done, scene-ready…) ride the same channel by adding a variant to
// `ChatNotification` — no new endpoint.
//
// Lifecycle: each request subscribes to the bus filtered by chatId and stays
// open until the client disconnects. A per-connection AbortController
// unsubscribes on disconnect or on a failed write so handlers never leak.
// ────────────────────────────────────────────────────────────────────────────

export function createChatEventsFeature(): FeatureModule {
  return {
    id: "chat-events",

    activate({ events, router }: FeatureDeps): void {
      router.get("/api/chats/:chatId/events", (c) => {
        const chatId = c.req.param("chatId");

        return streamSSE(c, async (stream) => {
          // Per-connection abort controller. Fires when the client disconnects
          // (Hono surfaces request abort via stream.onAbort) or a write fails;
          // the bus subscription auto-unsubscribes via the signal.
          const controller = new AbortController();
          stream.onAbort(() => controller.abort());

          // Initial handshake: flushes the response headers immediately so the
          // client's EventSource transitions to OPEN right away (and so the
          // response object resolves in tests) rather than waiting for the
          // first background event.
          await stream.writeSSE({ event: "ready", data: "{}" });

          events.on(
            "chat.notification",
            (n: ChatNotification) => {
              if (controller.signal.aborted || n.chatId !== chatId) return;
              const { chatId: _chatId, kind, ...rest } = n;
              void stream
                .writeSSE({ event: kind, data: JSON.stringify(rest) })
                .catch((err: unknown) => {
                  logSendDebug("chat.events.write.error", {
                    chatId,
                    message: err instanceof Error ? err.message : String(err),
                  });
                  controller.abort();
                });
            },
            { signal: controller.signal },
          );

          // Keep the SSE response open until the client disconnects. Without
          // this await the handler returns immediately and Hono closes the
          // connection before any event can be forwarded.
          await new Promise<void>((resolve) => {
            if (controller.signal.aborted) return resolve();
            controller.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        });
      });
    },

    deactivate(): void {
      // Routes live on the shared router; nothing per-instance to clean up.
    },
  };
}
