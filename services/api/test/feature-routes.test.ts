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

  test("ai-assistant stream aborts the runtime and stops pumping when the client aborts", async () => {
    const clientController = new AbortController();
    let runtimeSignal: AbortSignal | undefined;
    const TOTAL_CHUNKS = 40;
    const runtime = {
      // Deliberately uncooperative: ignores the signal and keeps yielding, so
      // the pin is on the ROUTE — it must pass an abortable signal and break
      // out of the pump instead of draining the whole generator.
      async *streamAiAssistant(_body: unknown, signal?: AbortSignal) {
        runtimeSignal = signal;
        for (let i = 0; i < TOTAL_CHUNKS; i++) {
          yield { type: "text", text: `chunk-${i}` };
          await Bun.sleep(4);
        }
      },
    } as unknown as AiAssistantRuntimeApi;

    const events = new EventBus();
    const features = new FeatureRegistry();
    features.register(createAiAssistantFeature(runtime));
    const app = await createApp({
      runtime,
      configureFeatures: (router) => features.activateAll({ events, router }),
    });

    const request = new Request("http://localhost/api/ai-assistant", {
      method: "POST",
      body: JSON.stringify({ mode: "script", instruction: "test", providerProfileId: "profile-1", enabledLayers: [] }),
      headers: { "Content-Type": "application/json" },
      signal: clientController.signal,
    });
    const response = await app.request(request);
    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let wire = "";
    const textFrames = () => (wire.match(/"type":"text"/g) ?? []).length;
    // Read until at least two frames landed, then abort the client.
    while (textFrames() < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      wire += decoder.decode(value, { stream: true });
    }
    clientController.abort();
    // Drain whatever the route still had in flight until it closes the stream.
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      wire += decoder.decode(value, { stream: true });
    }

    expect(runtimeSignal).toBeDefined();
    expect(runtimeSignal?.aborted).toBe(true);
    expect(textFrames()).toBeLessThan(TOTAL_CHUNKS / 2);

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
