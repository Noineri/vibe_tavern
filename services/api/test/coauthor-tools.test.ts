import { describe, test, expect } from "bun:test";
import { serializeProfileMd } from "@vibe-tavern/db";
import { buildCoauthorTools } from "../src/domain/chat/coauthor-tools.js";

/**
 * Co-Author tools propose edits; they never write. These tests pin the
 * validation contract and the uniform return shape (`target`/`proposed`/
 * `summary`, + `greetingIndex`/`isAdd` for greeting tools) the frontend diff
 * UI and the Apply RPC (CA-7) will depend on.
 */

function sampleProfileMd() {
  return serializeProfileMd({
    profile: {
      name: "Test",
      tags: ["a"],
      creator: null,
      characterVersion: null,
      creatorNotes: null,
      mesExampleMode: "depth",
      mesExampleDepth: 4,
      description: "A test character.",
      scenario: "A scene.",
      mesExample: null,
    },
  });
}

describe("coauthor-tools: edit_profile", () => {
  test("validates via parseProfileMd round-trip and returns the profile target", async () => {
    const tools = buildCoauthorTools();
    const out = (await tools.edit_profile.execute(
      { profileMd: sampleProfileMd(), summary: "Tighten personality." },
      {
        messages: [], toolCallId: "t1", abort: () => {},
      } as never,
    )) as never;

    expect(out.target).toBe("profile");
    expect(out.greetingIndex).toBeUndefined();
    expect(out.isAdd).toBeUndefined();
    expect(out.summary).toBe("Tighten personality.");
    // Proposed is canonical-serialized profile.md (round-tripped through the codec).
    expect(out.proposed).toContain("# PERSONALITY");
    expect(out.proposed).toContain("A test character.");
  });

  test("rejects empty profile.md", async () => {
    const tools = buildCoauthorTools();
    await expect(
      tools.edit_profile.execute(
        { profileMd: "   ", summary: "x" },
        { messages: [], toolCallId: "t2", abort: () => {} } as never,
      ),
    ).rejects.toThrow(/empty/);
  });

  test("canonicalizes tolerant input without throwing (parseProfileMd is total)", async () => {
    // The codec never throws — unknown frontmatter / missing sections pass
    // through. So the tool accepts messy input and returns the canonical
    // serialization; the only hard gate is the empty-input guard above (and the
    // lost-section guard below).
    const tools = buildCoauthorTools();
    const out = (await tools.edit_profile.execute(
      { profileMd: "just some prose, no frontmatter, no headings", summary: "x" },
      { messages: [], toolCallId: "t2b", abort: () => {} } as never,
    )) as never;
    expect(out.target).toBe("profile");
    expect(typeof out.proposed).toBe("string");
  });
});

describe("coauthor-tools: edit_profile content-loss guard (CA-17)", () => {
  // The codec recognizes ONLY H1 known sections. A known section at the wrong
  // level (e.g. `## PERSONALITY`) is silently dropped during canonicalization —
  // inside the tool, before the frontend diff sees it. The guard refuses to
  // canonicalize such a proposal, returning a tool-error so the model re-emits
  // with correct H1 headings in the same multi-step turn. Error activities are
  // excluded from the CA-11 aggregator, so no bad proposal ever surfaces.

  test("## PERSONALITY (H2) with content → throws, naming the section + H1 fix", async () => {
    const tools = buildCoauthorTools();
    const malformed = [
      "---", "name: Kira", "tags: []", "---", "",
      "## PERSONALITY", "Bold, direct, and a little dangerous.", "",
      "# SCENARIO", "A forest cave.", "",
    ].join("\n");
    await expect(
      tools.edit_profile.execute(
        { profileMd: malformed, summary: "Harden personality." },
        { messages: [], toolCallId: "g1", abort: () => {} } as never,
      ),
    ).rejects.toThrow(/PERSONALITY/);
    // Actionable: tells the model which heading to use and that the body is dropped.
    await expect(
      tools.edit_profile.execute(
        { profileMd: malformed, summary: "x" },
        { messages: [], toolCallId: "g1b", abort: () => {} } as never,
      ),
    ).rejects.toThrow(/## PERSONALITY/);
    await expect(
      tools.edit_profile.execute(
        { profileMd: malformed, summary: "x" },
        { messages: [], toolCallId: "g1c", abort: () => {} } as never,
      ),
    ).rejects.toThrow(/single-hash H1/i);
  });

  test("### SCENARIO (H3) with content but otherwise valid → throws naming SCENARIO", async () => {
    const tools = buildCoauthorTools();
    const malformed = [
      "---", "name: Kira", "tags: []", "---", "",
      "# PERSONALITY", "Bold and direct.", "",
      "### SCENARIO", "A forest cave at dusk.", "",
    ].join("\n");
    await expect(
      tools.edit_profile.execute(
        { profileMd: malformed, summary: "x" },
        { messages: [], toolCallId: "g2", abort: () => {} } as never,
      ),
    ).rejects.toThrow(/SCENARIO/);
  });

  test("# PERSONALITY (correct H1) with content → does NOT throw", async () => {
    const tools = buildCoauthorTools();
    const correct = [
      "---", "name: Kira", "tags: []", "---", "",
      "# PERSONALITY", "Bold, direct, and a little dangerous.", "",
      "# SCENARIO", "A forest cave.", "",
    ].join("\n");
    const out = (await tools.edit_profile.execute(
      { profileMd: correct, summary: "x" },
      { messages: [], toolCallId: "g3", abort: () => {} } as never,
    )) as never;
    expect(out.target).toBe("profile");
    expect(out.proposed).toContain("Bold, direct, and a little dangerous.");
  });

  test("# PERSONALITY (correct H1) intentionally EMPTY → does NOT throw (allowed clear)", async () => {
    // An intentional clear emits the H1 heading with an empty body: the raw body
    // is empty, so there is nothing to lose — the guard must not fire.
    const tools = buildCoauthorTools();
    const cleared = [
      "---", "name: Kira", "tags: []", "---", "",
      "# PERSONALITY", "", "",
      "# SCENARIO", "A forest cave.", "",
    ].join("\n");
    const out = (await tools.edit_profile.execute(
      { profileMd: cleared, summary: "Clear personality." },
      { messages: [], toolCallId: "g4", abort: () => {} } as never,
    )) as never;
    expect(out.target).toBe("profile");
  });

  test("multiple malformed known sections → error mentions each", async () => {
    const tools = buildCoauthorTools();
    const malformed = [
      "---", "name: Kira", "tags: []", "---", "",
      "## PERSONALITY", "Bold.", "",
      "## SCENARIO", "A cave.", "",
      "## EXAMPLES", "{{char}}: hi", "",
    ].join("\n");
    // The throw surfaces all three lost sections (the model fixes them in one re-emit).
    await expect(
      tools.edit_profile.execute(
        { profileMd: malformed, summary: "x" },
        { messages: [], toolCallId: "g5", abort: () => {} } as never,
      ),
    ).rejects.toThrow(/PERSONALITY.*SCENARIO.*EXAMPLES|EXAMPLES.*SCENARIO.*PERSONALITY/s);
  });

  test("unknown H2 section (not a known name) → does NOT throw (preserved as unknown)", async () => {
    // A non-known section at H2 is NOT lost — it simply isn't a known section.
    // (The codec may drop or misroute it, but that is not the CA-17 loss class;
    // the guard scopes itself to known-section content loss.)
    const tools = buildCoauthorTools();
    const doc = [
      "---", "name: Kira", "tags: []", "---", "",
      "# PERSONALITY", "Bold and direct.", "",
      "## CUSTOM NOTES", "Some aside.", "",
    ].join("\n");
    const out = (await tools.edit_profile.execute(
      { profileMd: doc, summary: "x" },
      { messages: [], toolCallId: "g6", abort: () => {} } as never,
    )) as never;
    expect(out.target).toBe("profile");
  });
});

describe("coauthor-tools: edit_greeting", () => {
  test("returns the greeting target with the given index", async () => {
    const tools = buildCoauthorTools();
    const out = (await tools.edit_greeting.execute(
      { index: 0, content: "The door slams open.", summary: "Stronger opener." },
      { messages: [], toolCallId: "t3", abort: () => {} } as never,
    )) as never;

    expect(out.target).toBe("greeting");
    expect(out.greetingIndex).toBe(0);
    expect(out.isAdd).toBeUndefined();
    expect(out.proposed).toBe("The door slams open.");
    expect(out.summary).toBe("Stronger opener.");
  });

  test("accepts alternate-greeting indices (1+)", async () => {
    const tools = buildCoauthorTools();
    const out = (await tools.edit_greeting.execute(
      { index: 2, content: "An alt opener.", summary: "Add tension variant." },
      { messages: [], toolCallId: "t4", abort: () => {} } as never,
    )) as never;
    expect(out.greetingIndex).toBe(2);
  });

  test("rejects empty content", async () => {
    const tools = buildCoauthorTools();
    await expect(
      tools.edit_greeting.execute(
        { index: 0, content: "   ", summary: "x" },
        { messages: [], toolCallId: "t5", abort: () => {} } as never,
      ),
    ).rejects.toThrow(/empty/);
  });
});

describe("coauthor-tools: add_alt_greeting", () => {
  test("returns the greeting target flagged as an add", async () => {
    const tools = buildCoauthorTools();
    const out = (await tools.add_alt_greeting.execute(
      { content: "A new alternate opener.", summary: "New scenario entry." },
      { messages: [], toolCallId: "t6", abort: () => {} } as never,
    )) as never;

    expect(out.target).toBe("greeting");
    expect(out.isAdd).toBe(true);
    expect(out.greetingIndex).toBeUndefined();
    expect(out.proposed).toBe("A new alternate opener.");
  });

  test("rejects empty content", async () => {
    const tools = buildCoauthorTools();
    await expect(
      tools.add_alt_greeting.execute(
        { content: "", summary: "x" },
        { messages: [], toolCallId: "t7", abort: () => {} } as never,
      ),
    ).rejects.toThrow(/empty/);
  });
});
