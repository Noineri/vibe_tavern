import { describe, expect, test } from "bun:test";
import { createDb } from "../src/db-connection.js";
import { cachedModels, providerProfiles } from "../src/db-schema.js";
import { ProviderStore } from "../src/stores/provider-store.js";

describe("ProviderStore cached model capabilities", () => {
  test("normalizes legacy thinking JSON to canonical reasoning on read", async () => {
    const db = await createDb(":memory:");
    await db.insert(providerProfiles).values({
      id: "prov_1", name: "Provider", sortOrder: 0, providerPreset: "openai", endpoint: "https://example.test",
      apiKey: null, defaultModel: null, contextBudget: null, maxTokens: 2000, temperature: 1, topP: 1,
      topK: 0, minP: 0, topA: 0, typicalP: 1, tfsZ: 1, repeatLastN: 0, mirostat: 0,
      mirostatTau: 5, mirostatEta: 0.1, dryMultiplier: 0, dryBase: 1.75, dryAllowedLength: 2,
      drySequenceBreakersJson: null, xtcThreshold: 0.1, xtcProbability: 0, frequencyPenalty: 0,
      presencePenalty: 0, repetitionPenalty: 1, stopSequencesJson: null, logitBiasJson: null, seed: null,
      reasoningEffort: "auto", showReasoning: 0, streamResponse: 1, customSamplers: 0, pinContextBudget: 0,
      bindPerModel: 0, visionModel: null, isActive: 0, createdAt: "t", updatedAt: "t",
    }).run();
    await db.insert(cachedModels).values({
      id: "cached_1", providerProfileId: "prov_1", modelSlug: "model", modelName: "Model",
      contextLength: null, capabilitiesJson: JSON.stringify({ thinking: true, tools: false }), fetchedAt: "t",
    }).run();

    const models = await new ProviderStore(db).getCachedModels("prov_1");

    expect(models[0]?.capabilities).toEqual({ reasoning: true, tools: false });
  });
});
