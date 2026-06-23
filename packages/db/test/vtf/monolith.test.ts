import { describe, it, expect } from "bun:test";
import {
  packMonolith,
  unpackMonolith,
} from "../../src/vtf/monolith.js";
import {
  serializeCharacterFolder,
  parseCharacterFolder,
  PERSONALITY_SUMMARY_STASH_KEY,
  type VtfCharacterContent,
} from "../../src/vtf/index.js";

// ─── Factories ─────────────────────────────────────────────────────────────

/** A fully-populated character content (every content field non-empty). */
function fullCharacter(): VtfCharacterContent {
  return {
    name: "Silvius",
    description: "[Base: calm]\nSilver-haired and watchful.",
    personalitySummary: null,
    defaultScenario: "A tavern at the forest's edge.",
    firstMessage: "The door creaks open.",
    mesExample: "<START>\n{{char}}: Welcome.",
    mesExampleMode: "depth",
    mesExampleDepth: 4,
    alternateGreetings: ["A second opener.", "A third opener."],
    postHistoryInstructions: "Keep it brief.",
    creatorNotes: "Internal notes for the author.",
    depthPrompt: "Remember the silver scar.",
    depthPromptDepth: 4,
    depthPromptRole: "system",
    systemPrompt: "Respond in second person.",
    tags: ["modern", "werewolf", "fdom"],
    extensions: { creator: "anonymous", character_version: "1.0", talkativeness: "0.5", fav: false },
  };
}

/** Minimal valid character (required name + description only). */
function minimalCharacter(): VtfCharacterContent {
  return {
    name: "Bare",
    description: "Just a description.",
    personalitySummary: null,
    defaultScenario: null,
    firstMessage: "",
    mesExample: null,
    mesExampleMode: "always",
    mesExampleDepth: 4,
    alternateGreetings: [],
    postHistoryInstructions: null,
    creatorNotes: null,
    depthPrompt: null,
    depthPromptDepth: null,
    depthPromptRole: null,
    systemPrompt: null,
    tags: [],
    extensions: {},
  };
}

/** Character whose instructions are present but depth has only config (no prompt text). */
function depthConfigOnly(): VtfCharacterContent {
  return {
    ...minimalCharacter(),
    name: "Cfg",
    depthPrompt: null,
    depthPromptDepth: 2,
    depthPromptRole: "user",
  };
}

// ─── Pack: structure ──────────────────────────────────────────────────────

describe("monolith: pack structure", () => {
  it("emits frontmatter + all seven canonical sections + extensions fence on a full character", () => {
    const md = packMonolith(fullCharacter());
    // Frontmatter carries name + depth config in vt.
    expect(md).toContain("name: Silvius");
    expect(md).toContain("depth_prompt_depth: 4");
    expect(md).toContain("depth_prompt_role: system");
    // All seven body sections present, in order.
    const order = ["# PERSONALITY", "# SCENARIO", "# EXAMPLES", "# SYSTEM", "# POST-HISTORY", "# DEPTH PROMPT", "# GREETINGS"].map((h) => md.indexOf(h));
    for (const idx of order) expect(idx).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < order.length; i++) expect(order[i]!).toBeGreaterThan(order[i - 1]!);
    // Functional section bodies present.
    expect(md).toContain("# SYSTEM\nRespond in second person.");
    expect(md).toContain("# POST-HISTORY\nKeep it brief.");
    expect(md).toContain("# DEPTH PROMPT\nRemember the silver scar.");
    // Inline greetings under # GREETINGS.
    expect(md).toContain("# GREETINGS\nThe door creaks open.");
    expect(md).toContain("=== ALT 1 ===");
    expect(md).toContain("=== ALT 2 ===");
    // Extensions fence present with canonical (sorted) JSON, creator/version stripped.
    expect(md).toContain("```vtf-extensions");
    expect(md).toContain('"fav": false');
    expect(md).toContain('"talkativeness": "0.5"');
    expect(md).not.toMatch(/"creator"/);
    expect(md).not.toMatch(/"character_version"/);
  });

  it("omits optional sections + the fence on a minimal character", () => {
    const md = packMonolith(minimalCharacter());
    expect(md).toContain("# PERSONALITY");
    expect(md).not.toContain("# SCENARIO");
    expect(md).not.toContain("# EXAMPLES");
    expect(md).not.toContain("# SYSTEM");
    expect(md).not.toContain("# POST-HISTORY");
    expect(md).not.toContain("# DEPTH PROMPT");
    expect(md).not.toContain("# GREETINGS");
    expect(md).not.toContain("```vtf-extensions");
    // vt still carries the mes_example defaults but no depth config.
    expect(md).toContain("mes_example_mode: always");
    expect(md).not.toContain("depth_prompt_depth");
    expect(md).not.toContain("depth_prompt_role");
  });

  it("emits depth config in frontmatter even when the depth prompt body is empty", () => {
    const md = packMonolith(depthConfigOnly());
    expect(md).toContain("depth_prompt_depth: 2");
    expect(md).toContain("depth_prompt_role: user");
    expect(md).not.toContain("# DEPTH PROMPT");
  });
});

// ─── Round-trip: Character → monolith → Character ─────────────────────────

describe("monolith: Character → monolith → Character", () => {
  it("preserves every content field on a fully-populated character", () => {
    const back = unpackMonolith(packMonolith(fullCharacter()));
    expect(back).toEqual(fullCharacter());
  });

  it("preserves a minimal character (optionals stay null/empty)", () => {
    const back = unpackMonolith(packMonolith(minimalCharacter()));
    expect(back).toEqual(minimalCharacter());
  });

  it("preserves depth config without a depth prompt body", () => {
    const back = unpackMonolith(packMonolith(depthConfigOnly()));
    expect(back).toEqual(depthConfigOnly());
  });

  it("preserves creator + character_version through frontmatter (stripped from the fence)", () => {
    const md = packMonolith(fullCharacter());
    const back = unpackMonolith(md);
    expect(back.extensions.creator).toBe("anonymous");
    expect(back.extensions.character_version).toBe("1.0");
  });

  it("preserves a non-null legacy personalitySummary via the extensions stash", () => {
    const original = fullCharacter();
    original.personalitySummary = "Legacy personality summary.";
    const back = unpackMonolith(packMonolith(original));
    expect(back.personalitySummary).toBe("Legacy personality summary.");
    expect(back.extensions[PERSONALITY_SUMMARY_STASH_KEY]).toBe("Legacy personality summary.");
  });

  it("round-trips a nested character_book inside the extensions fence", () => {
    const original = fullCharacter();
    original.extensions = {
      ...original.extensions,
      character_book: { entries: [{ keys: ["forest"], content: "The forest is dark." }] },
    };
    const back = unpackMonolith(packMonolith(original));
    expect(back.extensions.character_book).toEqual({
      entries: [{ keys: ["forest"], content: "The forest is dark." }],
    });
  });
});

// ─── Round-trip: monolith → Character → monolith (textual stability) ──────

describe("monolith: monolith → Character → monolith (textually stable)", () => {
  it("is textually identical on a fully-populated character", () => {
    const md1 = packMonolith(fullCharacter());
    const md2 = packMonolith(unpackMonolith(md1));
    expect(md2).toBe(md1);
  });

  it("is textually identical on a minimal character", () => {
    const md1 = packMonolith(minimalCharacter());
    const md2 = packMonolith(unpackMonolith(md1));
    expect(md2).toBe(md1);
  });
});

// ─── Cross-representation: storage ↔ monolith ────────────────────────────

describe("monolith ↔ storage (facade) interop", () => {
  it("storage → monolith → storage is byte-identical on a full character", () => {
    const folder1 = serializeCharacterFolder(fullCharacter());
    const character = parseCharacterFolder(folder1);
    const md = packMonolith(character);
    const character2 = unpackMonolith(md);
    const folder2 = serializeCharacterFolder(character2);
    expect(entriesToFileMap(folder2)).toEqual(entriesToFileMap(folder1));
  });

  it("monolith → storage → monolith is textually identical on a full character", () => {
    const md1 = packMonolith(fullCharacter());
    const character = unpackMonolith(md1);
    const folder = serializeCharacterFolder(character);
    const character2 = parseCharacterFolder(folder);
    const md2 = packMonolith(character2);
    expect(md2).toBe(md1);
  });

  it("storage → monolith → storage is byte-identical on a minimal character", () => {
    const folder1 = serializeCharacterFolder(minimalCharacter());
    const character = parseCharacterFolder(folder1);
    const md = packMonolith(character);
    const character2 = unpackMonolith(md);
    const folder2 = serializeCharacterFolder(character2);
    expect(entriesToFileMap(folder2)).toEqual(entriesToFileMap(folder1));
  });
});

// ─── Tolerant parsing ─────────────────────────────────────────────────────

describe("monolith: tolerant parsing", () => {
  it("degrades gracefully on a near-empty document (defaults, no throw)", () => {
    const back = unpackMonolith("---\nname: Empty\n---\n\n# PERSONALITY\nA body.\n");
    expect(back.name).toBe("Empty");
    expect(back.description).toBe("A body.");
    expect(back.systemPrompt).toBeNull();
    expect(back.firstMessage).toBe("");
    expect(back.alternateGreetings).toEqual([]);
    expect(back.extensions).toEqual({});
  });

  it("ignores an unknown body section (out-of-scope document-level unknown)", () => {
    const md = packMonolith(fullCharacter()) + "\n\n# CUSTOM NOTES\nSome author note.\n";
    const back = unpackMonolith(md);
    // Known fields still round-trip; the unknown section is dropped (documented lossiness).
    expect(back.systemPrompt).toBe("Respond in second person.");
    expect(back.description).toBe(fullCharacter().description);
  });

  it("parses a hand-authored monolith with only frontmatter + PERSONALITY", () => {
    const hand = "---\nname: Hand\n---\n\n# PERSONALITY\nHand-authored body.\n";
    const back = unpackMonolith(hand);
    expect(back.name).toBe("Hand");
    expect(back.description).toBe("Hand-authored body.");
    expect(back.tags).toEqual([]);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function entriesToFileMap(entries: { path: string; content: string }[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const e of entries) map[e.path] = e.content;
  return map;
}
