import { describe, expect, test } from "bun:test";
import { EventBus } from "@vibe-tavern/domain";
import { createApp } from "../src/server/app-factory.js";
import { FeatureRegistry } from "../src/feature-registry.js";
import { createScriptAiFeature } from "../src/scripts-engine/script-ai-feature.js";
import type { RuntimeApi } from "../src/routes/types.js";

describe("feature routes", () => {
  test("mount before final catch-all", async () => {
    const runtime = {
      async *streamScriptAiAssistant() {
        yield { type: "done" };
      },
    } as unknown as RuntimeApi;

    const events = new EventBus();
    const features = new FeatureRegistry();
    features.register(createScriptAiFeature(runtime));

    const app = await createApp({
      runtime,
      configureFeatures: (router) => features.activateAll({ events, router }),
    });

    const response = await app.request("/api/scripts/ai-assistant", {
      method: "POST",
      body: JSON.stringify({ prompt: "test", providerProfileId: "profile-1" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(await response.text()).toContain('"type":"done"');

    features.deactivateAll();
  });
});
