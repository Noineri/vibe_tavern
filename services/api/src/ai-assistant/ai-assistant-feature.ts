import type { FeatureDeps, FeatureModule } from "../feature-module.js";
import type { AiAssistantRuntimeApi } from "../api/contract/runtime-api.js";

/**
 * Universal AI Assistant Feature — mounts the single `/api/ai-assistant` endpoint.
 */
export function createAiAssistantFeature(
  runtime: AiAssistantRuntimeApi,
): FeatureModule {
  return {
    id: "ai-assistant",

    activate({ router }: FeatureDeps): void {
      router.post("/api/ai-assistant/tokens", async (c) => {
        const body = await c.req.json();
        return c.json(await runtime.countAiAssistantTokens(body));
      });

      router.post("/api/ai-assistant", async (c) => {
        const body = await c.req.json();
        const stream = runtime.streamAiAssistant(body);

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
