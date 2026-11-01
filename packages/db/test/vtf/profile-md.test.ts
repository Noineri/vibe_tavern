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
    // The stable skeleton always emits all three prose headings; a hand-authored
    // doc that omits EXAMPLES is canonicalized to add the bare heading.
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
      "",
      "# EXAMPLES",
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

  it("folds a functional heading found in a profile.md into the preceding known field (lossless, no drop)", () => {
    // A profile.md should never legitimately carry these — they live in
    // instructions.json — but when one appears after a known section the fold
    // keeps its text: the heading line + body become FIELD text instead of a
    // separate unknown section. (The exchange monolith is the one fold-exempt
    // parser — see the fold describe below.)
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
    expect(parsed.profile.description).toBe("desc\n\n# SYSTEM\nsecret system text");
    expect(parsed.unknownSections).toEqual([]);
    // Re-serialize keeps the text losslessly — inside the personality body.
    const reSerialized = serializeProfileMd(parsed);
    expect(reSerialized).toContain("# SYSTEM");
    expect(reSerialized).toContain("secret system text");
  });
});

// ─── Canonical emission ────────────────────────────────────────────────────

describe("profile-md: canonical emission", () => {
  it("omits empty frontmatter optionals but always emits the prose skeleton", () => {
    // Frontmatter optionals are still omitted when empty.
    const md = serializeProfileMd(minimalProfile());
    expect(md).not.toContain("tags:");
    expect(md).not.toContain("creator:");
    expect(md).not.toContain("character_version:");
    expect(md).not.toContain("creator_notes:");
    // The prose skeleton is ALWAYS complete: all three H1 headings in fixed
    // order, even when SCENARIO/EXAMPLES bodies are empty (bare headings).
    const headings = md.split("\n").filter((l) => /^# /.test(l)).map((l) => l.slice(2));
    expect(headings).toEqual(["PERSONALITY", "SCENARIO", "EXAMPLES"]);
    // Empty SCENARIO body is a bare heading (no body line before # EXAMPLES).
    const scenarioIdx = md.indexOf("# SCENARIO");
    const between = md.slice(scenarioIdx + "# SCENARIO".length, md.indexOf("# EXAMPLES"));
    expect(between.trim()).toBe("");
    // Empty EXAMPLES body is a bare heading at the end of the document.
    const examplesIdx = md.indexOf("# EXAMPLES");
    expect(md.slice(examplesIdx + "# EXAMPLES".length).trim()).toBe("");
  });

  it("round-trips an empty-optional profile through the stable skeleton losslessly", () => {
    // Bare SCENARIO/EXAMPLES headings parse back to null and re-emit as bare
    // headings — the skeleton is stable across MD → Form → MD.
    const md = serializeProfileMd(minimalProfile());
    expect(serializeProfileMd(parseProfileMd(md))).toBe(md);
    const parsed = parseProfileMd(md);
    expect(parsed.profile.scenario).toBeNull();
    expect(parsed.profile.mesExample).toBeNull();
  });

  it("always emits # PERSONALITY even with an empty body (Threat 2 pinning)", () => {
    // The required-section guarantee: a missing/renamed heading must self-heal
    // on save. An empty description serializes to a bare heading (no body), and
    // that bare heading parses back to an empty description — lossless round-trip.
    const md = serializeProfileMd({
      profile: { ...minimalProfile().profile, description: "" },
    });
    expect(md).toContain("# PERSONALITY");
    // The body directly under the heading is empty — the next thing is the
    // following stable-skeleton heading (SCENARIO), not a body line.
    const personalityIdx = md.indexOf("# PERSONALITY");
    const rest = md.slice(personalityIdx + "# PERSONALITY".length);
    const nextHeadingIdx = rest.indexOf("# ");
    const bodyUntilNext = rest.slice(0, nextHeadingIdx);
    expect(bodyUntilNext.trim()).toBe("");
    // Round-trip: bare heading → empty description.
    const back = parseProfileMd(md);
    expect(back.profile.description).toBe("");
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

  it("preserves an unknown body section that precedes every known section", () => {
    // An unknown section BEFORE the first known heading has nothing to fold
    // into, so it keeps riding verbatim as an unknown section. (An unknown
    // section AFTER a known one folds into that field — see the fold describe.)
    const md = [
      "---",
      "name: X",
      "vt:",
      "  mes_example_mode: always",
      "  mes_example_depth: 4",
      "---",
      "",
      "# CUSTOM NOTES",
      "Something extra.",
      "",
      "# PERSONALITY",
      "main desc",
    ].join("\n");
    const parsed = parseProfileMd(md);
    expect(parsed.unknownSections).toEqual([{ heading: "CUSTOM NOTES", body: "Something extra." }]);
    const reSerialized = serializeProfileMd(parsed);
    expect(reSerialized).toContain("# CUSTOM NOTES");
    expect(reSerialized).toContain("Something extra.");
  });
});

// ─── Unknown H1 fold (MD_HEADING_LOSS_REPORT) ──────────────────────────────

describe("profile-md: unknown H1 sections fold into the preceding known section", () => {
  // Owner incident (2026-11-01): pasting prose that begins with its own H1
  // heading under # PERSONALITY parsed to description "" — the foreign H1
  // started a new (unknown) section whose text no field ever received. The
  // fold makes the codec lossless: an unknown H1 section following a known
  // one joins that known section's field text, heading line included.
  it("folds a foreign H1 (+H2) section under an EMPTY # PERSONALITY into description (owner incident shape)", () => {
    const md = [
      "---",
      "name: Keith",
      "vt:",
      "  mes_example_mode: always",
      "  mes_example_depth: 4",
      "---",
      "",
      "# PERSONALITY",
      "# KEITH ALLEN",
      "## SUMMARY",
      "Keith Allen is a senior analyst.",
      "",
      "# SCENARIO",
      "Late-night office.",
    ].join("\n");
    const parsed = parseProfileMd(md);
    expect(parsed.profile.description).toBe("# KEITH ALLEN\n## SUMMARY\nKeith Allen is a senior analyst.");
    expect(parsed.profile.scenario).toBe("Late-night office.");
    expect(parsed.unknownSections).toEqual([]);
  });

  it("folds into a NON-empty known section too (uniform rule, blank-line join)", () => {
    const md = [
      "---",
      "name: X",
      "---",
      "",
      "# PERSONALITY",
      "main desc",
      "",
      "# CUSTOM NOTES",
      "Something extra.",
    ].join("\n");
    const parsed = parseProfileMd(md);
    expect(parsed.profile.description).toBe("main desc\n\n# CUSTOM NOTES\nSomething extra.");
    expect(parsed.unknownSections).toEqual([]);
  });

  it("folds into the optional fields as well (# SYSTEM after a non-empty EXAMPLES)", () => {
    const md = [
      "---",
      "name: X",
      "---",
      "",
      "# EXAMPLES",
      "<START>",
      "{{char}}: Hi.",
      "",
      "# SYSTEM",
      "secret system text",
    ].join("\n");
    const parsed = parseProfileMd(md);
    expect(parsed.profile.mesExample).toBe("<START>\n{{char}}: Hi.\n\n# SYSTEM\nsecret system text");
    expect(parsed.unknownSections).toEqual([]);
  });

  it("accumulates consecutive unknown sections in order into the same known field", () => {
    const md = [
      "---",
      "name: X",
      "---",
      "",
      "# EXAMPLES",
      "<START>",
      "{{char}}: Hi.",
      "",
      "# FIRST ASIDE",
      "one",
      "",
      "# SECOND ASIDE",
      "two",
    ].join("\n");
    const parsed = parseProfileMd(md);
    expect(parsed.profile.mesExample).toBe("<START>\n{{char}}: Hi.\n\n# FIRST ASIDE\none\n\n# SECOND ASIDE\ntwo");
    expect(parsed.unknownSections).toEqual([]);
  });

  it("is round-trip stable: parse → serialize → parse yields identical fields (folded case)", () => {
    const md = [
      "---",
      "name: X",
      "---",
      "",
      "# PERSONALITY",
      "intro",
      "",
      "# KEITH ALLEN",
      "## SUMMARY",
      "Senior analyst.",
      "",
      "# SCENARIO",
      "An office.",
    ].join("\n");
    const first = parseProfileMd(md);
    const second = parseProfileMd(serializeProfileMd(first));
    expect(second.profile).toEqual(first.profile);
    expect(second.unknownSections).toEqual(first.unknownSections);
    // The folded heading is field text now — re-emitted verbatim, exactly
    // once, inside the personality body (no separate unknown section).
    const serialized = serializeProfileMd(first);
    expect(serialized.split("# KEITH ALLEN").length - 1).toBe(1);
  });

  it("keeps H2/H3 lines inline (only H1 splits sections)", () => {
    const md = "---\nname: X\n---\n\n# PERSONALITY\nIntro.\n## SUB\nMore.\n### DEEP\nDeepest.";
    const parsed = parseProfileMd(md);
    expect(parsed.profile.description).toBe("Intro.\n## SUB\nMore.\n### DEEP\nDeepest.");
  });

  it("keeps a genuinely-empty PERSONALITY empty when nothing follows (deliberate clearing sticks)", () => {
    const parsed = parseProfileMd("---\nname: X\n---\n\n# PERSONALITY\n\n# SCENARIO\nA scene.");
    expect(parsed.profile.description).toBe("");
    expect(parsed.profile.scenario).toBe("A scene.");
  });

  it("returns unknown sections verbatim with foldUnknownSections: false (monolith transport)", () => {
    // The exchange monolith's functional headings ride as unknown sections —
    // its parse is exempt from the fold (see monolith.ts unpackMonolith).
    const md = "---\nname: X\n---\n\n# PERSONALITY\ndesc\n\n# SYSTEM\nsecret system text";
    const parsed = parseProfileMd(md, { foldUnknownSections: false });
    expect(parsed.profile.description).toBe("desc");
    expect(parsed.unknownSections).toEqual([{ heading: "SYSTEM", body: "secret system text" }]);
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

// ─── Storage identity (vt.storage_id) ─────────────────────────────────────

describe("profile-md: storage identity (vt.storage_id)", () => {
  it("parses vt.storage_id into parsed.storageId, NOT into unknownVt", () => {
    const md = [
      "---",
      "name: X",
      "vt:",
      "  storage_id: char_abc_123",
      "  mes_example_mode: always",
      "  mes_example_depth: 4",
      "---",
      "",
      "# PERSONALITY",
      "desc",
    ].join("\n");
    const parsed = parseProfileMd(md);
    expect(parsed.storageId).toBe("char_abc_123");
    // It must NOT also leak into unknownVt (would cause duplicate emission).
    expect(parsed.unknownVt).toEqual([]);
  });

  it("emits storage_id first in the vt: block when set", () => {
    const md = serializeProfileMd({ ...minimalProfile(), storageId: "char_xyz_9" });
    expect(md).toContain("  storage_id: char_xyz_9");
    // storage_id precedes the example-config keys (identity before config).
    const storageIdx = md.indexOf("storage_id:");
    const modeIdx = md.indexOf("mes_example_mode:");
    expect(storageIdx).toBeGreaterThan(-1);
    expect(storageIdx).toBeLessThan(modeIdx);
  });

  it("omits storage_id entirely when not set (null/undefined/empty)", () => {
    const md = serializeProfileMd(fullProfile());
    expect(md).not.toContain("storage_id");
    const mdNull = serializeProfileMd({ ...fullProfile(), storageId: null });
    expect(mdNull).not.toContain("storage_id");
    const mdEmpty = serializeProfileMd({ ...fullProfile(), storageId: "   " });
    expect(mdEmpty).not.toContain("storage_id");
  });

  it("parses to null when storage_id is absent", () => {
    const md = serializeProfileMd(fullProfile());
    expect(parseProfileMd(md).storageId).toBeNull();
  });

  it("round-trips storage_id through parse → serialize losslessly", () => {
    const md = serializeProfileMd({ ...fullProfile(), storageId: "char_rt_42" });
    // MD → Form → MD is stable (storage_id survives because ParsedProfile
    // carries it and serializeProfileMd reads input.storageId).
    expect(serializeProfileMd(parseProfileMd(md))).toBe(md);
  });

  it("treats storage_id as a known key: coexists with unknown vt: keys without conflict", () => {
    // A profile carrying both storage_id and an unknown vt key must split them:
    // storage_id → parsed.storageId, the other → parsed.unknownVt. No duplication.
    const md = [
      "---",
      "name: X",
      "vt:",
      "  storage_id: char_1",
      "  mes_example_mode: always",
      "  mes_example_depth: 4",
      "  future_skill: 7",
      "---",
      "",
      "# PERSONALITY",
      "desc",
    ].join("\n");
    const parsed = parseProfileMd(md);
    expect(parsed.storageId).toBe("char_1");
    expect(parsed.unknownVt).toEqual([{ key: "future_skill", value: "7", block: false }]);
  });

  it("an explicit storageId on the serialize input overrides any parsed value", () => {
    // The storage write path is authoritative: it passes the real local id,
    // ignoring whatever storage_id a parsed/edited profile carried.
    const parsed = parseProfileMd([
      "---",
      "name: X",
      "vt:",
      "  storage_id: char_IMPORT_SOURCE",
      "  mes_example_mode: always",
      "  mes_example_depth: 4",
      "---",
      "",
      "# PERSONALITY",
      "desc",
    ].join("\n"));
    const reSerialized = serializeProfileMd({ ...parsed, storageId: "char_LOCAL_99" });
    expect(reSerialized).toContain("storage_id: char_LOCAL_99");
    expect(reSerialized).not.toContain("char_IMPORT_SOURCE");
  });
});
