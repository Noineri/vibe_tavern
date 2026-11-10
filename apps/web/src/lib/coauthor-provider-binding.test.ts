import { describe, it, expect } from "bun:test";
import { decorateCoauthorFavorites, resolveCoauthorBinding } from "./coauthor-provider-binding.js";
import type { CoauthorConnectionSettingsRecord, ProviderProfileRecord, FavoriteProviderModelRecord } from "../api/types.js";

function makeProfile(over: Partial<ProviderProfileRecord> = {}): ProviderProfileRecord {
  // Complete ClientProviderProfileRecord — every member below is a real one.
  // The erased literal carried `apiKey` (the client projection has no such
  // member — the server keeps the key and returns `hasStoredApiKey`) and
  // `sortOrder` (no such member on the record); both were invisible fictions
  // the erasure hid. Values differing from the wire defaults are kept
  // explicitly; no assertion reads either dropped member.
  return {
    id: "prof_1",
    name: "Alpha",
    providerPreset: "openaiCompat",
    coauthorTransport: "chat_completions",
    generationMode: "chat",
    endpoint: "http://localhost/v1",
    defaultModel: "gpt-4o",
    visionModel: null,
    contextBudget: 16000,
    pinContextBudget: false,
    tokenPadding: 0,
    bindPerModel: true,
    modelFreeOnly: false,
    modelGroupByOwner: false,
    maxTokens: 2000,
    temperature: 1,
    topP: 1,
    topK: 0,
    minP: 0,
    topA: 0,
    typicalP: 1,
    tfsZ: 1,
    adaptiveTarget: -1,
    adaptiveDecay: 0.9,
    dynatempRange: 0,
    dynatempExponent: 1,
    topNSigma: 0,
    smoothingFactor: 0,
    repeatLastN: 0,
    mirostat: 0,
    mirostatTau: 5,
    mirostatEta: 0.1,
    dryMultiplier: 0,
    dryBase: 1.75,
    dryAllowedLength: 2,
    dryPenaltyLastN: -1,
    drySequenceBreakers: [],
    xtcThreshold: 0.1,
    xtcProbability: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    repetitionPenalty: 1,
    unifiedLinear: 1,
    unifiedQuad: 0,
    unifiedConf: 0,
    repetitionPenaltySlope: 0,
    phraseRepPen: "off",
    thinkingMode: "auto",
    stopSequences: [],
    bannedStrings: [],
    logitBias: [],
    seed: null,
    reasoningEffort: "auto",
    showReasoning: false,
    streamResponse: true,
    customSamplers: true,
    proxyMode: "inherit",
    proxyId: null,
    samplerSetId: null,
    generationFormat: null,
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    hasStoredApiKey: true,
    ...over,
  };
}

function makeFavorite(modelId: string): FavoriteProviderModelRecord {
  // Complete FavoriteProviderModelRecord: the erased literal used `profileId`
  // (the real member is `providerProfileId`) and invented `sortOrder`; it
  // omitted the required `scope`/`contextLength`/`createdAt`. None is read —
  // decorateCoauthorFavorites joins on `modelId` and spreads the rest.
  return {
    id: `fav_${modelId}`,
    providerProfileId: "prof_1",
    modelId,
    scope: "rp",
    label: null,
    contextLength: null,
    createdAt: "2026-01-01",
  };
}

/** The bound connection's `coauthor_connection_settings` row (CG-1/CG-2) —
 *  the model source the binding now reads instead of the retired global
 *  `ui_settings` model column (dropped by CG-5). */
function makeRow(modelName: string | null): CoauthorConnectionSettingsRecord {
  // Every member below is real; the old erasure was pure noise.
  return {
    providerProfileId: "prof_coauthor",
    modelName,
    settings: { temperature: 0.5, maxTokens: 1234, contextBudget: 5000, pinContextBudget: true },
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
}

describe("resolveCoauthorBinding", () => {
  it("explicit binding with stored model → resolves the bound profile + model", () => {
    const coauthor = makeProfile({ id: "prof_coauthor", defaultModel: "fallback-model", isActive: false });
    const rp = makeProfile({ id: "prof_rp", defaultModel: "gpt-4o", isActive: true });
    const result = resolveCoauthorBinding({
      coauthorProviderId: "prof_coauthor",
      coauthorSettings: makeRow("claude-sonnet"),
      profiles: [rp, coauthor],
      rpActiveProfile: rp,
    });
    expect(result.profile?.id).toBe("prof_coauthor");
    expect(result.model).toBe("claude-sonnet");
    expect(result.isExplicit).toBe(true);
    expect(result.isReady).toBe(true);
    expect(result.isDangling).toBe(false);
  });

  it("row model wins over the connection profile's defaultModel (CG-2 fallback order)", () => {
    const coauthor = makeProfile({ id: "prof_coauthor", defaultModel: "profile-default", isActive: false });
    const rp = makeProfile({ id: "prof_rp", defaultModel: "gpt-4o", isActive: true });
    const result = resolveCoauthorBinding({
      coauthorProviderId: "prof_coauthor",
      coauthorSettings: makeRow("row-model"),
      profiles: [rp, coauthor],
      rpActiveProfile: rp,
    });
    expect(result.model).toBe("row-model");
  });

  it("explicit binding with a rowless connection (null) → falls back to profile defaultModel", () => {
    const coauthor = makeProfile({ id: "prof_coauthor", defaultModel: "profile-default", isActive: false });
    const rp = makeProfile({ id: "prof_rp", isActive: true });
    const result = resolveCoauthorBinding({
      coauthorProviderId: "prof_coauthor",
      coauthorSettings: makeRow(null),
      profiles: [rp, coauthor],
      rpActiveProfile: rp,
    });
    expect(result.model).toBe("profile-default");
    expect(result.isExplicit).toBe(true);
    expect(result.isReady).toBe(true);
  });

  it("row not loaded yet (undefined) → same profile-default fallback as a rowless connection", () => {
    const coauthor = makeProfile({ id: "prof_coauthor", defaultModel: "profile-default", isActive: false });
    const rp = makeProfile({ id: "prof_rp", isActive: true });
    const result = resolveCoauthorBinding({
      coauthorProviderId: "prof_coauthor",
      coauthorSettings: undefined,
      profiles: [rp, coauthor],
      rpActiveProfile: rp,
    });
    expect(result.model).toBe("profile-default");
    expect(result.isExplicit).toBe(true);
    expect(result.isReady).toBe(true);
  });

  it("null coauthorProviderId fails closed instead of using the RP profile", () => {
    const rp = makeProfile({ id: "prof_rp", defaultModel: "gpt-4o", isActive: true });
    const result = resolveCoauthorBinding({
      coauthorProviderId: null,
      coauthorSettings: undefined,
      profiles: [rp],
      rpActiveProfile: rp,
    });
    expect(result.profile).toBeNull();
    expect(result.model).toBeNull();
    expect(result.isExplicit).toBe(false);
    expect(result.isReady).toBe(false);
    expect(result.isDangling).toBe(false);
  });

  it("dangling providerId fails closed and remains flagged as dangling", () => {
    const rp = makeProfile({ id: "prof_rp", isActive: true });
    const result = resolveCoauthorBinding({
      coauthorProviderId: "prof_deleted",
      coauthorSettings: makeRow("x"),
      profiles: [rp], // prof_deleted not in list
      rpActiveProfile: rp,
    });
    expect(result.profile).toBeNull();
    expect(result.model).toBeNull();
    expect(result.isExplicit).toBe(false);
    expect(result.isReady).toBe(false);
    expect(result.isDangling).toBe(true);
  });

  it("no RP active profile and no coauthor binding → null profile, not ready", () => {
    const result = resolveCoauthorBinding({
      coauthorProviderId: null,
      coauthorSettings: undefined,
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
      coauthorSettings: makeRow("coauthor-model"),
      profiles,
      rpActiveProfile: rp,
    });

    // RP profile changes completely
    rp = makeProfile({ id: "prof_rp_b", defaultModel: "rp-model-b", isActive: true });
    profiles[0] = rp;

    const result2 = resolveCoauthorBinding({
      coauthorProviderId: "prof_coauthor",
      coauthorSettings: makeRow("coauthor-model"),
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
      coauthorSettings: makeRow("custom-model"),
      profiles: [rp, coauthor],
      rpActiveProfile: rp,
    });
    expect(result.model).toBe("custom-model");
    expect(result.isReady).toBe(true);
  });
});

describe("decorateCoauthorFavorites", () => {
  it("retains every favorite and decorates each known capability state", () => {
    const favs = [makeFavorite("supported"), makeFavorite("unknown"), makeFavorite("unsupported")];
    const result = decorateCoauthorFavorites(favs, [
      { id: "supported", label: "Supported", toolSupport: "supported" },
      { id: "unsupported", label: "Unsupported", toolSupport: "unsupported" },
    ]);
    expect(result.map((favorite) => [favorite.modelId, favorite.toolSupport])).toEqual([
      ["supported", "supported"],
      ["unknown", "unknown"],
      ["unsupported", "unsupported"],
    ]);
  });
});
