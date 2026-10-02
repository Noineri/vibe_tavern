import { zValidator } from "@hono/zod-validator";
import { aiAssistantRequestSchema, regexAssistRequestSchema } from "@vibe-tavern/api-contracts";
import type { FeatureDeps, FeatureModule } from "../../shared/feature-module.js";
import type { AiAssistantRuntimeApi } from "../../api/contract/runtime-api.js";
import { logSendDebug } from "../../shared/send-debug-log.js";

/** Fork of the chat.ts / experience-copilot.ts route-abort bridge: one
 *  AbortController per request, tripped either by the client disconnect
 *  (c.req.raw.signal) or by response-stream teardown (ReadableStream.cancel). */
function createRouteAbortBridge(requestSignal: AbortSignal) {
  const controller = new AbortController();
  const abort = (source: string) => {
    if (controller.signal.aborted) return;
    logSendDebug("api.ai-assistant.abort", { source });
    controller.abort(new DOMException("Client closed AI assistant stream", "AbortError"));
  };
  const onRequestAbort = () => abort("request");

  if (requestSignal.aborted) {
    abort("request-preaborted");
  } else {
    requestSignal.addEventListener("abort", onRequestAbort, { once: true });
  }

  return {
    signal: controller.signal,
    abort,
    cleanup: () => requestSignal.removeEventListener("abort", onRequestAbort),
  };
}

/**
 * Universal AI Assistant Feature — mounts the single `/api/ai-assistant` endpoint.
 */
export function createAiAssistantFeature(
  runtime: AiAssistantRuntimeApi,
): FeatureModule {
  return {
    id: "ai-assistant",

    activate({ router }: FeatureDeps): void {
      router.post("/api/ai-assistant/tokens", zValidator("json", aiAssistantRequestSchema), async (c) => {
        return c.json(await runtime.countAiAssistantTokens(c.req.valid("json")));
      });

      router.post("/api/ai/regex-assist", zValidator("json", regexAssistRequestSchema), async (c) => {
        return c.json(await runtime.regexAssist(c.req.valid("json")));
      });

      router.post("/api/ai-assistant", zValidator("json", aiAssistantRequestSchema), async (c) => {
        const abortBridge = createRouteAbortBridge(c.req.raw.signal);
        const stream = runtime.streamAiAssistant(c.req.valid("json"), abortBridge.signal);

        return new Response(
          new ReadableStream({
            cancel() {
              abortBridge.abort("stream-cancelled");
            },
            async start(controller) {
              const encoder = new TextEncoder();
              try {
                for await (const chunk of stream) {
                  if (abortBridge.signal.aborted) break;
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
                  );
                }
              } catch {
                // Enqueue into a torn-down stream (client already gone) — nothing to deliver.
              } finally {
                abortBridge.cleanup();
                try {
                  controller.close();
                } catch {
                  // Already closed by cancel() — fine.
                }
              }
            },
          }),
          {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          },
        );
      });
    },

    deactivate(): void {
      // Hono does not expose route unmounting; feature route lifecycle is app-scoped.
    },
  };
}
