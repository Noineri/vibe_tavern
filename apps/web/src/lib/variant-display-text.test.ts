import { describe, expect, test } from "bun:test";
import { brandId, REGEX_SUBSTITUTE, type RegexPreset, type RegexPresetId } from "@vibe-tavern/domain";
import { deriveVariantDisplayText } from "./variant-display-text.js";

function preset(overrides: Partial<RegexPreset> = {}): RegexPreset {
  return {
    id: brandId<RegexPresetId>("display-rule"), name: "display rule",
    findRegex: "/secret/g", replaceString: "{{char}}", trimStrings: [],
    substituteRegex: REGEX_SUBSTITUTE.None, disabled: false, markdownOnly: true,
    promptOnly: false, runOnEdit: false, minDepth: null, maxDepth: null,
    placement: [2], isGlobal: true, sortOrder: 0, profileId: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const macroContext = { characterName: "A(B)", personaName: "Reader" };

describe("deriveVariantDisplayText", () => {
  test("resolves base macros, then display regex, then replacement macros", () => {
    const presets = [preset({ findRegex: "/A\\(B\\) says secret/g", replaceString: "{{user}} listens" })];
    expect(deriveVariantDisplayText("{{char}} says secret", { macroContext, presets })).toBe("Reader listens");
  });

  test("keeps native regex syntax while escaping macro values in find patterns", () => {
    const presets = [preset({ findRegex: "/^{{char}}: (.*)$/g", replaceString: "$1", substituteRegex: REGEX_SUBSTITUTE.Escaped })];
    expect(deriveVariantDisplayText("A(B): hello", { macroContext, presets })).toBe("hello");
  });

  test("supports an already resolved or deliberately literal base without dropping the output macro pass", () => {
    expect(deriveVariantDisplayText("{{char}} secret", { macroContext, presets: [], resolveBaseMacros: false }))
      .toBe("{{char}} secret");
    expect(deriveVariantDisplayText("secret", { macroContext, presets: [preset()], resolveBaseMacros: false }))
      .toBe("A(B)");
  });

  test("handles empty text, missing context and invalid regex without mutation", () => {
    const presets = [preset({ findRegex: "[" })];
    const before = structuredClone(presets);
    expect(deriveVariantDisplayText("", { macroContext, presets })).toBe("");
    expect(deriveVariantDisplayText("{{char}}", { macroContext: null, presets })).toBe("{{char}}");
    expect(deriveVariantDisplayText("secret", { macroContext, presets })).toBe("secret");
    expect(presets).toEqual(before);
  });
});
