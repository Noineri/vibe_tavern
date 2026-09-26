import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  FLY_HINT_PLACEHOLDER,
  FLY_STEERING_NOTE_MAX_LENGTH,
  FLY_TRIBUNAL_PRECEDENT_GATE,
  flyBrainManifestSchema,
  flyMemoryGetResponseSchema,
  flyMemoryPutSchema,
  flyTribunalSettingsSchema,
} from "../src/schemas/fly-tribunal-schema.js";
import { regenerateOverrideSchema } from "../src/schemas/chat-regenerate-schema.js";

/**
 * Characterization of the Fly Tribunal Zod schemas (FLY_TRIBUNAL_PLAN FT-2).
 *
 * Two jobs:
 * 1. PIN the legacy regenerate contract — adding `steeringNote` must not
 *    change what an empty/legacy body means (the plan's FT-2 acceptance:
 *    "empty regenerate body still validates, legacy path unchanged"). The
 *    route-level twin lives in `services/api/test/regenerate-stream-route.test.ts`.
 * 2. Pin the tribunal settings defaults (owner decisions — indication tier,
 *    cap 2, обычная sensitivity, высокий auto-swipe bar, training on,
 *    lifetime 14, per-chat memory) and the vocabularies' closedness, the
 *    hint-template placeholder rule, and the memory scope cross-field rules.
 *
 * Pattern mirrors `dice-schema.test.ts`: `safeParse` everywhere, inline
 * factories, one field mutated per case.
 */

// --- helpers ----------------------------------------------------------------

function expectReject(result: z.ZodSafeParseResult<unknown>) {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.length).toBeGreaterThan(0);
  }
}

function expectData(result: z.ZodSafeParseResult<unknown>): Record<string, unknown> {
  expect(result.success).toBe(true);
  if (!result.success) throw new Error("expected success but parse failed");
  return result.data as Record<string, unknown>;
}

// --- regenerate override: legacy path unchanged (FT-2 acceptance) ------------

describe("regenerateOverrideSchema (legacy contract unchanged)", () => {
  it("accepts an absent body (whole override optional)", () => {
    expect(regenerateOverrideSchema.safeParse(undefined).success).toBe(true);
  });

  it("accepts an empty object and yields an empty override", () => {
    const data = expectData(regenerateOverrideSchema.safeParse({}));
    expect(data).toEqual({});
  });

  it("accepts each legacy field alone", () => {
    expect(regenerateOverrideSchema.safeParse({ model: "gpt-x" }).success).toBe(true);
    expect(regenerateOverrideSchema.safeParse({ promptPresetId: "preset_1" }).success).toBe(true);
  });

  it("still rejects the legacy invalid values it always rejected", () => {
    expectReject(regenerateOverrideSchema.safeParse({ model: "" }));
    expectReject(regenerateOverrideSchema.safeParse({ promptPresetId: "" }));
  });

  it("accepts a steering note (the new field)", () => {
    expect(
      regenerateOverrideSchema.safeParse({ steeringNote: "keep the card tone" }).success,
    ).toBe(true);
  });

  it("accepts the full trio together", () => {
    expect(
      regenerateOverrideSchema.safeParse({
        model: "gpt-x",
        promptPresetId: "preset_1",
        steeringNote: "nuance",
      }).success,
    ).toBe(true);
  });

  it("rejects an empty steering note (absent, not empty, means no note)", () => {
    expectReject(regenerateOverrideSchema.safeParse({ steeringNote: "" }));
  });

  it("rejects an over-long steering note", () => {
    expectReject(
      regenerateOverrideSchema.safeParse({ steeringNote: "x".repeat(FLY_STEERING_NOTE_MAX_LENGTH + 1) }),
    );
  });
});

// --- tribunal settings: shipped defaults are owner decisions -----------------

describe("flyTribunalSettingsSchema defaults", () => {
  it("parses {} into the shipped defaults", () => {
    const data = expectData(flyTribunalSettingsSchema.safeParse({}));
    expect(data).toEqual({
      enabled: false,
      reactionTier: "indication",
      regenCap: 2,
      sensitivity: "normal",
      autoSwipeConfidence: "high",
      trainingEnabled: true,
      trainingSpeed: "normal",
      precedentLifetimeDays: 14,
      hints: [],
      memoryScope: "chat",
    });
  });

  it("accepts a fully specified object", () => {
    expect(
      flyTribunalSettingsSchema.safeParse({
        enabled: true,
        reactionTier: "auto",
        regenCap: 3,
        sensitivity: "strict",
        autoSwipeConfidence: "very-high",
        trainingEnabled: false,
        trainingSpeed: "fast",
        precedentLifetimeDays: null,
        hints: [`the court smells the familiar: ${FLY_HINT_PLACEHOLDER} — try otherwise`],
        memoryScope: "global",
      }).success,
    ).toBe(true);
  });
});

describe("flyTribunalSettingsSchema closed vocabularies", () => {
  const base = { enabled: true };

  it("rejects an unknown reaction tier", () => {
    expectReject(flyTribunalSettingsSchema.safeParse({ ...base, reactionTier: "nuclear" }));
  });

  it("rejects an unknown sensitivity", () => {
    expectReject(flyTribunalSettingsSchema.safeParse({ ...base, sensitivity: "medium" }));
  });

  it("rejects an unknown auto-swipe confidence bar", () => {
    expectReject(flyTribunalSettingsSchema.safeParse({ ...base, autoSwipeConfidence: "low" }));
  });

  it("rejects an unknown training speed", () => {
    expectReject(flyTribunalSettingsSchema.safeParse({ ...base, trainingSpeed: "turbo" }));
  });

  it("accepts every offered precedent lifetime including infinity (null)", () => {
    for (const lifetime of [7, 14, 30, null]) {
      expect(
        flyTribunalSettingsSchema.safeParse({ ...base, precedentLifetimeDays: lifetime }).success,
      ).toBe(true);
    }
  });

  it("rejects an unoffered precedent lifetime", () => {
    expectReject(flyTribunalSettingsSchema.safeParse({ ...base, precedentLifetimeDays: 10 }));
    expectReject(flyTribunalSettingsSchema.safeParse({ ...base, precedentLifetimeDays: Infinity }));
  });

  it("rejects an unknown memory scope", () => {
    expectReject(flyTribunalSettingsSchema.safeParse({ ...base, memoryScope: "user" }));
  });
});

describe("flyTribunalSettingsSchema regenCap bounds", () => {
  it("accepts the offered 1..3 range", () => {
    for (const cap of [1, 2, 3]) {
      expect(flyTribunalSettingsSchema.safeParse({ regenCap: cap }).success).toBe(true);
    }
  });

  it("rejects 0, 4 and non-integers", () => {
    expectReject(flyTribunalSettingsSchema.safeParse({ regenCap: 0 }));
    expectReject(flyTribunalSettingsSchema.safeParse({ regenCap: 4 }));
    expectReject(flyTribunalSettingsSchema.safeParse({ regenCap: 2.5 }));
  });
});

describe("flyTribunalSettingsSchema hint templates", () => {
  it("accepts an empty list (UI seeds localized defaults on first open)", () => {
    expect(flyTribunalSettingsSchema.safeParse({ hints: [] }).success).toBe(true);
  });

  it("rejects a template without the {detected} placeholder", () => {
    expectReject(flyTribunalSettingsSchema.safeParse({ hints: ["the court disapproves"] }));
  });

  it("rejects an empty template string", () => {
    expectReject(flyTribunalSettingsSchema.safeParse({ hints: [""] }));
  });

  it("rejects an over-long template", () => {
    expectReject(
      flyTribunalSettingsSchema.safeParse({ hints: [`${FLY_HINT_PLACEHOLDER} ${"x".repeat(300)}`] }),
    );
  });

  it("accepts a template that merely contains the placeholder", () => {
    expect(
      flyTribunalSettingsSchema.safeParse({ hints: [FLY_HINT_PLACEHOLDER] }).success,
    ).toBe(true);
  });
});

describe("FLY_TRIBUNAL_PRECEDENT_GATE", () => {
  it("is 25 (owner decision; accidental drift fails here)", () => {
    expect(FLY_TRIBUNAL_PRECEDENT_GATE).toBe(25);
  });
});

// --- brain manifest ----------------------------------------------------------

describe("flyBrainManifestSchema", () => {
  function validManifest(overrides: Record<string, unknown> = {}) {
    return {
      format: "fly-brain-manifest/1",
      generatedAt: "2026-09-26T22:04:11.707Z",
      generator: "scripts/build-fly-connectome.ts",
      source: {
        dataset: "mcns",
        version: "1.0",
        access: "Codex static export",
        license: "CC-BY-4.0",
        attribution: "Male Adult Fly CNS (MCNS) v1.0 — Janelia et al.",
      },
      binary: {
        file: "connectome.bin.gz",
        formatVersion: 1,
        sha256: "bdd7457ec7b8b1435a7ab4cbe70540b5a0ab0c11387201ce29a3e3b0fc8b860e",
        sizeBytes: 27500977,
        neuronCount: 166700,
        edgeCount: 6242118,
      },
      weights: {
        unit: "signed-syn-count",
        aggregation: "sum of syn_count per neuron pair across neuropils",
        excitatory: ["ACH", "GLUT", "DA", "OA", "SER"],
        inhibitory: ["GABA"],
        unknownDefaultsTo: "+1 (rows counted in build report)",
      },
      groups: [
        { id: 0, name: "OLF_OS", region: "sensory" },
        { id: 9, name: "OTHER", region: "central" },
      ],
      countsByGroup: { OLF_OS: 2755, OTHER: 158298 },
      types: ["", "ALIN1", "KC-a'b'ap"],
      ...overrides,
    };
  }

  it("accepts a manifest shaped like the committed FT-1 artifact", () => {
    expect(flyBrainManifestSchema.safeParse(validManifest()).success).toBe(true);
  });

  it("rejects an unknown manifest format discriminator", () => {
    expectReject(flyBrainManifestSchema.safeParse(validManifest({ format: "fly-brain-manifest/2" })));
  });

  it("rejects a malformed sha256", () => {
    const binary = { ...(validManifest().binary as Record<string, unknown>) };
    binary.sha256 = "zz";
    expectReject(flyBrainManifestSchema.safeParse(validManifest({ binary })));
  });

  it("rejects non-positive binary counts", () => {
    const binary = { ...(validManifest().binary as Record<string, unknown>) };
    binary.neuronCount = 0;
    expectReject(flyBrainManifestSchema.safeParse(validManifest({ binary })));
  });

  it("accepts an empty-string type entry (untyped OTHER neurons)", () => {
    expect(flyBrainManifestSchema.safeParse(validManifest({ types: ["", ""] })).success).toBe(true);
  });
});

// --- memory payloads ---------------------------------------------------------

describe("flyMemoryPutSchema scope rules", () => {
  const freshFly = {
    scope: "global",
    schemaVersion: 1,
    precedentCount: 0,
    weights: null,
  };
  const trainedGlobal = {
    ...freshFly,
    precedentCount: 25,
    weights: "H4sIAAAAAAAA/2NgYGBgAgAAAP//AwAV6QEAAAA=",
  };

  it("accepts a trained global payload without chatId", () => {
    expect(flyMemoryPutSchema.safeParse(trainedGlobal).success).toBe(true);
  });

  it("accepts a fresh-fly payload (null weights, zero precedents)", () => {
    expect(flyMemoryPutSchema.safeParse(freshFly).success).toBe(true);
  });

  it("rejects chat scope without chatId", () => {
    expectReject(flyMemoryPutSchema.safeParse({ ...trainedGlobal, scope: "chat" }));
  });

  it("accepts chat scope with chatId", () => {
    expect(flyMemoryPutSchema.safeParse({ ...trainedGlobal, scope: "chat", chatId: "chat_1" }).success).toBe(true);
  });

  it("rejects global scope carrying a chatId", () => {
    expectReject(flyMemoryPutSchema.safeParse({ ...trainedGlobal, chatId: "chat_1" }));
  });

  it("rejects a non-base64 weights blob", () => {
    expectReject(flyMemoryPutSchema.safeParse({ ...trainedGlobal, weights: "not base64!!" }));
  });

  it("rejects a negative precedent count", () => {
    expectReject(flyMemoryPutSchema.safeParse({ ...trainedGlobal, precedentCount: -1 }));
  });
});

describe("flyMemoryGetResponseSchema", () => {
  it("accepts the fresh-fly GET shape (missing row is served, never 404)", () => {
    expect(
      flyMemoryGetResponseSchema.safeParse({
        scope: "global",
        schemaVersion: 1,
        precedentCount: 0,
        weights: null,
        updatedAt: "2026-09-27T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("rejects chat scope without chatId on the read side too", () => {
    expectReject(
      flyMemoryGetResponseSchema.safeParse({
        scope: "chat",
        schemaVersion: 1,
        precedentCount: 3,
        weights: null,
        updatedAt: "2026-09-27T00:00:00.000Z",
      }),
    );
  });
});
