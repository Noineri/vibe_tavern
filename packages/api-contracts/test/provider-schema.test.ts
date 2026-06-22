import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  testProviderDraftSchema,
  saveProviderDraftSchema,
  updateProviderProfileSchema,
  favoriteProviderModelSchema,
  fetchModelsSchema,
  testChatSchema,
  testChatProfileSchema,
  tokenizeSchema,
  modelSettingsOverlaySchema,
  samplerPresetPayloadSchema,
} from "../src/schemas/provider-schema.js";

/**
 * Characterization tests for the provider schemas.
 *
 * These pin the load-bearing constraints so a silent change (a dropped
 * `.nullable()` / `.optional()`, a loosened bias boundary, an int → number
 * flip) is caught here rather than in a broken provider-config request on
 * either side of the frontend↔backend contract.
 *
 * See `character-schema.test.ts` for the shared pattern: `safeParse`
 * everywhere, an `expectReject` helper typed over `SafeParseReturnType<unknown,
 * unknown>`, inline factories, and explicit nullable().optional() three-state
 * cells.
 */

// --- helpers ----------------------------------------------------------------

/**
 * Asserts a `safeParse` result is a rejection and (defensively) that it carries
 * at least one issue. Generic over the parsed type so it works for any schema.
 */
function expectReject(result: z.SafeParseReturnType<unknown, unknown>) {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.length).toBeGreaterThan(0);
  }
}

// --- factories --------------------------------------------------------------

/**
 * Minimal valid payload for saveProviderDraftSchema. Only the three required
 * providerCore fields (name, providerPreset, endpoint) are set — every sampler
 * field is optional and omitted to keep the baseline lean.
 */
function validSaveDraft() {
  return {
    name: "My Provider",
    providerPreset: "openai",
    endpoint: "https://api.example.com",
  };
}

// --- testProviderDraftSchema ------------------------------------------------

describe("testProviderDraftSchema", () => {
  it("accepts an empty payload (every field optional)", () => {
    expect(testProviderDraftSchema.safeParse({}).success).toBe(true);
  });

  it("accepts all three fields populated", () => {
    const payload = { endpoint: "https://e", apiKey: "k", providerType: "openai" };
    expect(testProviderDraftSchema.safeParse(payload).success).toBe(true);
  });

  // Loose probe schema: endpoint/apiKey/providerType are `.string().optional()`
  // — NOT nullable. Pin the asymmetry so it never silently becomes nullable.
  it("treats endpoint/apiKey/providerType as optional-string but rejects null", () => {
    for (const field of ["endpoint", "apiKey", "providerType"] as const) {
      expect(testProviderDraftSchema.safeParse({ [field]: "x" }).success).toBe(true);
      expect(testProviderDraftSchema.safeParse({ [field]: undefined }).success).toBe(true);
      expectReject(testProviderDraftSchema.safeParse({ [field]: null }));
      expectReject(testProviderDraftSchema.safeParse({ [field]: 42 }));
    }
  });
});

// --- saveProviderDraftSchema ------------------------------------------------

describe("saveProviderDraftSchema", () => {
  it("accepts the minimal factory (name/providerPreset/endpoint only)", () => {
    expect(saveProviderDraftSchema.safeParse(validSaveDraft()).success).toBe(true);
  });

  it("accepts the factory plus an optional id", () => {
    const payload = { ...validSaveDraft(), id: "prov_1" };
    expect(saveProviderDraftSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects an empty payload (missing required name/providerPreset/endpoint)", () => {
    expectReject(saveProviderDraftSchema.safeParse({}));
  });

  it("rejects an empty name (min(1))", () => {
    expectReject(
      saveProviderDraftSchema.safeParse({
        name: "",
        providerPreset: "p",
        endpoint: "e",
      }),
    );
  });

  it("rejects a payload missing providerPreset", () => {
    const { providerPreset: _omit, ...rest } = validSaveDraft();
    expectReject(saveProviderDraftSchema.safeParse(rest));
  });

  it("rejects a payload missing endpoint", () => {
    const { endpoint: _omit, ...rest } = validSaveDraft();
    expectReject(saveProviderDraftSchema.safeParse(rest));
  });

  // apiKey: `.string().nullable().optional()` — the canonical three-state cell.
  it("treats apiKey as nullable+optional (null/undefined/string ok, number rejected)", () => {
    const base = validSaveDraft();
    expect(saveProviderDraftSchema.safeParse({ ...base, apiKey: null }).success).toBe(true);
    expect(saveProviderDraftSchema.safeParse({ ...base, apiKey: undefined }).success).toBe(true);
    expect(saveProviderDraftSchema.safeParse({ ...base, apiKey: "sk-xxx" }).success).toBe(true);
    expectReject(saveProviderDraftSchema.safeParse({ ...base, apiKey: 42 }));
  });

  // contextBudget: `.number().nullable().optional()` — three-state cell.
  it("treats contextBudget as nullable+optional (null/undefined/number ok, string rejected)", () => {
    const base = validSaveDraft();
    expect(saveProviderDraftSchema.safeParse({ ...base, contextBudget: null }).success).toBe(true);
    expect(saveProviderDraftSchema.safeParse({ ...base, contextBudget: undefined }).success).toBe(true);
    expect(saveProviderDraftSchema.safeParse({ ...base, contextBudget: 8192 }).success).toBe(true);
    expectReject(saveProviderDraftSchema.safeParse({ ...base, contextBudget: "8192" }));
  });

  // Other nullable+optional string fields (defaultModel, seed, visionModel).
  it("treats defaultModel/seed/visionModel as nullable+optional", () => {
    const base = validSaveDraft();
    for (const field of ["defaultModel", "seed", "visionModel"] as const) {
      expect(saveProviderDraftSchema.safeParse({ ...base, [field]: null }).success).toBe(true);
      expect(saveProviderDraftSchema.safeParse({ ...base, [field]: undefined }).success).toBe(true);
      expect(saveProviderDraftSchema.safeParse({ ...base, [field]: "x" }).success).toBe(true);
    }
  });

  // logitBias: array of { tokenId: int, bias: -100..100 }. Pin both boundaries.
  it("accepts a valid logitBias entry and pins the bias boundaries (-100 and 100)", () => {
    const base = validSaveDraft();
    expect(
      saveProviderDraftSchema.safeParse({ ...base, logitBias: [{ tokenId: 1, bias: 50 }] }).success,
    ).toBe(true);
    expect(
      saveProviderDraftSchema.safeParse({ ...base, logitBias: [{ tokenId: 1, bias: -100 }] }).success,
    ).toBe(true);
    expect(
      saveProviderDraftSchema.safeParse({ ...base, logitBias: [{ tokenId: 1, bias: 100 }] }).success,
    ).toBe(true);
  });

  it("rejects logitBias bias above 100 and below -100", () => {
    const base = validSaveDraft();
    expectReject(
      saveProviderDraftSchema.safeParse({ ...base, logitBias: [{ tokenId: 1, bias: 200 }] }),
    );
    expectReject(
      saveProviderDraftSchema.safeParse({ ...base, logitBias: [{ tokenId: 1, bias: -101 }] }),
    );
    expectReject(
      saveProviderDraftSchema.safeParse({ ...base, logitBias: [{ tokenId: 1, bias: 101 }] }),
    );
  });

  it("rejects a non-integer tokenId in logitBias", () => {
    const base = validSaveDraft();
    expectReject(
      saveProviderDraftSchema.safeParse({ ...base, logitBias: [{ tokenId: 1.5, bias: 0 }] }),
    );
  });

  it("accepts logitBias entries with optional text/sourceText/model fields", () => {
    const base = validSaveDraft();
    const payload = {
      ...base,
      logitBias: [{ tokenId: 5, bias: -10, text: "foo", sourceText: "bar", model: "gpt-x" }],
    };
    expect(saveProviderDraftSchema.safeParse(payload).success).toBe(true);
  });
});

// --- updateProviderProfileSchema --------------------------------------------

describe("updateProviderProfileSchema", () => {
  // providerCoreSchema.partial() — every field optional.
  it("accepts an empty patch (every field optional)", () => {
    expect(updateProviderProfileSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a single-field patch", () => {
    expect(updateProviderProfileSchema.safeParse({ name: "Renamed" }).success).toBe(true);
  });

  it("accepts a nullable+optional apiKey patch (null allowed on update)", () => {
    expect(updateProviderProfileSchema.safeParse({ apiKey: null }).success).toBe(true);
    expect(updateProviderProfileSchema.safeParse({ apiKey: "sk-x" }).success).toBe(true);
    expectReject(updateProviderProfileSchema.safeParse({ apiKey: 1 }));
  });

  // Even the formerly-required name is optional on update (partial()).
  it("does not require name on update (partial)", () => {
    expect(updateProviderProfileSchema.safeParse({ endpoint: "https://e" }).success).toBe(true);
  });

  // bias boundaries survive into the partial schema.
  it("pins logitBias bias boundaries on the update schema too", () => {
    expect(
      updateProviderProfileSchema.safeParse({ logitBias: [{ tokenId: 1, bias: -100 }] }).success,
    ).toBe(true);
    expect(
      updateProviderProfileSchema.safeParse({ logitBias: [{ tokenId: 1, bias: 100 }] }).success,
    ).toBe(true);
    expectReject(
      updateProviderProfileSchema.safeParse({ logitBias: [{ tokenId: 1, bias: 101 }] }),
    );
  });
});

// --- favoriteProviderModelSchema --------------------------------------------

describe("favoriteProviderModelSchema", () => {
  it("accepts a minimal payload with only modelId", () => {
    expect(favoriteProviderModelSchema.safeParse({ modelId: "gpt-x" }).success).toBe(true);
  });

  it("rejects an empty payload (missing modelId)", () => {
    expectReject(favoriteProviderModelSchema.safeParse({}));
  });

  it("rejects an empty modelId (min(1))", () => {
    expectReject(favoriteProviderModelSchema.safeParse({ modelId: "" }));
  });

  // label: `.string().nullable().optional()` — three-state cell.
  it("treats label as nullable+optional (null/undefined/string ok, number rejected)", () => {
    expect(favoriteProviderModelSchema.safeParse({ modelId: "m", label: null }).success).toBe(true);
    expect(favoriteProviderModelSchema.safeParse({ modelId: "m", label: undefined }).success).toBe(true);
    expect(favoriteProviderModelSchema.safeParse({ modelId: "m", label: "GPT-X" }).success).toBe(true);
    expectReject(favoriteProviderModelSchema.safeParse({ modelId: "m", label: 5 }));
  });

  // contextLength: `.number().int().nullable().optional()` — three-state cell
  // plus the int constraint.
  it("treats contextLength as nullable+optional int (null/undefined/int ok, non-int/string rejected)", () => {
    expect(favoriteProviderModelSchema.safeParse({ modelId: "m", contextLength: null }).success).toBe(true);
    expect(
      favoriteProviderModelSchema.safeParse({ modelId: "m", contextLength: undefined }).success,
    ).toBe(true);
    expect(favoriteProviderModelSchema.safeParse({ modelId: "m", contextLength: 128000 }).success).toBe(true);
    expectReject(favoriteProviderModelSchema.safeParse({ modelId: "m", contextLength: 1.5 }));
    expectReject(favoriteProviderModelSchema.safeParse({ modelId: "m", contextLength: "128000" }));
  });
});

// --- fetchModelsSchema ------------------------------------------------------

describe("fetchModelsSchema", () => {
  it("accepts an empty payload (every field optional)", () => {
    expect(fetchModelsSchema.safeParse({}).success).toBe(true);
  });

  it("accepts all fields populated", () => {
    const payload = { baseUrl: "https://e", apiKey: "k", providerType: "openai" };
    expect(fetchModelsSchema.safeParse(payload).success).toBe(true);
  });
});

// --- testChatSchema ---------------------------------------------------------

describe("testChatSchema", () => {
  it("accepts an empty payload (every field optional)", () => {
    expect(testChatSchema.safeParse({}).success).toBe(true);
  });

  it("accepts all fields populated", () => {
    const payload = {
      baseUrl: "https://e",
      apiKey: "k",
      model: "gpt-x",
      providerType: "openai",
    };
    expect(testChatSchema.safeParse(payload).success).toBe(true);
  });
});

// --- testChatProfileSchema --------------------------------------------------

describe("testChatProfileSchema", () => {
  it("accepts a payload with a model", () => {
    expect(testChatProfileSchema.safeParse({ model: "gpt-x" }).success).toBe(true);
  });

  it("rejects an empty payload (model is required)", () => {
    expectReject(testChatProfileSchema.safeParse({}));
  });

  it("rejects a non-string model", () => {
    expectReject(testChatProfileSchema.safeParse({ model: 5 }));
  });
});

// --- tokenizeSchema ---------------------------------------------------------

describe("tokenizeSchema", () => {
  it("accepts a minimal payload with only text", () => {
    expect(tokenizeSchema.safeParse({ text: "hi" }).success).toBe(true);
  });

  it("accepts text plus an optional model", () => {
    expect(tokenizeSchema.safeParse({ text: "hi", model: "gpt-x" }).success).toBe(true);
  });

  it("rejects an empty payload (missing text)", () => {
    expectReject(tokenizeSchema.safeParse({}));
  });

  it("rejects an empty text (min(1))", () => {
    expectReject(tokenizeSchema.safeParse({ text: "" }));
  });

  it("rejects a non-string text", () => {
    expectReject(tokenizeSchema.safeParse({ text: 42 }));
  });
});

// ── pinContextBudget / bindPerModel persistence (strip-gap regression) ──────

describe("pinContextBudget + bindPerModel survive zod validation", () => {
  // Regression: providerCoreSchema previously omitted pinContextBudget, so the
  // zod validator on PATCH/POST silently stripped it — pin NEVER persisted via
  // the API (DB stayed at its false default), making the pin feature and the
  // Wave 0 chat-input pin guard effectively no-ops. Both fields must survive.
  it("updateProviderProfileSchema preserves pinContextBudget", () => {
    const parsed = updateProviderProfileSchema.parse({ pinContextBudget: true });
    expect(parsed.pinContextBudget).toBe(true);
  });

  it("updateProviderProfileSchema preserves bindPerModel", () => {
    const parsed = updateProviderProfileSchema.parse({ bindPerModel: true });
    expect(parsed.bindPerModel).toBe(true);
  });

  it("saveProviderDraftSchema preserves pinContextBudget + bindPerModel", () => {
    const parsed = saveProviderDraftSchema.parse({
      name: "x", providerPreset: "y", endpoint: "z",
      pinContextBudget: true, bindPerModel: true,
    });
    expect(parsed.pinContextBudget).toBe(true);
    expect(parsed.bindPerModel).toBe(true);
  });
});

// ── Per-model overlay + clipboard payload ─────────────────────────────────

describe("modelSettingsOverlaySchema", () => {
  it("accepts an empty overlay (inherit all base)", () => {
    expect(modelSettingsOverlaySchema.safeParse({}).success).toBe(true);
  });

  it("accepts a sparse overlay (only set fields)", () => {
    const parsed = modelSettingsOverlaySchema.parse({ temperature: 0.3, contextBudget: 8000 });
    expect(parsed.temperature).toBe(0.3);
    expect(parsed.contextBudget).toBe(8000);
  });

  it("accepts pinContextBudget (per-model pin, V7)", () => {
    const parsed = modelSettingsOverlaySchema.parse({ pinContextBudget: true });
    expect(parsed.pinContextBudget).toBe(true);
  });

  it("strips unknown identity fields (overlay cannot rename/rebind)", () => {
    const parsed = modelSettingsOverlaySchema.parse({ name: "sneaky", temperature: 0.5 });
    expect(parsed).toEqual({ temperature: 0.5 });
    expect("name" in parsed).toBe(false);
  });

  it("accepts arrays (stopSequences, drySequenceBreakers, logitBias)", () => {
    const parsed = modelSettingsOverlaySchema.parse({
      stopSequences: ["\n\nUser:"],
      drySequenceBreakers: ["\n"],
      logitBias: [{ tokenId: 1, bias: 5 }],
    });
    expect(parsed.stopSequences).toEqual(["\n\nUser:"]);
    expect(parsed.logitBias).toEqual([{ tokenId: 1, bias: 5 }]);
  });
});

describe("samplerPresetPayloadSchema (clipboard)", () => {
  it("accepts the same surface as the overlay", () => {
    const payload = { temperature: 0.7, topP: 0.9, stopSequences: ["x"] };
    expect(samplerPresetPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects malformed logitBias bias (shares the overlay's -100..100 bound)", () => {
    expectReject(samplerPresetPayloadSchema.safeParse({ logitBias: [{ tokenId: 1, bias: 999 }] }));
  });
});
