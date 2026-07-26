import { describe, it, expect } from "bun:test";
import { resolveCoauthorBinding, filterToolCapableFavorites } from "./coauthor-provider-binding.js";
import type { ProviderProfileRecord, FavoriteProviderModelRecord } from "../api/types.js";

function makeProfile(over: Partial<ProviderProfileRecord> = {}): ProviderProfileRecord {
  return {
    id: "prof_1",
    name: "Alpha",
    providerPreset: "openaiCompat",
    endpoint: "http://localhost/v1",
    apiKey: "sk-test",
    defaultModel: "gpt-4o",
    contextBudget: 16000,
    pinContextBudget: false,
    bindPerModel: true,
    maxTokens: 2000,
    temperature: 1,
    topP: 1,
    topK: 0,
    minP: 0,
    topA: 0,
    typicalP: 1,
    tfsZ: 1,
    repeatLastN: 0,
    mirostat: 0,
    mirostatTau: 5,
    mirostatEta: 0.1,
    dryMultiplier: 0,
    dryBase: 1.75,
    dryAllowedLength: 2,
    drySequenceBreakers: [],
    xtcThreshold: 0.1,
    xtcProbability: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    repetitionPenalty: 1,
    stopSequences: [],
    logitBias: [],
    seed: null,
    reasoningEffort: "auto",
    showReasoning: false,
    streamResponse: true,
    customSamplers: true,
    isActive: true,
    visionModel: null,
    sortOrder: 0,
    ...over,
  } as unknown as ProviderProfileRecord;
}

function makeFavorite(modelId: string): FavoriteProviderModelRecord {
  return { id: `fav_${modelId}`, profileId: "prof_1", modelId, label: null, sortOrder: 0 } as unknown as FavoriteProviderModelRecord;
}

describe("resolveCoauthorBinding", () => {
  it("explicit binding with stored model → resolves the bound profile + model", () => {
    const coauthor = makeProfile({ id: "prof_coauthor", defaultModel: "fallback-model", isActive: false });
    const rp = makeProfile({ id: "prof_rp", defaultModel: "gpt-4o", isActive: true });
    const result = resolveCoauthorBinding({
      coauthorProviderId: "prof_coauthor",
      coauthorModelName: "claude-sonnet",
      profiles: [rp, coauthor],
      rpActiveProfile: rp,
    });
    expect(result.profile?.id).toBe("prof_coauthor");
    expect(result.model).toBe("claude-sonnet");
    expect(result.isExplicit).toBe(true);
    expect(result.isReady).toBe(true);
    expect(result.isDangling).toBe(false);
  });

  it("explicit binding with null modelName → falls back to profile defaultModel", () => {
    const coauthor = makeProfile({ id: "prof_coauthor", defaultModel: "profile-default", isActive: false });
    const rp = makeProfile({ id: "prof_rp", isActive: true });
    const result = resolveCoauthorBinding({
      coauthorProviderId: "prof_coauthor",
      coauthorModelName: null,
      profiles: [rp, coauthor],
      rpActiveProfile: rp,
    });
    expect(result.model).toBe("profile-default");
    expect(result.isExplicit).toBe(true);
    expect(result.isReady).toBe(true);
  });

  it("null coauthorProviderId → RP fallback (not dangling, not explicit)", () => {
    const rp = makeProfile({ id: "prof_rp", defaultModel: "gpt-4o", isActive: true });
    const result = resolveCoauthorBinding({
      coauthorProviderId: null,
      coauthorModelName: null,
      profiles: [rp],
      rpActiveProfile: rp,
    });
    expect(result.profile?.id).toBe("prof_rp");
    expect(result.model).toBe("gpt-4o");
    expect(result.isExplicit).toBe(false);
    expect(result.isReady).toBe(true);
    expect(result.isDangling).toBe(false);
  });

  it("dangling providerId (deleted profile) → RP fallback flagged as dangling", () => {
    const rp = makeProfile({ id: "prof_rp", isActive: true });
    const result = resolveCoauthorBinding({
      coauthorProviderId: "prof_deleted",
      coauthorModelName: "x",
      profiles: [rp], // prof_deleted not in list
      rpActiveProfile: rp,
    });
    expect(result.profile?.id).toBe("prof_rp");
    expect(result.isExplicit).toBe(false);
    expect(result.isDangling).toBe(true);
  });

  it("no RP active profile and no coauthor binding → null profile, not ready", () => {
    const result = resolveCoauthorBinding({
      coauthorProviderId: null,
      coauthorModelName: null,
      profiles: [],
      rpActiveProfile: null,
    });
    expect(result.profile).toBeNull();
    expect(result.model).toBeNull();
    expect(result.isReady).toBe(false);
  });

  it("changing RP activation/defaultModel does not affect an explicit coauthor binding", () => {
    const coauthor = makeProfile({ id: "prof_coauthor", defaultModel: "coauthor-model", isActive: false });
    let rp = makeProfile({ id: "prof_rp_a", defaultModel: "rp-model-a", isActive: true });
    const profiles = [rp, coauthor];

    const result1 = resolveCoauthorBinding({
      coauthorProviderId: "prof_coauthor",
      coauthorModelName: "coauthor-model",
      profiles,
      rpActiveProfile: rp,
    });

    // RP profile changes completely
    rp = makeProfile({ id: "prof_rp_b", defaultModel: "rp-model-b", isActive: true });
    profiles[0] = rp;

    const result2 = resolveCoauthorBinding({
      coauthorProviderId: "prof_coauthor",
      coauthorModelName: "coauthor-model",
      profiles,
      rpActiveProfile: rp,
    });

    expect(result2.profile?.id).toBe("prof_coauthor");
    expect(result2.model).toBe("coauthor-model");
    // Identical to result1 — RP change has no effect on an explicit binding
    expect(result2.profile?.id).toBe(result1.profile?.id);
    expect(result2.model).toBe(result1.model);
  });

  it("preserves a custom stored model id even when profile defaultModel is absent", () => {
    const coauthor = makeProfile({ id: "prof_coauthor", defaultModel: null, isActive: false });
    const rp = makeProfile({ id: "prof_rp", isActive: true });
    const result = resolveCoauthorBinding({
      coauthorProviderId: "prof_coauthor",
      coauthorModelName: "custom-model",
      profiles: [rp, coauthor],
      rpActiveProfile: rp,
    });
    expect(result.model).toBe("custom-model");
    expect(result.isReady).toBe(true);
  });
});

describe("filterToolCapableFavorites", () => {
  it("filters to only tool-capable models", () => {
    const favs = [makeFavorite("tool-1"), makeFavorite("no-tools"), makeFavorite("tool-2")];
    const toolIds = new Set(["tool-1", "tool-2"]);
    const result = filterToolCapableFavorites(favs, toolIds, null);
    expect(result.map((f) => f.modelId)).toEqual(["tool-1", "tool-2"]);
  });

  it("keeps the bound model even if it is not in the tool-capable cache (stale/absent metadata)", () => {
    const favs = [makeFavorite("tool-1"), makeFavorite("stale-bound")];
    const toolIds = new Set(["tool-1"]); // stale-bound not in cache
    const result = filterToolCapableFavorites(favs, toolIds, "stale-bound");
    expect(result.map((f) => f.modelId)).toEqual(["tool-1", "stale-bound"]);
  });
});
