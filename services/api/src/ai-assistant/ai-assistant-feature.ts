import type { FeatureDeps, FeatureModule } from "../feature-module.js";
import type { StreamDeps } from "./ai-assistant-stream.js";
import { streamAiAssistant } from "./ai-assistant-stream.js";

/**
 * Universal AI Assistant Feature — mounts the `/api/ai-assistant` endpoint.
 *
 * Replaces the old `/api/scripts/ai-assistant` with a unified endpoint that
 * supports all assistant modes via a `mode` field in the request body.
 */
export function createAiAssistantFeature(
  streamDeps: StreamDeps,
): FeatureModule {
  return {
    id: "ai-assistant",

    activate({ router }: FeatureDeps): void {
      router.post("/api/ai-assistant", async (c) => {
        const body = await c.req.json();
        const stream = streamAiAssistant(body, streamDeps);

        return new Response(
          new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder();
              for await (const chunk of stream) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
                );
              }
              controller.close();
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
