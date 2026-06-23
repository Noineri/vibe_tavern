import { describe, it, expect } from "bun:test";
import {
  serializeProfileMd,
  parseProfileMd,
  DEFAULT_MES_EXAMPLE_MODE,
  DEFAULT_DEPTH,
  type VtfProfile,
  type ProfileMd,
} from "../../src/vtf/profile-md.js";

// ─── Factories ─────────────────────────────────────────────────────────────

/**
 * A fully-populated PROSE profile (every prose/metadata field non-empty).
 * Functional instruction fields (system/post-history/depth-prompt) are
 * intentionally absent — they live in `instructions.json`, not this codec.
 */
function fullProfile(): ProfileMd {
  return {
    profile: {
      name: "Silvius",
      tags: ["modern", "werewolf", "fdom"],
      creator: "anonymous",
      characterVersion: "1.0",
      creatorNotes: "Line one.\nLine two with: a colon.",
      mesExampleMode: "depth",
      mesExampleDepth: 4,
      description: "[Base: calm] [Appearance: silver hair]",
      scenario: "A tavern at the edge of the forest.",
      mesExample: "<START>\n{{char}}: Hello.\n{{user}}: Hi.",
    },
  };
}

/** Minimal valid profile (only the required name + description). */
function minimalProfile(): ProfileMd {
  return {
    profile: {
      name: "Bare",
      tags: [],
      creator: null,
      characterVersion: null,
      creatorNotes: null,
      mesExampleMode: DEFAULT_MES_EXAMPLE_MODE,
      mesExampleDepth: DEFAULT_DEPTH,
      description: "Just a description.",
      scenario: null,
      mesExample: null,
    },
  };
}

// ─── Round-trip invariants ─────────────────────────────────────────────────

describe("profile-md: Form → MD → Form", () => {
  it("preserves every prose/metadata field on a fully-populated profile", () => {
    const md = serializeProfileMd(fullProfile());
    const parsed = parseProfileMd(md);
    expect(parsed.profile).toEqual(fullProfile().profile);
    expect(parsed.unknownFrontmatter).toEqual([]);
    expect(parsed.unknownVt).toEqual([]);
    expect(parsed.unknownSections).toEqual([]);
  });

  it("preserves a minimal profile (optionals stay null)", () => {
    const md = serializeProfileMd(minimalProfile());
    const parsed = parseProfileMd(md);
    expect(parsed.profile).toEqual(minimalProfile().profile);
  });
});

describe("profile-md: MD → Form → MD (canonical stability)", () => {
  it("is idempotent on a fully-populated profile", () => {
    const md = serializeProfileMd(fullProfile());
    const reparsed = parseProfileMd(md);
    expect(serializeProfileMd(reparsed)).toBe(md);
  });

  it("is idempotent on a minimal profile", () => {
    const md = serializeProfileMd(minimalProfile());
    expect(serializeProfileMd(parseProfileMd(md))).toBe(md);
  });

  it("parses a hand-authored canonical document back to identical MD", () => {
    const handAuthored = [
      "---",
      "name: Andrea",
      "vt:",
      "  mes_example_mode: always",
      "  mes_example_depth: 4",
      "---",
      "",
      "# PERSONALITY",
      "[Base & Appearance]",
      "Andrea is an albino rabbit demihuman.",
      "",
      "# SCENARIO",
      "A VIP host club fronting for trafficking.",
    ].join("\n");
    const reSerialized = serializeProfileMd(parseProfileMd(handAuthored));
    expect(reSerialized).toBe(handAuthored + "\n");
  });
});

// ─── Prose-only contract ───────────────────────────────────────────────────

describe("profile-md: prose-only contract (functional sections are not emitted)", () => {
  it("never emits # SYSTEM / # POST-HISTORY / # DEPTH PROMPT", () => {
    const md = serializeProfileMd(fullProfile());
    expect(md).not.toContain("# SYSTEM");
    expect(md).not.toContain("# POST-HISTORY");
    expect(md).not.toContain("# DEPTH PROMPT");
    expect(md).not.toContain("depth_prompt_");
  });

  it("preserves functional headings losslessly as unknown sections when present in input", () => {
    // A profile.md should never legitimately carry these, but if it does the
    // codec preserves them verbatim (lossless) rather than silently dropping.
    const md = [
      "---",
      "name: X",
      "vt:",
      "  mes_example_mode: always",
      "  mes_example_depth: 4",
      "---",
      "",
      "# PERSONALITY",
      "desc",
      "",
      "# SYSTEM",
      "secret system text",
    ].join("\n");
    const parsed = parseProfileMd(md);
    expect(parsed.unknownSections).toEqual([{ heading: "SYSTEM", body: "secret system text" }]);
    // Re-serialize keeps it losslessly.
    expect(serializeProfileMd(parsed)).toContain("# SYSTEM");
    expect(serializeProfileMd(parsed)).toContain("secret system text");
  });
});

// ─── Canonical emission ────────────────────────────────────────────────────

describe("profile-md: canonical emission", () => {
  it("omits empty optionals (no tags/creator/scenario/etc lines)", () => {
    const md = serializeProfileMd(minimalProfile());
    expect(md).not.toContain("tags:");
    expect(md).not.toContain("creator:");
    expect(md).not.toContain("character_version:");
    expect(md).not.toContain("creator_notes:");
    expect(md).not.toContain("# SCENARIO");
    expect(md).not.toContain("# EXAMPLES");
    // PERSONALITY is always present (required description).
    expect(md).toContain("# PERSONALITY");
  });

  it("emits frontmatter keys in canonical order", () => {
    const md = serializeProfileMd(fullProfile());
    const lines = md.split("\n");
    const idx = (needle: string) => lines.findIndex((l) => l.startsWith(needle));
    expect(idx("name:")).toBeLessThan(idx("tags:"));
    expect(idx("tags:")).toBeLessThan(idx("creator:"));
    expect(idx("creator:")).toBeLessThan(idx("character_version:"));
    expect(idx("character_version:")).toBeLessThan(idx("creator_notes:"));
    expect(idx("creator_notes:")).toBeLessThan(idx("vt:"));
  });

  it("emits prose body sections in canonical order", () => {
    const md = serializeProfileMd(fullProfile());
    const headings = md.split("\n").filter((l) => /^# /.test(l)).map((l) => l.slice(2));
    expect(headings).toEqual(["PERSONALITY", "SCENARIO", "EXAMPLES"]);
  });
});

// ─── Lossless unknowns ─────────────────────────────────────────────────────

describe("profile-md: lossless unknowns", () => {
  it("preserves unknown vt: keys", () => {
    const md = [
      "---",
      "name: X",
      "vt:",
      "  mes_example_mode: always",
      "  mes_example_depth: 4",
      "  future_skill_level: 7",
      "---",
      "",
      "# PERSONALITY",
      "desc",
    ].join("\n");
    const parsed = parseProfileMd(md);
    expect(parsed.unknownVt).toEqual([{ key: "future_skill_level", value: "7", block: false }]);
    // Re-serialize keeps it (MD → Form → MD lossless).
    const reSerialized = serializeProfileMd(parsed);
    expect(reSerialized).toContain("future_skill_level: 7");
  });

  it("preserves unknown top-level frontmatter keys", () => {
    const md = [
      "---",
      "name: X",
      "author_email: secret@example.com",
      "vt:",
      "  mes_example_mode: always",
      "  mes_example_depth: 4",
      "---",
      "",
      "# PERSONALITY",
      "desc",
    ].join("\n");
    const parsed = parseProfileMd(md);
    expect(parsed.unknownFrontmatter).toEqual([
      { key: "author_email", value: "secret@example.com", block: false },
    ]);
    expect(serializeProfileMd(parsed)).toContain("author_email: secret@example.com");
  });

  it("preserves unknown body sections", () => {
    const md = [
      "---",
      "name: X",
      "vt:",
      "  mes_example_mode: always",
      "  mes_example_depth: 4",
      "---",
      "",
      "# PERSONALITY",
      "main desc",
      "",
      "# CUSTOM NOTES",
      "Something extra.",
    ].join("\n");
    const parsed = parseProfileMd(md);
    expect(parsed.unknownSections).toEqual([{ heading: "CUSTOM NOTES", body: "Something extra." }]);
    const reSerialized = serializeProfileMd(parsed);
    expect(reSerialized).toContain("# CUSTOM NOTES");
    expect(reSerialized).toContain("Something extra.");
  });
});

// ─── Tolerant parsing ──────────────────────────────────────────────────────

describe("profile-md: tolerant parsing", () => {
  it("accepts double-quoted scalars and strips the quotes", () => {
    const md = [
      "---",
      'name: "Comma, Man"',
      "character_version: \"2.0\"",
      "vt:",
      "  mes_example_mode: always",
      "  mes_example_depth: 4",
      "---",
      "",
      "# PERSONALITY",
      "desc",
    ].join("\n");
    const parsed = parseProfileMd(md);
    expect(parsed.profile.name).toBe("Comma, Man");
    expect(parsed.profile.characterVersion).toBe("2.0");
  });

  it("accepts quoted flow-array items containing commas", () => {
    const md = [
      "---",
      'name: X',
      'tags: ["a, b", "c", "sci-fi"]',
      "vt:",
      "  mes_example_mode: always",
      "  mes_example_depth: 4",
      "---",
      "",
      "# PERSONALITY",
      "desc",
    ].join("\n");
    const parsed = parseProfileMd(md);
    expect(parsed.profile.tags).toEqual(["a, b", "c", "sci-fi"]);
  });

  it("treats an empty/missing frontmatter gracefully", () => {
    const parsed = parseProfileMd("# PERSONALITY\ndesc only");
    expect(parsed.profile.name).toBe("");
    expect(parsed.profile.description).toBe("desc only");
  });

  it("ignores comment lines in frontmatter", () => {
    const md = [
      "---",
      "# a comment",
      "name: X",
      "vt:",
      "  mes_example_mode: always",
      "  mes_example_depth: 4",
      "---",
      "",
      "# PERSONALITY",
      "desc",
    ].join("\n");
    const parsed = parseProfileMd(md);
    expect(parsed.profile.name).toBe("X");
  });
});

// ─── Real V3 surface fixture (Andrea-derived, prose-only) ──────────────────

describe("profile-md: Andrea-derived fixture (real V3 prose surface)", () => {
  // Derived from a real runtime card (data/characters/*Andrea.json, gitignored).
  // Prose-only: exercises empty tags [], a multi-paragraph description with
  // bracket traits, a scenario, and an example conversation. Functional fields
  // (system/post-history/depth-prompt) are owned by instructions.json, not here.
  const andrea: VtfProfile = {
    name: "Andrea",
    tags: [],
    creator: null,
    characterVersion: null,
    creatorNotes: null,
    mesExampleMode: "always",
    mesExampleDepth: 4,
    description: "[Base & Appearance]\nAndrea is an albino rabbit demihuman.\n\n[Club Persona]\nMarketed as a shy bunny boy.",
    scenario: "A VIP host club that is a front for trafficking.",
    mesExample: '<example_conversation>\n{{char}}: Don\'t move.\n</example_conversation>',
  };

  it("Form → MD → Form preserves all prose fields", () => {
    const parsed = parseProfileMd(serializeProfileMd({ profile: andrea }));
    expect(parsed.profile).toEqual(andrea);
  });

  it("MD → Form → MD is stable", () => {
    const md = serializeProfileMd({ profile: andrea });
    expect(serializeProfileMd(parseProfileMd(md))).toBe(md);
  });
});
