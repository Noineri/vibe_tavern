import { describe, expect, test } from "bun:test";
import { EventBus } from "@vibe-tavern/domain";
import { createApp } from "../src/server/app-factory.js";
import { FeatureRegistry } from "../src/shared/feature-registry.js";
import { createAiAssistantFeature } from "../src/domain/ai-assistant/ai-assistant-feature.js";
import type { AiAssistantRuntimeApi } from "../src/api/contract/runtime-api.js";

describe("feature routes", () => {
  test("mount before final catch-all", async () => {
    const runtime = {
      async *streamAiAssistant() {
        yield { type: "done" };
      },
    } as unknown as AiAssistantRuntimeApi;

    const events = new EventBus();
    const features = new FeatureRegistry();
    features.register(createAiAssistantFeature(runtime));

    const app = await createApp({
      runtime,
      configureFeatures: (router) => features.activateAll({ events, router }),
    });

    const response = await app.request("/api/ai-assistant", {
      method: "POST",
      body: JSON.stringify({ mode: "script", instruction: "test", providerProfileId: "profile-1", enabledLayers: [] }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(await response.text()).toContain('"type":"done"');

    features.deactivateAll();
  });

  test("ai-assistant routes reject a body that fails aiAssistantRequestSchema", async () => {
    let streamed = false;
    let counted = false;
    const runtime = {
      async *streamAiAssistant() {
        streamed = true;
        yield { type: "done" };
      },
      async countAiAssistantTokens() {
        counted = true;
        return { tokens: 0, model: "m", layerCount: 0, messageCount: 0, activatedLoreCount: 0 };
      },
    } as unknown as AiAssistantRuntimeApi;

    const events = new EventBus();
    const features = new FeatureRegistry();
    features.register(createAiAssistantFeature(runtime));
    const app = await createApp({
      runtime,
      configureFeatures: (router) => features.activateAll({ events, router }),
    });

    for (const path of ["/api/ai-assistant", "/api/ai-assistant/tokens"]) {
      const response = await app.request(path, {
        method: "POST",
        body: JSON.stringify({ mode: "not_a_mode", instruction: "test" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(response.status).toBe(400);
    }
    expect(streamed).toBe(false);
    expect(counted).toBe(false);

    features.deactivateAll();
  });
});
