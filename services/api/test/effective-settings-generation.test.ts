import { describe, it, expect } from "bun:test";
import { resolveEffectiveSettings, type StoredProviderProfileRecord, type ModelSettingsOverlay } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import type { AssetService } from "../src/domain/asset/asset-service.js";
import type { ChatSummaryService } from "../src/domain/chat/chat-summary-service.js";
import type { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import type { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import { ChatAdapter } from "../src/api/adapters/chat-adapter.js";
import { buildSamplerConfig } from "../src/infrastructure/ai/sampler-mapper.js";
import { makeProviderProfileRow } from "./copilot-test-builders.js";
import { strictTestDouble } from "./strict-test-double.js";

/**
 * Generation-boundary integration test for per-model binding.
 *
 * The chat-adapter's resolveEffectiveProfileOrThrow composes exactly:
 *   effectiveProfile = resolveEffectiveSettings(baseProfile, overlayForDefaultModel)
 *   samplerConfig    = buildSamplerConfig(effectiveProfile)
 *
 * This test pins the end-to-end invariant: a bound model's overlay values
 * (temperature, contextBudget, pinContextBudget, samplers) reach the provider
 * executor, while absent overlay fields inherit the base. This is the
 * highest-risk wave (V6 blast radius) — if this composition breaks, the entire
 * per-model binding feature is silently inert at generation time.
 */

function makeBase(over: Partial<StoredProviderProfileRecord> = {}): StoredProviderProfileRecord {
  return makeProviderProfileRow({
    id: "prov_1", name: "base", providerPreset: "openaiCompat",
    endpoint: "http://localhost", apiKey: "sk-test",
    defaultModel: "gpt-4o",
    contextBudget: 16000, pinContextBudget: false, bindPerModel: true,
    maxTokens: 2000, temperature: 1, topP: 1, topK: 0, minP: 0, topA: 0,
    typicalP: 1, tfsZ: 1, repeatLastN: 0, mirostat: 0, mirostatTau: 5, mirostatEta: 0.1,
    dryMultiplier: 0, dryBase: 1.75, dryAllowedLength: 2, drySequenceBreakers: [],
    xtcThreshold: 0.1, xtcProbability: 0, frequencyPenalty: 0, presencePenalty: 0,
    repetitionPenalty: 1, stopSequences: [], logitBias: [], seed: null,
    reasoningEffort: "auto", showReasoning: false, streamResponse: true,
    customSamplers: true, isActive: true, visionModel: null,
    createdAt: "0", updatedAt: "0",
    ...over,
  });
}

describe("generation-boundary: overlay reaches buildSamplerConfig", () => {
  it("overlay overrides base contextBudget on effective profile and temperature reaches SamplerConfig", () => {
    const base = makeBase({ temperature: 1, contextBudget: 16000 });
    const overlay: ModelSettingsOverlay = { temperature: 0.3, contextBudget: 8000 };
    const effective = resolveEffectiveSettings(base, overlay);
    const config = buildSamplerConfig(effective);
    expect(effective.contextBudget).toBe(8000); // overlay won on effective profile
    expect(config.temperature).toBe(0.3); // overlay won at executor
  });

  it("absent overlay fields inherit the base (topP not overridden)", () => {
    const base = makeBase({ temperature: 1, topP: 0.9 });
    const overlay: ModelSettingsOverlay = { temperature: 0.5 }; // no topP
    const effective = resolveEffectiveSettings(base, overlay);
    const config = buildSamplerConfig(effective);
    expect(config.temperature).toBe(0.5); // overlay
    // topP inherited — buildSamplerConfig still sees the base value.
    expect(effective.topP).toBe(0.9);
  });

  it("null overlay (no bound settings for this model) = pure base at the executor", () => {
    const base = makeBase({ temperature: 0.7 });
    const effective = resolveEffectiveSettings(base, null);
    expect(effective).toBe(base); // same ref — no work done
    const config = buildSamplerConfig(effective);
    expect(config.temperature).toBe(0.7);
  });

  it("overlay maxTokens overrides base maxOutputTokens", () => {
    const base = makeBase({ maxTokens: 2000 });
    const overlay: ModelSettingsOverlay = { maxTokens: 8192 };
    const effective = resolveEffectiveSettings(base, overlay);
    const config = buildSamplerConfig(effective);
    expect(config.maxOutputTokens).toBe(8192);
  });

  it("overlay stopSequences replaces base wholesale (not merged)", () => {
    const base = makeBase({ stopSequences: ["<end>", "<stop>"] });
    const overlay: ModelSettingsOverlay = { stopSequences: ["\\n\\nUser:"] };
    const effective = resolveEffectiveSettings(base, overlay);
    const config = buildSamplerConfig(effective);
    expect(config.stopSequences).toEqual(["\\n\\nUser:"]);
  });

  it("identity fields (endpoint, apiKey, defaultModel) never change through the overlay", () => {
    const base = makeBase({ endpoint: "https://a/v1", apiKey: "key", defaultModel: "gpt-4o" });
    const overlay: ModelSettingsOverlay = { temperature: 0.5 };
    const effective = resolveEffectiveSettings(base, overlay);
    expect(effective.endpoint).toBe("https://a/v1");
    expect(effective.apiKey).toBe("key");
    expect(effective.defaultModel).toBe("gpt-4o");
  });

  it("bindPerModel=false path: adapter skips overlay entirely (base reaches executor)", async () => {
    // Drives the real ChatAdapter resolver with a bound overlay seeded for the
    // model: bindPerModel=false must skip getProviderModelSettings completely so
    // the base temperature reaches buildSamplerConfig unchanged.
    const base = makeBase({ bindPerModel: false, temperature: 0.8 });
    const requestedFor: string[] = [];
    const service = strictTestDouble<ProviderProfileService>(
      {
        resolveActiveProviderProfile: async () => base,
        getProviderModelSettings: async (_providerProfileId, modelId) => {
          requestedFor.push(modelId);
          return {
            id: `pms_${modelId}`,
            providerProfileId: base.id,
            modelId,
            settings: { temperature: 0.1 },
            createdAt: "0",
            updatedAt: "0",
          };
        },
      },
      "effective-settings ProviderProfileService",
    );
    const adapter = new ChatAdapter(
      strictTestDouble<StoreContainer>({}, "ChatAdapter stores (bindPerModel=false test)"),
      strictTestDouble<SessionRuntime>({}, "ChatAdapter sessionRuntime (bindPerModel=false test)"),
      strictTestDouble<LiveChatOrchestrator>({}, "ChatAdapter liveChatOrchestrator (bindPerModel=false test)"),
      strictTestDouble<ChatSummaryService>({}, "ChatAdapter chatSummaryService (bindPerModel=false test)"),
      service,
      strictTestDouble<AssetService>({}, "ChatAdapter assetService (bindPerModel=false test)"),
      async () => {
        throw new Error("transcribeSttAudio unused");
      },
    );
    const resolveEffectiveProfileOrThrow: (options?: {
      chatId?: string;
      modelOverride?: string | null;
    }) => Promise<{ profile: StoredProviderProfileRecord }> = Reflect.get(
      ChatAdapter.prototype,
      "resolveEffectiveProfileOrThrow",
    );

    const { profile: effective } = await resolveEffectiveProfileOrThrow.call(adapter);
    const config = buildSamplerConfig(effective);
    expect(requestedFor).toEqual([]);
    expect(config.temperature).toBe(0.8);
  });
});
