import { describe, it, expect } from "bun:test";
import {
  COAUTHOR_GENERATION_DEFAULTS,
  resolveEffectiveSettings,
  type ModelSettingsOverlay,
  type StoredProviderProfileRecord,
} from "@vibe-tavern/domain";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import type { LiveChatOrchestrator } from "../src/domain/chat/live-chat-orchestrator.js";
import type { ChatSummaryService } from "../src/domain/chat/chat-summary-service.js";
import type { AssetService } from "../src/domain/asset/asset-service.js";
import { ChatAdapter } from "../src/api/adapters/chat-adapter.js";

/**
 * Characterization test for the per-request MODEL OVERRIDE path (Wave Q1a).
 *
 * The chat-adapter's `resolveEffectiveProfileOrThrow(modelOverride?)` is the
 * generation-boundary chokepoint. When the queue/regenerate supplies an
 * override model, the overlay MUST be loaded for THAT model (not the profile's
 * defaultModel) — otherwise the override model's per-model samplers/budget
 * (Waves 0-6) are silently lost and the queue collides with per-model binding.
 *
 * This test pins two invariants:
 *  1. No override → identical behavior to today (overlay for defaultModel,
 *     defaultModel re-pinned to base).
 *  2. Override → overlay fetched for the override model; returned profile's
 *     defaultModel === override; overlay values (temperature) come from the
 *     override model's overlay.
 */

function makeBase(over: Partial<StoredProviderProfileRecord> = {}): StoredProviderProfileRecord {
  return {
    id: "prof_1", name: "base", providerPreset: "openaiCompat",
    coauthorTransport: "chat_completions",
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
  };
}

/** Tracks which modelId the adapter requested an overlay for, per model. */
function makeProfileService(opts: {
  base?: StoredProviderProfileRecord;
  overlays?: Record<string, ModelSettingsOverlay | null>;
  /** Extra profiles resolvable by id (for Co-Author binding tests). */
  profilesById?: Record<string, StoredProviderProfileRecord>;
}): { service: ProviderProfileService; requestedFor: string[] } {
  const base = opts.base ?? makeBase();
  const requestedFor: string[] = [];
  const service = {
    resolveActiveProviderProfile: async () => base,
    getProviderProfile: async (id: string) => opts.profilesById?.[id] ?? null,
    getProviderModelSettings: async (_providerProfileId: string, modelId: string) => {
      requestedFor.push(modelId);
      const overlay = opts.overlays?.[modelId];
      if (overlay === undefined) return null;
      return { settings: overlay } as never;
    },
  } as unknown as ProviderProfileService;
  return { service, requestedFor };
}

/** Typed accessor for the private generation-boundary method (test-only). */
type AdapterInternals = {
  resolveEffectiveProfileOrThrow(options?: { chatId?: string; modelOverride?: string | null }): Promise<{ profile: StoredProviderProfileRecord; transport: import("@vibe-tavern/domain").CoauthorTransport }>;
};

function makeAdapter(service: ProviderProfileService, stores?: Partial<Pick<StoreContainer, "coauthorSettings" | "uiSettings" | "chats">>): AdapterInternals {
  // The other five constructor deps are never touched by the resolver.
  return new ChatAdapter(
    (stores ?? null) as unknown as StoreContainer,
    null as unknown as SessionRuntime,
    null as unknown as LiveChatOrchestrator,
    null as unknown as ChatSummaryService,
    service,
    null as unknown as AssetService,
  ) as unknown as AdapterInternals;
}

describe("Q1a: resolveEffectiveProfileOrThrow(modelOverride?)", () => {
  it("no override → overlay fetched for defaultModel, defaultModel re-pinned to base (unchanged behavior)", async () => {
    const { service, requestedFor } = makeProfileService({
      overlays: { "gpt-4o": { temperature: 0.4 } },
    });
    const adapter = makeAdapter(service);

    const { profile: effective } = await adapter.resolveEffectiveProfileOrThrow();

    expect(requestedFor).toEqual(["gpt-4o"]);
    expect(effective.defaultModel).toBe("gpt-4o");
    expect(effective.temperature).toBe(0.4); // overlay applied
  });

  it("override model → overlay fetched for the OVERRIDE model, not the defaultModel", async () => {
    const { service, requestedFor } = makeProfileService({
      overlays: {
        "gpt-4o": { temperature: 0.4 },
        "claude-sonnet": { temperature: 0.1, contextBudget: 200000 },
      },
    });
    const adapter = makeAdapter(service);

    const { profile: effective } = await adapter.resolveEffectiveProfileOrThrow({ modelOverride: "claude-sonnet" });

    expect(requestedFor).toEqual(["claude-sonnet"]); // NOT "gpt-4o" — the critical invariant
    expect(effective.defaultModel).toBe("claude-sonnet"); // override becomes the target model
    expect(effective.temperature).toBe(0.1); // override model's overlay won
    expect(effective.contextBudget).toBe(200000);
  });

  it("override model with NO bound overlay → base inherited, defaultModel === override", async () => {
    const { service, requestedFor } = makeProfileService({
      base: makeBase({ temperature: 0.7 }),
      overlays: {}, // no overlay for the override model
    });
    const adapter = makeAdapter(service);

    const { profile: effective } = await adapter.resolveEffectiveProfileOrThrow({ modelOverride: "some-unbound-model" });

    expect(requestedFor).toEqual(["some-unbound-model"]);
    expect(effective.defaultModel).toBe("some-unbound-model");
    expect(effective.temperature).toBe(0.7); // base inherited (null overlay)
  });

  it("override model when bindPerModel=false → no overlay lookup at all, defaultModel === override", async () => {
    const { service, requestedFor } = makeProfileService({
      base: makeBase({ bindPerModel: false, temperature: 0.8 }),
    });
    const adapter = makeAdapter(service);

    const { profile: effective } = await adapter.resolveEffectiveProfileOrThrow({ modelOverride: "llama-3" });

    expect(requestedFor).toEqual([]); // bindPerModel off → skip overlay entirely
    expect(effective.defaultModel).toBe("llama-3");
    expect(effective.temperature).toBe(0.8); // pure base
  });

  it("no override when bindPerModel=false → base values returned, no overlay lookup", async () => {
    // Pins the exact early-return: with no override and binding off, the adapter
    // skips the overlay lookup entirely and returns the base profile's values.
    // (It still goes through resolveActiveProfileOrThrow which narrows defaultModel,
    // so we assert values + zero overlay requests, not reference identity.)
    const base = makeBase({ bindPerModel: false, temperature: 0.9, defaultModel: "gpt-4o" });
    const { service, requestedFor } = makeProfileService({ base });
    const adapter = makeAdapter(service);

    const { profile: effective } = await adapter.resolveEffectiveProfileOrThrow();

    expect(requestedFor).toEqual([]); // no overlay work
    expect(effective.defaultModel).toBe("gpt-4o");
    expect(effective.temperature).toBe(0.9); // base value, untouched
  });

  it("resolveEffectiveSettings composition is unaffected (regression guard for the pure helper)", () => {
    // Belt-and-suspenders: the override path still routes through the SAME pure
    // resolveEffectiveSettings as the no-override path, so overlay merge semantics
    // (stop-sequences replace, absent fields inherit) cannot diverge between paths.
    const base = makeBase({ temperature: 1, stopSequences: ["a"] });
    const overlay: ModelSettingsOverlay = { temperature: 0.2, stopSequences: ["b"] };
    expect(resolveEffectiveSettings(base, overlay).temperature).toBe(0.2);
    expect(resolveEffectiveSettings(base, overlay).stopSequences).toEqual(["b"]);
  });
});

// ─── Co-Author generation boundary (CG-2) ─────────────────────────────────

function makeStores(opts: {
  mode?: string;
  coauthorProviderId?: string | null;
  coauthorSettings?: { modelName: string | null; settings: ModelSettingsOverlay } | null;
}): Pick<StoreContainer, "coauthorSettings" | "uiSettings" | "chats"> {
  return {
    uiSettings: {
      get: async () => ({ coauthorProviderId: opts.coauthorProviderId ?? null }),
    },
    chats: {
      getById: async (_id: string) => ({ id: "chat_1", mode: opts.mode ?? "rp" }),
    },
    coauthorSettings: {
      getByProviderId: async (_id: string) => opts.coauthorSettings ?? null,
    },
  } as Pick<StoreContainer, "coauthorSettings" | "uiSettings" | "chats">;
}

describe("CG-2: Co-Author generation boundary", () => {
  const coauthorProfile = makeBase({
    id: "prof_coauthor",
    name: "coauthor-profile",
    endpoint: "https://coauthor.example/v1",
    apiKey: "coauthor-key",
    defaultModel: "coauthor-default",
    bindPerModel: true,
    tokenPadding: 999,
    contextBudget: 8_000,
    maxTokens: 111,
    temperature: 0.5,
    reasoningEffort: "high",
  });
  const rpProfile = makeBase({
    id: "prof_1",
    name: "rp-active",
    defaultModel: "gpt-4o",
    contextBudget: 16_000,
    maxTokens: 2_000,
    temperature: 1,
    reasoningEffort: "auto",
  });

  it("uses only the bound connection identity and its own generation set", async () => {
    const { service, requestedFor } = makeProfileService({
      base: rpProfile,
      profilesById: { prof_coauthor: coauthorProfile },
    });
    const adapter = makeAdapter(service, makeStores({
      mode: "coauthor",
      coauthorProviderId: "prof_coauthor",
      coauthorSettings: {
        modelName: "coauthor-model",
        settings: { temperature: 0.23, maxTokens: 1_200, contextBudget: 24_000, reasoningEffort: "low" },
      },
    }));

    const { profile: effective, transport } = await adapter.resolveEffectiveProfileOrThrow({ chatId: "chat_1", modelOverride: "ignored-model" });

    expect(effective.id).toBe("prof_coauthor");
    expect(effective.endpoint).toBe("https://coauthor.example/v1");
    expect(effective.apiKey).toBe("coauthor-key");
    expect(effective.defaultModel).toBe("coauthor-model");
    expect(effective.temperature).toBe(0.23);
    expect(effective.maxTokens).toBe(1_200);
    expect(effective.contextBudget).toBe(24_000);
    expect(effective.reasoningEffort).toBe("low");
    expect(effective.bindPerModel).toBe(false);
    expect(effective.tokenPadding).toBe(0);
    expect(transport).toBe("chat_completions");
    expect(requestedFor).toEqual([]);
  });

  it("is unchanged when RP temperature, limits, context budget, or reasoning change", async () => {
    const coauthorSettings = { modelName: "coauthor-model", settings: { temperature: 0.23, maxTokens: 1_200, contextBudget: 24_000, reasoningEffort: "low" } };
    const first = makeProfileService({ base: rpProfile, profilesById: { prof_coauthor: coauthorProfile } });
    const second = makeProfileService({
      base: makeBase({ temperature: 1.7, maxTokens: 9_000, contextBudget: 500_000, reasoningEffort: "high" }),
      profilesById: { prof_coauthor: coauthorProfile },
    });
    const stores = makeStores({ mode: "coauthor", coauthorProviderId: "prof_coauthor", coauthorSettings });

    const before = await makeAdapter(first.service, stores).resolveEffectiveProfileOrThrow({ chatId: "chat_1" });
    const after = await makeAdapter(second.service, stores).resolveEffectiveProfileOrThrow({ chatId: "chat_1" });

    expect(after.profile).toEqual(before.profile);
  });

  it("keeps each connection's settings independent", async () => {
    const secondProfile = makeBase({ id: "prof_second", defaultModel: "second-default", temperature: 0.91 });
    const first = makeProfileService({ base: rpProfile, profilesById: { prof_coauthor: coauthorProfile } });
    const second = makeProfileService({ base: rpProfile, profilesById: { prof_second: secondProfile } });

    const firstResolved = await makeAdapter(first.service, makeStores({
      mode: "coauthor",
      coauthorProviderId: "prof_coauthor",
      coauthorSettings: { modelName: "first-model", settings: { temperature: 0.11, maxTokens: 111 } },
    })).resolveEffectiveProfileOrThrow({ chatId: "chat_1" });
    const secondResolved = await makeAdapter(second.service, makeStores({
      mode: "coauthor",
      coauthorProviderId: "prof_second",
      coauthorSettings: { modelName: "second-model", settings: { temperature: 0.89, maxTokens: 222 } },
    })).resolveEffectiveProfileOrThrow({ chatId: "chat_1" });

    expect(firstResolved.profile.defaultModel).toBe("first-model");
    expect(firstResolved.profile.temperature).toBe(0.11);
    expect(firstResolved.profile.maxTokens).toBe(111);
    expect(secondResolved.profile.defaultModel).toBe("second-model");
    expect(secondResolved.profile.temperature).toBe(0.89);
    expect(secondResolved.profile.maxTokens).toBe(222);
  });

  it("uses Co-Author defaults when the bound connection has no settings row", async () => {
    const { service } = makeProfileService({ base: rpProfile, profilesById: { prof_coauthor: coauthorProfile } });
    const adapter = makeAdapter(service, makeStores({ mode: "coauthor", coauthorProviderId: "prof_coauthor" }));

    const { profile: effective } = await adapter.resolveEffectiveProfileOrThrow({ chatId: "chat_1" });

    expect(effective.defaultModel).toBe("coauthor-default");
    expect(effective.temperature).toBe(COAUTHOR_GENERATION_DEFAULTS.temperature);
    expect(effective.maxTokens).toBe(COAUTHOR_GENERATION_DEFAULTS.maxTokens);
    expect(effective.contextBudget).toBe(COAUTHOR_GENERATION_DEFAULTS.contextBudget);
  });

  it("fails closed with a stable code for unbound and deleted Co-Author connections", async () => {
    const calls: string[] = [];
    const { service } = makeProfileService({ base: rpProfile, profilesById: {} });
    (service as unknown as { resolveActiveProviderProfile: () => Promise<StoredProviderProfileRecord> }).resolveActiveProviderProfile = async () => {
      calls.push("rp");
      return rpProfile;
    };

    const unbound = makeAdapter(service, makeStores({ mode: "coauthor", coauthorProviderId: null }));
    const dangling = makeAdapter(service, makeStores({ mode: "coauthor", coauthorProviderId: "prof_deleted" }));

    for (const adapter of [unbound, dangling]) {
      await expect(adapter.resolveEffectiveProfileOrThrow({ chatId: "chat_1" })).rejects.toMatchObject({
        kind: "Validation",
        details: { code: "coauthor_model_required" },
      });
    }
    expect(calls).toEqual([]);
  });

  it("leaves RP requests on the existing per-model resolution path", async () => {
    const { service, requestedFor } = makeProfileService({
      base: rpProfile,
      profilesById: { prof_coauthor: coauthorProfile },
      overlays: { "gpt-4o": { temperature: 0.4 } },
    });
    const adapter = makeAdapter(service, makeStores({
      mode: "rp",
      coauthorProviderId: "prof_coauthor",
      coauthorSettings: { modelName: "coauthor-model", settings: { temperature: 0.23 } },
    }));

    const { profile: effective } = await adapter.resolveEffectiveProfileOrThrow({ chatId: "chat_1" });

    expect(effective.id).toBe("prof_1");
    expect(effective.defaultModel).toBe("gpt-4o");
    expect(effective.temperature).toBe(0.4);
    expect(requestedFor).toEqual(["gpt-4o"]);
  });
});
