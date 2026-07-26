import { describe, it, expect } from "bun:test";
import {
  resolveEffectiveSettings,
  type StoredProviderProfileRecord,
  type ModelSettingsOverlay,
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

function makeAdapter(service: ProviderProfileService, stores?: Partial<Pick<StoreContainer, "uiSettings" | "chats">>): AdapterInternals {
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

// ─── Co-Author binding (CAP-21) ─────────────────────────────────────────────
//
// Mode-aware resolution: when a chat is in coauthor mode AND uiSettings holds
// a valid coauthorProviderId + coauthorModelName, the adapter resolves that
// binding instead of the RP active profile. Null/dangling bindings fall back
// to the RP active profile. The plan requires these tests EXTEND the RP suite
// (above), not replace it — every RP test above retains its original boundary.

/** Minimal stores mock for Co-Author mode tests. */
function makeStores(opts: {
  mode?: string;
  coauthorProviderId?: string | null;
  coauthorModelName?: string | null;
  coauthorMaxTokens?: number | null;
  coauthorContextBudget?: number | null;
}): { uiSettings: { get: () => Promise<object> }; chats: { getById: (id: string) => Promise<object | null> } } {
  return {
    uiSettings: {
      get: async () => ({
        id: "default",
        theme: "dark",
        chatFontSize: 15,
        uiFontSize: 14,
        messageWidth: 700,
        language: "en",
        activePromptPresetId: null,
        aiAssistantProviderId: null,
        aiAssistantModelName: null,
        coauthorProviderId: opts.coauthorProviderId ?? null,
        coauthorModelName: opts.coauthorModelName ?? null,
        coauthorMaxTokens: opts.coauthorMaxTokens ?? null,
        coauthorContextBudget: opts.coauthorContextBudget ?? null,
        updatedAt: "2026-01-01",
      }),
    },
    chats: {
      getById: async (_id: string) => ({ id: "chat_1", mode: opts.mode ?? "rp" }),
    },
  };
}

describe("CAP-21: Co-Author binding resolution", () => {
  const coauthorProfile = makeBase({
    id: "prof_coauthor",
    name: "coauthor-profile",
    defaultModel: "coauthor-default",
    temperature: 0.5,
  });
  const rpProfile = makeBase({
    id: "prof_1",
    name: "rp-active",
    defaultModel: "gpt-4o",
    temperature: 1,
  });

  it("coauthor chat with valid binding → resolves the bound profile + stored model", async () => {
    const { service, requestedFor } = makeProfileService({
      base: rpProfile,
      profilesById: { prof_coauthor: coauthorProfile },
      overlays: { "coauthor-model": { temperature: 0.3 } },
    });
    const stores = makeStores({ mode: "coauthor", coauthorProviderId: "prof_coauthor", coauthorModelName: "coauthor-model" });
    const adapter = makeAdapter(service, stores);

    const { profile: effective } = await adapter.resolveEffectiveProfileOrThrow({ chatId: "chat_1" });

    expect(effective.id).toBe("prof_coauthor"); // NOT the RP active profile
    expect(effective.defaultModel).toBe("coauthor-model"); // stored model, not profile default
    expect(effective.temperature).toBe(0.3); // overlay for the stored model applied
    expect(requestedFor).toEqual(["coauthor-model"]);
  });

  it("coauthor binding falls back to RP active profile when providerId is null", async () => {
    const { service } = makeProfileService({ base: rpProfile, profilesById: {} });
    const stores = makeStores({ mode: "coauthor", coauthorProviderId: null, coauthorModelName: null });
    const adapter = makeAdapter(service, stores);

    const { profile: effective } = await adapter.resolveEffectiveProfileOrThrow({ chatId: "chat_1" });

    expect(effective.id).toBe("prof_1"); // RP active
    expect(effective.defaultModel).toBe("gpt-4o");
  });

  it("coauthor binding falls back to RP when the bound profile was deleted (dangling id)", async () => {
    const { service } = makeProfileService({ base: rpProfile, profilesById: {} }); // prof_coauthor not in profilesById
    const stores = makeStores({ mode: "coauthor", coauthorProviderId: "prof_coauthor", coauthorModelName: "x" });
    const adapter = makeAdapter(service, stores);

    const { profile: effective } = await adapter.resolveEffectiveProfileOrThrow({ chatId: "chat_1" });

    expect(effective.id).toBe("prof_1"); // RP fallback
  });

  it("model precedence: request override > coauthorModelName > profile defaultModel", async () => {
    const { service, requestedFor } = makeProfileService({
      base: rpProfile,
      profilesById: { prof_coauthor: coauthorProfile },
      overlays: { "override-model": { temperature: 0.15 } },
    });
    const stores = makeStores({ mode: "coauthor", coauthorProviderId: "prof_coauthor", coauthorModelName: "coauthor-model" });
    const adapter = makeAdapter(service, stores);

    const { profile: effective } = await adapter.resolveEffectiveProfileOrThrow({ chatId: "chat_1", modelOverride: "override-model" });

    expect(effective.defaultModel).toBe("override-model"); // override wins over coauthorModelName
    expect(requestedFor).toEqual(["override-model"]);
  });

  it("applies Co-Author token overrides after the per-model overlay without changing RP", async () => {
    const { service } = makeProfileService({
      base: rpProfile,
      profilesById: { prof_coauthor: coauthorProfile },
      overlays: { "coauthor-model": { maxTokens: 4_000, contextBudget: 64_000 } },
    });
    const coauthorStores = makeStores({
      mode: "coauthor",
      coauthorProviderId: "prof_coauthor",
      coauthorModelName: "coauthor-model",
      coauthorMaxTokens: 1_200,
      coauthorContextBudget: 24_000,
    });
    const adapter = makeAdapter(service, coauthorStores);

    const { profile: coauthorEffective, transport } = await adapter.resolveEffectiveProfileOrThrow({ chatId: "chat_1" });
    expect(coauthorEffective.maxTokens).toBe(1_200);
    expect(coauthorEffective.contextBudget).toBe(24_000);
    expect(transport).toBe("chat_completions");

    const { profile: rpEffective, transport: rpTransport } = await adapter.resolveEffectiveProfileOrThrow();
    expect(rpEffective.maxTokens).toBe(rpProfile.maxTokens);
    expect(rpEffective.contextBudget).toBe(rpProfile.contextBudget);
    expect(rpTransport).toBe("chat_completions");
  });

  it("coauthor path falls back to profile defaultModel when coauthorModelName is null", async () => {
    const { service, requestedFor } = makeProfileService({
      base: rpProfile,
      profilesById: { prof_coauthor: coauthorProfile },
      overlays: { "coauthor-default": { temperature: 0.42 } },
    });
    const stores = makeStores({ mode: "coauthor", coauthorProviderId: "prof_coauthor", coauthorModelName: null });
    const adapter = makeAdapter(service, stores);

    const { profile: effective } = await adapter.resolveEffectiveProfileOrThrow({ chatId: "chat_1" });

    expect(effective.id).toBe("prof_coauthor");
    expect(effective.defaultModel).toBe("coauthor-default"); // profile default used
    expect(requestedFor).toEqual(["coauthor-default"]);
  });

  it("RP chat is unaffected — no Co-Author resolution attempted", async () => {
    const { service } = makeProfileService({
      base: rpProfile,
      profilesById: { prof_coauthor: coauthorProfile },
    });
    const stores = makeStores({ mode: "rp", coauthorProviderId: "prof_coauthor", coauthorModelName: "coauthor-model" });
    const adapter = makeAdapter(service, stores);

    const { profile: effective } = await adapter.resolveEffectiveProfileOrThrow({ chatId: "chat_1" });

    expect(effective.id).toBe("prof_1"); // RP active, even though a coauthor binding exists
  });

  it("coauthor resolution performs no profile activation/defaultModel write (read-only)", async () => {
    // The adapter's resolveProfileForMode reads profiles via getProviderProfile;
    // it never calls activate/save. This test pins that no mutation methods are
    // invoked by spying on the mock service.
    const mutations: string[] = [];
    const { service } = makeProfileService({
      base: rpProfile,
      profilesById: { prof_coauthor: coauthorProfile },
    });
    (service as unknown as Record<string, unknown>).activateProviderProfile = async () => { mutations.push("activate"); };
    (service as unknown as Record<string, unknown>).saveProviderProfile = async () => { mutations.push("save"); };
    const stores = makeStores({ mode: "coauthor", coauthorProviderId: "prof_coauthor", coauthorModelName: "m" });
    const adapter = makeAdapter(service, stores);

    await adapter.resolveEffectiveProfileOrThrow({ chatId: "chat_1" });

    expect(mutations).toEqual([]); // no activation, no defaultModel write
  });
});
