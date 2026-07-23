import { describe, expect, test } from "vitest";
import { getToolSupport, normalizeProviderModel } from "./provider-model-capabilities.js";

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
