import { describe, expect, test } from "bun:test";
import {
  COAUTHOR_DEFAULT_MAX_TOKENS,
  COAUTHOR_GENERATION_DEFAULTS,
  COAUTHOR_UNKNOWN_CONTEXT_BUDGET,
  PROVIDER_PROFILE_GENERATION_DEFAULTS,
  resolveCoauthorGenerationSettings,
} from "../src/coauthor-generation-settings.js";

/**
 * CG-1 domain derivation tests: resolveCoauthorGenerationSettings is the ONE
 * place a connection's effective Co-Author set is derived (the generation
 * boundary, modal and token counter all read it). Pins: null → defaults,
 * stored values win, and the defaults' provenance — the RP new-connection
 * sampler defaults plus exactly the two owner-ruled deviations.
 */

describe("resolveCoauthorGenerationSettings", () => {
  test("null → the Co-Author defaults (same reference)", () => {
    expect(resolveCoauthorGenerationSettings(null)).toBe(COAUTHOR_GENERATION_DEFAULTS);
    expect(resolveCoauthorGenerationSettings(undefined)).toBe(COAUTHOR_GENERATION_DEFAULTS);
  });

  test("empty stored set resolves to the complete defaults", () => {
    expect(resolveCoauthorGenerationSettings({})).toEqual(COAUTHOR_GENERATION_DEFAULTS);
  });

  test("stored values win over every default", () => {
    const stored = {
      maxTokens: 1234,
      contextBudget: 65_536,
      pinContextBudget: true,
      temperature: 0.42,
      topK: 49,
      stopSequences: ["\\n\\n"],
      samplerSetId: "sset_9",
    };
    const resolved = resolveCoauthorGenerationSettings(stored);
    expect(resolved.maxTokens).toBe(1234);
    expect(resolved.contextBudget).toBe(65_536);
    expect(resolved.pinContextBudget).toBe(true);
    expect(resolved.temperature).toBe(0.42);
    expect(resolved.topK).toBe(49);
    expect(resolved.stopSequences).toEqual(["\\n\\n"]);
    expect(resolved.samplerSetId).toBe("sset_9");
    // Untouched fields keep their defaults — the set comes back complete.
    expect(resolved.typicalP).toBe(COAUTHOR_GENERATION_DEFAULTS.typicalP);
    expect(resolved.dryBase).toBe(COAUTHOR_GENERATION_DEFAULTS.dryBase);
    expect(resolved.reasoningEffort).toBe(COAUTHOR_GENERATION_DEFAULTS.reasoningEffort);
    expect(Object.keys(resolved).length).toBe(Object.keys(COAUTHOR_GENERATION_DEFAULTS).length);
  });

  test("the resolved set is complete — every overlay field present", () => {
    const resolved = resolveCoauthorGenerationSettings(null);
    const overlayFieldCount = Object.keys(PROVIDER_PROFILE_GENERATION_DEFAULTS).length;
    expect(Object.keys(resolved)).toHaveLength(overlayFieldCount);
    expect(Object.values(resolved).every((v) => v !== undefined)).toBe(true);
  });

  test("a null stored contextBudget resolves to the unknown-context budget, never null", () => {
    const resolved = resolveCoauthorGenerationSettings({ contextBudget: null });
    expect(resolved.contextBudget).toBe(COAUTHOR_UNKNOWN_CONTEXT_BUDGET);
    // The pin flag rides the set untouched.
    expect(resolved.pinContextBudget).toBe(false);
  });
});

describe("COAUTHOR_GENERATION_DEFAULTS provenance", () => {
  test("sampler defaults come from the shared RP new-connection constant (no hand-copies)", () => {
    // Every field the plan does NOT explicitly override equals the RP default.
    expect({ ...COAUTHOR_GENERATION_DEFAULTS, maxTokens: 0, contextBudget: 0 })
      .toEqual({ ...PROVIDER_PROFILE_GENERATION_DEFAULTS, maxTokens: 0, contextBudget: 0 });
  });

  test("exactly two deviations from the RP defaults: max output 8000, unknown-context budget 128000", () => {
    expect(COAUTHOR_GENERATION_DEFAULTS.maxTokens).toBe(COAUTHOR_DEFAULT_MAX_TOKENS);
    expect(COAUTHOR_GENERATION_DEFAULTS.maxTokens).toBe(8_000);
    expect(COAUTHOR_GENERATION_DEFAULTS.contextBudget).toBe(COAUTHOR_UNKNOWN_CONTEXT_BUDGET);
    expect(COAUTHOR_GENERATION_DEFAULTS.contextBudget).toBe(128_000);
  });
});
