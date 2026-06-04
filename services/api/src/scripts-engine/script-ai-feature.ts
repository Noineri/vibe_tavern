import type { FeatureDeps, FeatureModule } from "../feature-module.js";
import type { RuntimeApi } from "../routes/types.js";

/**
 * Script AI Feature — mounts the AI code assistant endpoint as a FeatureModule.
 *
 * Keeping this endpoint as a feature proves that AI-assistant extensions can add
 * server routes without modifying the monolithic route factory.
 */
export function createScriptAiFeature(runtime: Pick<RuntimeApi, "streamScriptAiAssistant">): FeatureModule {
  return {
    id: "script-ai",

    activate({ router }: FeatureDeps): void {
      router.post("/api/scripts/ai-assistant", async (c) => {
        const body = await c.req.json();
        const stream = runtime.streamScriptAiAssistant(body);

        return new Response(
          new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder();
              for await (const chunk of stream) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
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
