/**
 * Regex engine unit tests (REGEX_EXTENSION_PLAN, RX-3).
 *
 * Pure black-box pins for ST-parity semantics: `/pattern/flags` parsing,
 * `{{match}}` / `$1` / `$<name>` replacement references, Trim-Out strings,
 * `substituteRegex` macro modes (NONE/RAW/ESCAPED), compile-failure skipping,
 * and placement/depth filtering. These pin the exact behavior the orchestrator
 * hooks (RX-8..RX-10) depend on.
 */
import { describe, it, expect } from "bun:test";
import { brandId, REGEX_PLACEMENT, REGEX_SUBSTITUTE, type RegexPreset, type RegexPresetId } from "@vibe-tavern/domain";

import {
  applyRegexLayer,
  compileRegexScript,
  filterRegexPresets,
  parseFindRegex,
  type RegexMacroSource,
} from "../src/regex-engine.ts";

function makePreset(overrides: Partial<RegexPreset> = {}): RegexPreset {
  return {
    id: brandId<RegexPresetId>("rx_test_1"),
    name: "test preset",
    findRegex: "/foo/g",
    replaceString: "bar",
    trimStrings: [],
    substituteRegex: REGEX_SUBSTITUTE.None,
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    minDepth: null,
    maxDepth: null,
    placement: [REGEX_PLACEMENT.AiOutput],
    isGlobal: false,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const macros: RegexMacroSource = {
  resolve: (t: string) => t.replaceAll("{{char}}", "A(B)"),
  resolveEscaped: (t: string) => t.replaceAll("{{char}}", "A\\(B\\)"),
};

describe("parseFindRegex", () => {
  it("parses the delimited /pattern/flags form", () => {
    expect(parseFindRegex("/foo/gi")).toEqual({ pattern: "foo", flags: "gi" });
  });

  it("treats a non-delimited string as the whole pattern with default g", () => {
    expect(parseFindRegex("plain text")).toEqual({ pattern: "plain text", flags: "g" });
  });

  it("dedupes repeated flags and keeps g", () => {
    expect(parseFindRegex("/a/igg")).toEqual({ pattern: "a", flags: "ig" });
  });

  it("appends g when the author omitted it, preserving the rest", () => {
    expect(parseFindRegex("/a/i")).toEqual({ pattern: "a", flags: "ig" });
  });

  it("allows slashes inside the delimited pattern body", () => {
    expect(parseFindRegex("/a\\/b/g")).toEqual({ pattern: "a\\/b", flags: "g" });
  });
});

describe("compile + run", () => {
  it("performs basic capture-group replacement ($1)", () => {
    const compiled = compileRegexScript(makePreset({ findRegex: "/\\*(.+?)\\*/g", replaceString: "<i>$1</i>" }));
    expect(compiled).not.toBeNull();
    expect(compiled!.run("a *b* c")).toBe("a <i>b</i> c");
  });

  it("expands {{match}} to the full match text", () => {
    const compiled = compileRegexScript(makePreset({ findRegex: "/\\d+/g", replaceString: "[{{match}}]" }));
    expect(compiled!.run("a12b")).toBe("a[12]b");
  });

  it("applies trimStrings to each match before {{match}} expansion", () => {
    const compiled = compileRegexScript(
      makePreset({ findRegex: "/a\\w+/g", replaceString: "{{match}}", trimStrings: ["x"] }),
    );
    expect(compiled!.run("axb axc")).toBe("ab ac");
  });

  it("supports named group references $<name>", () => {
    const compiled = compileRegexScript(
      makePreset({ findRegex: "/(?<word>hello) world/g", replaceString: "$<word> there" }),
    );
    expect(compiled!.run("hello world")).toBe("hello there");
  });

  it("does not re-interpret $ in matched content (literal $1 survives)", () => {
    const compiled = compileRegexScript(makePreset({ findRegex: "/\\$1/g", replaceString: "({{match}})" }));
    expect(compiled!.run("cost: $1")).toBe("cost: ($1)");
  });

  it("tolerates case-insensitive {{MATCH}} spelling", () => {
    const compiled = compileRegexScript(makePreset({ findRegex: "/\\d+/g", replaceString: "[{{MATCH}}]" }));
    expect(compiled!.run("a7b")).toBe("a[7]b");
  });

  it("applies globally even when the author omitted the g flag", () => {
    const compiled = compileRegexScript(makePreset({ findRegex: "/a/gi", replaceString: "-" }));
    expect(compiled!.run("AaA")).toBe("---");
  });

  it("returns null for an un-compilable pattern instead of throwing", () => {
    expect(compileRegexScript(makePreset({ findRegex: "/([/g" }))).toBeNull();
  });
});

describe("substituteRegex macro modes", () => {
  it("NONE leaves {{char}} literal in the pattern (no substitution)", () => {
    const compiled = compileRegexScript(
      makePreset({ findRegex: "/{{char}}/g", replaceString: "[{{match}}]", substituteRegex: REGEX_SUBSTITUTE.None }),
      macros,
    );
    // The pattern still looks for literal "{{char}}"; input has none → unchanged.
    expect(compiled!.run("xA(B)y")).toBe("xA(B)y");
  });

  it("RAW substitutes macros unescaped — A(B) compiles as a GROUP", () => {
    const compiled = compileRegexScript(
      makePreset({ findRegex: "/{{char}}/g", replaceString: "[{{match}}]", substituteRegex: REGEX_SUBSTITUTE.Raw }),
      macros,
    );
    // Raw pattern A(B) matches "AB" (B captured as a group), NOT "A(B)".
    expect(compiled!.run("x ABy z")).toBe("x [AB]y z");
    expect(compiled!.run("xA(B)y")).toBe("xA(B)y");
  });

  it("ESCAPED substitutes regex-escaped macros — A(B) matches literally", () => {
    const compiled = compileRegexScript(
      makePreset({
        findRegex: "/{{char}}/g",
        replaceString: "[{{match}}]",
        substituteRegex: REGEX_SUBSTITUTE.Escaped,
      }),
      macros,
    );
    expect(compiled!.run("xA(B)y")).toBe("x[A(B)]y");
  });
});

describe("applyRegexLayer", () => {
  it("applies presets in array order and skips un-compilable ones silently", () => {
    const broken = makePreset({ name: "broken", findRegex: "/([/g", replaceString: "never" });
    const italics = makePreset({ name: "italics", findRegex: "/\\*(.+?)\\*/g", replaceString: "<i>$1</i>" });
    const shout = makePreset({ name: "shout", findRegex: "/wow/g", replaceString: "WOW" });
    expect(applyRegexLayer("*wow*", [broken, italics, shout])).toBe("<i>WOW</i>");
  });

  it("returns input unchanged when no preset applies", () => {
    const disabled = makePreset({ disabled: true });
    expect(applyRegexLayer("untouched", [disabled])).toBe("untouched");
    expect(applyRegexLayer("untouched", [])).toBe("untouched");
  });
});

describe("filterRegexPresets", () => {
  it("excludes disabled presets and wrong-placement presets", () => {
    const presets = [
      makePreset({ id: brandId<RegexPresetId>("rx_d"), disabled: true, placement: [REGEX_PLACEMENT.AiOutput] }),
      makePreset({ id: brandId<RegexPresetId>("rx_p"), placement: [REGEX_PLACEMENT.UserInput] }),
      makePreset({ id: brandId<RegexPresetId>("rx_ok"), placement: [REGEX_PLACEMENT.AiOutput] }),
    ];
    const kept = filterRegexPresets(presets, { placement: REGEX_PLACEMENT.AiOutput });
    expect(kept.map((p) => p.id)).toEqual([brandId<RegexPresetId>("rx_ok")]);
  });

  it("honors multi-placement registration", () => {
    const both = makePreset({ placement: [REGEX_PLACEMENT.UserInput, REGEX_PLACEMENT.WorldInfo] });
    expect(filterRegexPresets([both], { placement: REGEX_PLACEMENT.UserInput })).toHaveLength(1);
    expect(filterRegexPresets([both], { placement: REGEX_PLACEMENT.Reasoning })).toHaveLength(0);
  });

  it("treats null depth bounds as unlimited", () => {
    const unlimited = makePreset({ minDepth: null, maxDepth: null });
    expect(filterRegexPresets([unlimited], { placement: REGEX_PLACEMENT.AiOutput, depth: 0 })).toHaveLength(1);
    expect(filterRegexPresets([unlimited], { placement: REGEX_PLACEMENT.AiOutput, depth: 99 })).toHaveLength(1);
  });

  it("enforces the inclusive [minDepth, maxDepth] window", () => {
    const windowed = makePreset({ minDepth: 0, maxDepth: 2 });
    expect(filterRegexPresets([windowed], { placement: REGEX_PLACEMENT.AiOutput, depth: 0 })).toHaveLength(1);
    expect(filterRegexPresets([windowed], { placement: REGEX_PLACEMENT.AiOutput, depth: 2 })).toHaveLength(1);
    expect(filterRegexPresets([windowed], { placement: REGEX_PLACEMENT.AiOutput, depth: 5 })).toHaveLength(0);
  });

  it("does not filter by depth when none is requested", () => {
    const windowed = makePreset({ minDepth: 0, maxDepth: 2 });
    expect(filterRegexPresets([windowed], { placement: REGEX_PLACEMENT.AiOutput })).toHaveLength(1);
  });
});
