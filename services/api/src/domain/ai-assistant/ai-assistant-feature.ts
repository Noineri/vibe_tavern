import { zValidator } from "@hono/zod-validator";
import { aiAssistantRequestSchema, regexAssistRequestSchema } from "@vibe-tavern/api-contracts";
import type { FeatureDeps, FeatureModule } from "../../shared/feature-module.js";
import type { AiAssistantRuntimeApi } from "../../api/contract/runtime-api.js";

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
        const stream = runtime.streamAiAssistant(c.req.valid("json"));

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
