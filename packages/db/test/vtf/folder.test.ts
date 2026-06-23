import { describe, it, expect } from "bun:test";
import {
  serializeCharacterFolder,
  parseCharacterFolder,
  readGreetingsFromFolder,
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

// ─── Folder layout ─────────────────────────────────────────────────────────

describe("facade: folder layout", () => {
  it("emits profile.md + instructions.json + extensions.json + greetings/_index.yaml + one .md per greeting", () => {
    const entries = serializeCharacterFolder(fullCharacter());
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual([
      "extensions.json",
      "greetings/_index.yaml",
      "greetings/g_0000.md",
      "greetings/g_0001.md",
      "greetings/g_0002.md",
      "instructions.json",
      "profile.md",
    ]);
  });
});

// ─── Round-trip: Character → folder → Character ────────────────────────────

describe("facade: Character → folder → Character", () => {
  it("preserves every content field on a fully-populated character", () => {
    const original = fullCharacter();
    const entries = serializeCharacterFolder(original);
    const back = parseCharacterFolder(entries);
    expect(back).toEqual(original);
  });

  it("preserves a minimal character (optionals stay null/empty)", () => {
    const original = minimalCharacter();
    const back = parseCharacterFolder(serializeCharacterFolder(original));
    expect(back).toEqual(original);
  });

  it("preserves creator + character_version through frontmatter (stripped from extensions.json)", () => {
    const original = fullCharacter();
    const entries = serializeCharacterFolder(original);
    const extensionsJson = entries.find((e) => e.path === "extensions.json")!.content;
    const parsedExtensions = JSON.parse(extensionsJson);
    expect(parsedExtensions).not.toHaveProperty("creator");
    expect(parsedExtensions).not.toHaveProperty("character_version");
    // Round-trip restores them via the frontmatter merge.
    const back = parseCharacterFolder(entries);
    expect(back.extensions.creator).toBe("anonymous");
    expect(back.extensions.character_version).toBe("1.0");
  });

  it("preserves a non-null legacy personalitySummary via the extensions stash", () => {
    const original = fullCharacter();
    original.personalitySummary = "Legacy personality summary.";
    const back = parseCharacterFolder(serializeCharacterFolder(original));
    expect(back.personalitySummary).toBe("Legacy personality summary.");
    // The stash key is internal — it surfaces in extensions but is pulled back out.
    expect(back.extensions[PERSONALITY_SUMMARY_STASH_KEY]).toBe("Legacy personality summary.");
  });

  it("drops an empty/whitespace personalitySummary (no stash pollution)", () => {
    const original = fullCharacter();
    original.personalitySummary = "   ";
    const back = parseCharacterFolder(serializeCharacterFolder(original));
    expect(back.personalitySummary).toBeNull();
    expect(back.extensions[PERSONALITY_SUMMARY_STASH_KEY]).toBeUndefined();
  });
});

// ─── Round-trip: folder → Character → folder (canonical stability) ─────────

describe("facade: folder → Character → folder (byte-stable)", () => {
  it("is idempotent on a fully-populated character", () => {
    const entries1 = serializeCharacterFolder(fullCharacter());
    const reparsed = parseCharacterFolder(entries1);
    const entries2 = serializeCharacterFolder(reparsed);
    expect(entriesToFileMap(entries2)).toEqual(entriesToFileMap(entries1));
  });

  it("is idempotent on a minimal character", () => {
    const entries1 = serializeCharacterFolder(minimalCharacter());
    const reparsed = parseCharacterFolder(entries1);
    const entries2 = serializeCharacterFolder(reparsed);
    expect(entriesToFileMap(entries2)).toEqual(entriesToFileMap(entries1));
  });
});

// ─── Greeting extraction helper ────────────────────────────────────────────

describe("facade: readGreetingsFromFolder", () => {
  it("returns the greeting list without parsing the whole character", () => {
    const greetings = readGreetingsFromFolder(serializeCharacterFolder(fullCharacter()));
    expect(greetings).toHaveLength(3);
    expect(greetings.map((g) => g.primary)).toEqual([true, false, false]);
    expect(greetings.map((g) => g.content)).toEqual([
      "The door creaks open.",
      "A second opener.",
      "A third opener.",
    ]);
  });
});

// ─── Tolerant parsing ──────────────────────────────────────────────────────

describe("facade: tolerant parsing", () => {
  it("routes functional fields through instructions.json, not profile.md", () => {
    const original = fullCharacter();
    const entries = serializeCharacterFolder(original);
    const profileMd = entries.find((e) => e.path === "profile.md")!.content;
    const instructionsJson = entries.find((e) => e.path === "instructions.json")!.content;
    // profile.md is prose-only — no functional sections.
    expect(profileMd).not.toContain("# SYSTEM");
    expect(profileMd).not.toContain("# POST-HISTORY");
    expect(profileMd).not.toContain("# DEPTH PROMPT");
    // instructions.json carries the functional fields.
    const instructions = JSON.parse(instructionsJson);
    expect(instructions.system_prompt).toBe("Respond in second person.");
    expect(instructions.post_history_instructions).toBe("Keep it brief.");
    expect(instructions.depth_prompt).toEqual({ depth: 4, prompt: "Remember the silver scar.", role: "system" });
  });

  it("degrades gracefully when profile.md is missing (defaults, no throw)", () => {
    const entries = serializeCharacterFolder(fullCharacter()).filter((e) => e.path !== "profile.md");
    const back = parseCharacterFolder(entries);
    expect(back.name).toBe("");
    // Extensions + greetings still parsed. creator is frontmatter-owned, so
    // without profile.md there is no source to restore it from (undefined is
    // correct); but non-frontmatter extensions like talkativeness survive.
    expect(back.extensions.talkativeness).toBe("0.5");
    expect(back.extensions.creator).toBeUndefined();
    expect(back.firstMessage).toBe("The door creaks open.");
  });

  it("degrades gracefully when greetings/ is missing (empty firstMessage, no throw)", () => {
    const entries = serializeCharacterFolder(fullCharacter()).filter((e) => !e.path.startsWith("greetings/"));
    const back = parseCharacterFolder(entries);
    expect(back.firstMessage).toBe("");
    expect(back.alternateGreetings).toEqual([]);
    // Profile + extensions still parsed.
    expect(back.name).toBe("Silvius");
    expect(back.extensions.talkativeness).toBe("0.5");
  });
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function entriesToFileMap(entries: { path: string; content: string }[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const e of entries) map[e.path] = e.content;
  return map;
}
