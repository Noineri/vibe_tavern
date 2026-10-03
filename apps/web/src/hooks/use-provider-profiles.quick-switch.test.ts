/**
 * RP_QUICK_SWITCH_MODEL_SETTINGS_REPORT step 1 — the star quick-switch writer
 * (handleSelectFavoriteProviderModel) and the step-2 display read
 * (activeModelEffectiveProfile), at the useProviderProfiles seam.
 *
 * Step 1 pins:
 *  - per-model binding ON + a saved overlay for the chosen favorite → the
 *    PATCH is model-only: switching between two favorites with overlays never
 *    touches the profile base (the overlay is the source);
 *  - binding ON without an overlay for the model, or binding OFF → the context
 *    budget follows the shared auto-fill rule from the LIVE context length the
 *    caller resolved from the provider's current model list;
 *  - a pinned budget is never written.
 *
 * Step 2 pins the hook-level wiring: the active model's overlay rows load when
 * binding is ON and activeModelEffectiveProfile resolves through them (the
 * derivation itself is pinned in effective-provider-profile.test.ts).
 *
 * Doubles sit at the API seam (provider-api): the real store actions run, so
 * the seeded caches are exactly what the hook reads. The `...real` spread
 * keeps every other export genuine for later files sharing the worker.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();

const { renderHook, act, waitFor } = await import("@testing-library/react");

import type { ProviderProfileRecord } from "../api/types.js";

const realProviderApi = await import("../api/provider-api.js");

/** `${modelId}` -> overlay settings (absent key = no overlay row). */
let overlayRows: Record<string, Record<string, unknown>> = {};
let seededProfile: ProviderProfileRecord;
const updatePatches: Array<{ profileId: string; patch: Record<string, unknown> }> = [];
const getProviderModelSettingsCalls: Array<{ profileId: string; modelId: string }> = [];

const listProviderProfiles = mock(async (): Promise<ProviderProfileRecord[]> => [seededProfile]);
const updateProviderProfile = mock(async (profileId: string, patch: Record<string, unknown>): Promise<ProviderProfileRecord> => {
  updatePatches.push({ profileId, patch });
  return { ...seededProfile, ...patch } as ProviderProfileRecord;
});
const getProviderModelSettings = mock(async (profileId: string, modelId: string): Promise<unknown> => {
  getProviderModelSettingsCalls.push({ profileId, modelId });
  const settings = overlayRows[modelId];
  if (settings == null) return null;
  return { id: `pms_${modelId}`, providerProfileId: profileId, modelId, settings, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
});
const listProviderModelSettings = mock(async (): Promise<unknown[]> =>
  Object.entries(overlayRows).map(([modelId, settings]) => ({
    id: `pms_${modelId}`, providerProfileId: "p1", modelId, settings, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  })));
const listFavoriteProviderModels = mock(async (): Promise<never[]> => []);
const testProviderProfile = mock(async (): Promise<unknown> => ({ success: true }));

mock.module("../api/provider-api.js", () => ({
  ...realProviderApi,
  listProviderProfiles,
  updateProviderProfile,
  getProviderModelSettings,
  listProviderModelSettings,
  listFavoriteProviderModels,
  testProviderProfile,
}));

const { useProviderDataStore } = await import("../stores/provider-data-store.js");
const { useProviderProfiles } = await import("./use-provider-profiles.js");

function makeProfile(over: Record<string, unknown> = {}): ProviderProfileRecord {
  return {
    id: "p1",
    name: "Quick Switch Profile",
    providerPreset: "openaiCompat",
    coauthorTransport: "chatCompletions",
    generationMode: "chat",
    endpoint: "http://localhost:1234/v1",
    defaultModel: "m-a",
    visionModel: null,
    contextBudget: 32000,
    pinContextBudget: false,
    tokenPadding: 0,
    bindPerModel: false,
    modelFreeOnly: false,
    modelGroupByOwner: false,
    maxTokens: 2000,
    temperature: 0.8,
    topP: 0.95, minP: 0.05, topK: 40, topA: 0, typicalP: 1, tfsZ: 1,
    adaptiveTarget: -1, adaptiveDecay: 0.9, dynatempRange: 0, dynatempExponent: 1,
    topNSigma: 0, smoothingFactor: 0, repeatLastN: 0,
    mirostat: 0, mirostatTau: 5, mirostatEta: 0.1,
    dryMultiplier: 0, dryBase: 1.75, dryAllowedLength: 2, dryPenaltyLastN: -1, drySequenceBreakers: [],
    xtcThreshold: 0.1, xtcProbability: 0,
    frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1,
    stopSequences: [], bannedStrings: [], logitBias: [],
    seed: null, reasoningEffort: "auto", showReasoning: false, streamResponse: true,
    customSamplers: false, proxyMode: "inherit", proxyId: null,
    isActive: true, samplerSetId: null, generationFormat: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    hasStoredApiKey: true,
    ...over,
  } as unknown as ProviderProfileRecord;
}

function seed(profile: ProviderProfileRecord, overlays: Record<string, Record<string, unknown>>): void {
  seededProfile = profile;
  overlayRows = overlays;
  updatePatches.length = 0;
  getProviderModelSettingsCalls.length = 0;
  useProviderDataStore.setState({
    profiles: [profile],
    favoritesByProfile: { [profile.id]: [] },
    modelSettingsByProfile: {},
  });
}

describe("useProviderProfiles — RP star quick-switch (report steps 1-2)", () => {
  beforeEach(() => {
    mock.clearAllMocks();
    updatePatches.length = 0;
    getProviderModelSettingsCalls.length = 0;
  });

  it("binding ON + overlays on both favorites → switching between them is model-only (base untouched)", async () => {
    seed(makeProfile({ bindPerModel: true }), {
      "m-b": { contextBudget: 131072, maxTokens: 4096 },
      "m-c": { contextBudget: 65536, maxTokens: 8192 },
    });
    const { result } = renderHook(() => useProviderProfiles());

    await act(async () => { await result.current.handleSelectFavoriteProviderModel("p1", "m-b", 999_999); });
    await act(async () => { await result.current.handleSelectFavoriteProviderModel("p1", "m-c", 999_999); });

    // The live context length passed by the caller is deliberately absurd —
    // an overlay-owned switch must ignore it (the overlay is the source).
    expect(updatePatches).toEqual([
      { profileId: "p1", patch: { defaultModel: "m-b" } },
      { profileId: "p1", patch: { defaultModel: "m-c" } },
    ]);
    expect(getProviderModelSettingsCalls).toEqual([
      { profileId: "p1", modelId: "m-b" },
      { profileId: "p1", modelId: "m-c" },
    ]);
  });

  it("binding ON + no overlay for the model → auto-fills the LIVE context length", async () => {
    seed(makeProfile({ bindPerModel: true }), { "m-b": { contextBudget: 131072 } });
    const { result } = renderHook(() => useProviderProfiles());

    await act(async () => { await result.current.handleSelectFavoriteProviderModel("p1", "m-x", 64_000); });

    expect(updatePatches).toEqual([{ profileId: "p1", patch: { defaultModel: "m-x", contextBudget: 64_000 } }]);
  });

  it("binding OFF → auto-fills from LIVE metadata; the overlay lookup is skipped", async () => {
    seed(makeProfile({ bindPerModel: false }), { "m-b": { contextBudget: 131072 } });
    const { result } = renderHook(() => useProviderProfiles());

    await act(async () => { await result.current.handleSelectFavoriteProviderModel("p1", "m-b", 48_000); });

    expect(updatePatches).toEqual([{ profileId: "p1", patch: { defaultModel: "m-b", contextBudget: 48_000 } }]);
    expect(getProviderModelSettingsCalls).toEqual([]);
  });

  it("pinned budget → never written, even with a known LIVE context length and no overlay", async () => {
    seed(makeProfile({ pinContextBudget: true }), {});
    const { result } = renderHook(() => useProviderProfiles());

    await act(async () => { await result.current.handleSelectFavoriteProviderModel("p1", "m-b", 64_000); });

    expect(updatePatches).toEqual([{ profileId: "p1", patch: { defaultModel: "m-b" } }]);
  });

  it("step 2: activeModelEffectiveProfile resolves the default model's overlay once rows load", async () => {
    seed(makeProfile({ bindPerModel: true, defaultModel: "m-b" }), {
      "m-b": { contextBudget: 131072, maxTokens: 8192 },
    });
    const { result } = renderHook(() => useProviderProfiles());

    await waitFor(() => {
      expect(result.current.activeModelEffectiveProfile?.contextBudget).toBe(131072);
    });
    expect(result.current.activeModelEffectiveProfile?.maxTokens).toBe(8192);
    expect(result.current.activeModelEffectiveProfile?.tokenPadding).toBe(0);
  });
});
