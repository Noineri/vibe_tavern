import { describe, expect, test } from "vitest";
import { deriveOwner, getToolSupport, isFreeModel, normalizeProviderModel } from "./provider-model-capabilities.js";

describe("provider model capabilities", () => {
  test("derives supported, unknown, and unsupported from canonical tools metadata", () => {
    expect(getToolSupport(true)).toBe("supported");
    expect(getToolSupport(undefined)).toBe("unknown");
    expect(getToolSupport(false)).toBe("unsupported");
  });

  test("normalizes legacy cached thinking without dropping rich model metadata", () => {
    expect(normalizeProviderModel({
      id: "legacy",
      label: "Legacy",
      contextLength: 32_000,
      description: "kept",
      pricing: { input: 1, output: 2 },
      capabilities: { thinking: true, tools: false, vision: true },
    })).toEqual({
      id: "legacy",
      label: "Legacy",
      contextLength: 32_000,
      description: "kept",
      pricing: { input: 1, output: 2 },
      capabilities: { reasoning: true, tools: false, vision: true },
      toolSupport: "unsupported",
    });
  });
});

describe("deriveOwner", () => {
  // Mirrors SillyTavern's groupModelsByVendor heuristics in priority order —
  // see deriveOwner doc comment. VT cannot key on provider type (every
  // aggregator reports openai_compat), so this works from id/label instead.
  test("slash-prefix in id → vendor (OpenRouter / Chutes / NanoGPT)", () => {
    expect(deriveOwner({ id: "anthropic/claude-3.5-sonnet", label: "Claude" })).toBe("anthropic");
    expect(deriveOwner({ id: "chutesai/Llama-3.1", label: "Llama" })).toBe("chutesai");
  });

  test("colon-prefix in label → vendor (ElectronHub)", () => {
    expect(deriveOwner({ id: "gpt-4o-2024", label: "OpenAI:gpt-4o" })).toBe("OpenAI");
  });

  test("dash-prefix in id → vendor (NanoGPT dashed, no slash/colon)", () => {
    expect(deriveOwner({ id: "deepseek-2", label: "DeepSeek 2" })).toBe("deepseek");
  });

  test("slash beats colon beats dash (priority order)", () => {
    // id has slash → wins over a colon in the label.
    expect(deriveOwner({ id: "x/y", label: "Z:1" })).toBe("x");
    // no slash, label has colon → wins over a dash in the id.
    expect(deriveOwner({ id: "a-b", label: "C:D" })).toBe("C");
  });

  test("fallback to 'Other' when no delimiter is present", () => {
    expect(deriveOwner({ id: "gpt4", label: "GPT 4" })).toBe("Other");
  });
});

describe("isFreeModel", () => {
  test("free when both input and output pricing are exactly 0", () => {
    expect(isFreeModel({ pricing: { input: 0, output: 0 } })).toBe(true);
  });

  test("not free when either price is non-zero", () => {
    expect(isFreeModel({ pricing: { input: 0, output: 1 } })).toBe(false);
    expect(isFreeModel({ pricing: { input: 5, output: 0 } })).toBe(false);
  });

  test("missing pricing is treated as NOT free (unknown cost)", () => {
    expect(isFreeModel({})).toBe(false);
    expect(isFreeModel({ pricing: {} })).toBe(false);
    expect(isFreeModel({ pricing: { input: 0 } })).toBe(false);
  });
});
