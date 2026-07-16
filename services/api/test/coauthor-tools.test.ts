import { describe, test, expect } from "bun:test";
import { serializeProfileMd } from "@vibe-tavern/db";
import { buildCoauthorTools } from "../src/domain/chat/coauthor-tools.js";

/**
 * Co-Author tools propose edits; they never write. These tests pin the
 * validation contract and the uniform return shape (`target`/`proposed`/
 * `summary`, + `greetingIndex`/`isAdd` for greeting tools) the frontend diff
 * UI and the Apply RPC (CA-7) will depend on.
 */

function sampleProfileMd(
  over?: { description?: string; scenario?: string | null; mesExample?: string | null },
): string {
  return serializeProfileMd({
    profile: {
      name: "Test",
      tags: ["a"],
      creator: null,
      characterVersion: null,
      creatorNotes: null,
      mesExampleMode: "depth",
      mesExampleDepth: 4,
      description: over?.description ?? "A test character.",
      scenario: over?.scenario !== undefined ? over.scenario : "A scene.",
      mesExample: over?.mesExample !== undefined ? over.mesExample : null,
    },
  });
}

/** Shared tool-execution context stub (the tools ignore it). */
const ctx = { messages: [], toolCallId: "t", abort: () => {} } as never;

describe("coauthor-tools: write_profile", () => {
  test("validates via parseProfileMd round-trip and returns the profile target", async () => {
    const tools = buildCoauthorTools();
    const out = (await tools.write_profile.execute(
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
      tools.write_profile.execute(
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
    const out = (await tools.write_profile.execute(
      { profileMd: "just some prose, no frontmatter, no headings", summary: "x" },
      { messages: [], toolCallId: "t2b", abort: () => {} } as never,
    )) as never;
    expect(out.target).toBe("profile");
    expect(typeof out.proposed).toBe("string");
  });
});

describe("coauthor-tools: write_profile content-loss guard (CA-17)", () => {
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
      tools.write_profile.execute(
        { profileMd: malformed, summary: "Harden personality." },
        { messages: [], toolCallId: "g1", abort: () => {} } as never,
      ),
    ).rejects.toThrow(/PERSONALITY/);
    // Actionable: tells the model which heading to use and that the body is dropped.
    await expect(
      tools.write_profile.execute(
        { profileMd: malformed, summary: "x" },
        { messages: [], toolCallId: "g1b", abort: () => {} } as never,
      ),
    ).rejects.toThrow(/## PERSONALITY/);
    await expect(
      tools.write_profile.execute(
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
      tools.write_profile.execute(
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
    const out = (await tools.write_profile.execute(
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
    const out = (await tools.write_profile.execute(
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
      tools.write_profile.execute(
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
    const out = (await tools.write_profile.execute(
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

describe("coauthor-tools: edit_* exact SEARCH/REPLACE (CED-2)", () => {
  test("applies a unique exact edit to PERSONALITY and preserves other sections", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd() });
    const out = (await tools.edit_personality.execute(
      { edits: [{ search: "A test character.", replace: "A bold, sharp character." }], summary: "Harden personality." },
      ctx,
    )) as never;
    expect(out.target).toBe("profile");
    expect(out.proposed).toContain("# PERSONALITY\nA bold, sharp character.");
    expect(out.proposed).toContain("# SCENARIO\nA scene."); // preserved
  });

  test("edit_scenario targets only SCENARIO and preserves PERSONALITY", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd() });
    const out = (await tools.edit_scenario.execute(
      { edits: [{ search: "A scene.", replace: "A darker scene." }], summary: "x" },
      ctx,
    )) as never;
    expect(out.proposed).toContain("# SCENARIO\nA darker scene.");
    expect(out.proposed).toContain("# PERSONALITY\nA test character.");
  });

  test("rejects when search is not found in the current section body", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd() });
    await expect(tools.edit_personality.execute(
      { edits: [{ search: "NONEXISTENT TEXT", replace: "x" }], summary: "x" },
      ctx,
    )).rejects.toThrow(/not found/);
  });

  test("rejects an ambiguous search (2+ matches)", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd({ description: "na na twice" }) });
    await expect(tools.edit_personality.execute(
      { edits: [{ search: "na", replace: "x" }], summary: "x" },
      ctx,
    )).rejects.toThrow(/ambiguous/i);
  });

  test("rejects a no-op (search === replace)", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd() });
    await expect(tools.edit_personality.execute(
      { edits: [{ search: "A test character.", replace: "A test character." }], summary: "x" },
      ctx,
    )).rejects.toThrow(/no-op/);
  });

  test("rejects an empty search item", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd() });
    await expect(tools.edit_personality.execute(
      { edits: [{ search: "", replace: "x" }], summary: "x" },
      ctx,
    )).rejects.toThrow(/search must not be empty/);
  });

  test("rejects an empty edits batch", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd() });
    await expect(tools.edit_personality.execute(
      { edits: [], summary: "x" },
      ctx,
    )).rejects.toThrow(/edits must not be empty/);
  });

  test("deletes text via an empty replace", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd({ description: "Keep this. Remove this." }) });
    const out = (await tools.edit_personality.execute(
      { edits: [{ search: " Remove this.", replace: "" }], summary: "Trim." },
      ctx,
    )) as never;
    expect(out.proposed).toContain("# PERSONALITY\nKeep this.");
  });

  test("applies an ordered multi-edit batch in array order", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd({ description: "alpha beta gamma" }) });
    const out = (await tools.edit_personality.execute(
      { edits: [{ search: "alpha", replace: "ALPHA" }, { search: "ALPHA beta", replace: "ALPHA BETA" }], summary: "x" },
      ctx,
    )) as never;
    expect(out.proposed).toContain("# PERSONALITY\nALPHA BETA gamma");
  });

  test("a batch is atomic: a later failed item rejects and changes nothing", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd({ description: "alpha beta" }) });
    await expect(tools.edit_personality.execute(
      { edits: [{ search: "alpha", replace: "ALPHA" }, { search: "NONEXISTENT", replace: "x" }], summary: "x" },
      ctx,
    )).rejects.toThrow(/not found/);
    // Working profile untouched: a subsequent edit still sees the ORIGINAL body.
    const out = (await tools.edit_personality.execute(
      { edits: [{ search: "alpha", replace: "CHANGED" }], summary: "x" },
      ctx,
    )) as never;
    expect(out.proposed).toContain("# PERSONALITY\nCHANGED beta");
  });

  test("CA-17 guard rejects a wrong-level known heading introduced by an edit", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd() });
    await expect(tools.edit_scenario.execute(
      { edits: [{ search: "A scene.", replace: "## EXAMPLES\n\nleaked" }], summary: "x" },
      ctx,
    )).rejects.toThrow(/EXAMPLES/);
  });

  test("rejects if context profileMd is missing", async () => {
    const tools = buildCoauthorTools();
    await expect(tools.edit_personality.execute(
      { edits: [{ search: "x", replace: "y" }], summary: "x" },
      ctx,
    )).rejects.toThrow(/missing canonical profile context/);
  });
});

describe("coauthor-tools: write_* whole-section writes (CED-2)", () => {
  test("write_personality replaces only PERSONALITY and preserves other sections", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd() });
    const out = (await tools.write_personality.execute(
      { content: "A brand-new personality.", summary: "Rewrite personality." },
      ctx,
    )) as never;
    expect(out.target).toBe("profile");
    expect(out.proposed).toContain("# PERSONALITY\nA brand-new personality.");
    expect(out.proposed).toContain("# SCENARIO\nA scene."); // preserved
  });

  test("write_examples populates an empty EXAMPLES section", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd() }); // mesExample null
    const out = (await tools.write_examples.execute(
      { content: "{{char}}: Hello there.", summary: "Add dialogue." },
      ctx,
    )) as never;
    expect(out.proposed).toContain("# EXAMPLES\n{{char}}: Hello there.");
    expect(out.proposed).toContain("# PERSONALITY\nA test character."); // preserved
  });

  test("each write_* rejects empty content", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd() });
    for (const t of ["write_personality", "write_scenario", "write_examples"] as const) {
      await expect(tools[t].execute({ content: "   ", summary: "x" }, ctx)).rejects.toThrow(/empty/);
    }
  });

  test("CA-17 guard runs on a write body", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd() });
    await expect(tools.write_scenario.execute(
      { content: "### EXAMPLES\n\nleaked", summary: "x" },
      ctx,
    )).rejects.toThrow(/EXAMPLES/);
  });

  test("rejects if context profileMd is missing", async () => {
    const tools = buildCoauthorTools();
    await expect(tools.write_personality.execute({ content: "x", summary: "x" }, ctx)).rejects.toThrow(
      /missing canonical profile context/,
    );
  });

  test("returns the full cumulative canonical profile checkpoint", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd() });
    const out = (await tools.write_scenario.execute({ content: "New scene.", summary: "x" }, ctx)) as never;
    expect(out.target).toBe("profile");
    expect(out.proposed).toMatch(/^---\nname: Test/);
    expect(out.proposed).toContain("# PERSONALITY");
    expect(out.proposed).toContain("# SCENARIO\nNew scene.");
    expect(out.proposed).toContain("# EXAMPLES");
  });
});

describe("coauthor-tools: composition + serialized non-poisoning queue (CED-2)", () => {
  test("two different-section edits compose into the final proposal", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd() });
    await tools.edit_personality.execute(
      { edits: [{ search: "A test character.", replace: "Edited personality." }], summary: "p" },
      ctx,
    );
    const out = (await tools.edit_scenario.execute(
      { edits: [{ search: "A scene.", replace: "Edited scenario." }], summary: "s" },
      ctx,
    )) as never;
    expect(out.proposed).toContain("# PERSONALITY\nEdited personality.");
    expect(out.proposed).toContain("# SCENARIO\nEdited scenario.");
  });

  test("two same-section edits compose (second searches text introduced by the first)", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd() });
    await tools.edit_personality.execute(
      { edits: [{ search: "A test character.", replace: "A bold character." }], summary: "1" },
      ctx,
    );
    const out = (await tools.edit_personality.execute(
      { edits: [{ search: "A bold character.", replace: "A BOLD persona." }], summary: "2" },
      ctx,
    )) as never;
    expect(out.proposed).toContain("# PERSONALITY\nA BOLD persona.");
  });

  test("edit then write on the same section composes", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd() });
    await tools.edit_scenario.execute(
      { edits: [{ search: "A scene.", replace: "An interim scene." }], summary: "e" },
      ctx,
    );
    const out = (await tools.write_scenario.execute({ content: "A wholesale new scene.", summary: "w" }, ctx)) as never;
    expect(out.proposed).toContain("# SCENARIO\nA wholesale new scene.");
  });

  test("write then edit on the same section composes", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd({ mesExample: null }) });
    await tools.write_examples.execute({ content: "Line one. Line two.", summary: "w" }, ctx);
    const out = (await tools.edit_examples.execute(
      { edits: [{ search: "Line two.", replace: "Second line." }], summary: "e" },
      ctx,
    )) as never;
    expect(out.proposed).toContain("# EXAMPLES\nLine one. Second line.");
  });

  test("dependent edits fired without awaiting serialize deterministically (FIFO)", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd() });
    const p1 = tools.edit_personality.execute(
      { edits: [{ search: "A test character.", replace: "A bold character." }], summary: "1" },
      ctx,
    );
    const p2 = tools.edit_personality.execute(
      { edits: [{ search: "A bold character.", replace: "A BOLD persona." }], summary: "2" },
      ctx,
    );
    const [r1, r2] = (await Promise.all([p1, p2])) as never;
    expect(r1.proposed).toContain("A bold character.");
    expect(r2.proposed).toContain("# PERSONALITY\nA BOLD persona.");
  });

  test("a failed call does not poison the queue (next call succeeds against last good state)", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd() });
    await expect(tools.edit_personality.execute(
      { edits: [{ search: "GONE", replace: "x" }], summary: "fail" },
      ctx,
    )).rejects.toThrow(/not found/);
    const out = (await tools.edit_personality.execute(
      { edits: [{ search: "A test character.", replace: "Recovered." }], summary: "ok" },
      ctx,
    )) as never;
    expect(out.proposed).toContain("# PERSONALITY\nRecovered.");
  });

  test("each composable output carries the full cumulative proposed checkpoint", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd() });
    const a = (await tools.edit_personality.execute(
      { edits: [{ search: "A test character.", replace: "P-new." }], summary: "a" },
      ctx,
    )) as never;
    const b = (await tools.edit_scenario.execute(
      { edits: [{ search: "A scene.", replace: "S-new." }], summary: "b" },
      ctx,
    )) as never;
    expect(a.proposed).toContain("P-new.");
    expect(a.proposed).not.toContain("S-new.");
    expect(b.proposed).toContain("P-new.");
    expect(b.proposed).toContain("S-new.");
  });
});

describe("coauthor-tools: write_profile ordering within a turn (CED-2)", () => {
  test("write_profile first is valid; a later section edit composes on top", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd() });
    await tools.write_profile.execute(
      { profileMd: sampleProfileMd({ description: "Wholesale base." }), summary: "base rewrite" },
      ctx,
    );
    const out = (await tools.edit_personality.execute(
      { edits: [{ search: "Wholesale base.", replace: "Wholesale base, refined." }], summary: "refine" },
      ctx,
    )) as never;
    expect(out.proposed).toContain("# PERSONALITY\nWholesale base, refined.");
  });

  test("write_profile AFTER a section mutation rejects and preserves composed state", async () => {
    const tools = buildCoauthorTools({ profileMd: sampleProfileMd() });
    await tools.edit_personality.execute(
      { edits: [{ search: "A test character.", replace: "Composed." }], summary: "1" },
      ctx,
    );
    await expect(tools.write_profile.execute(
      { profileMd: sampleProfileMd(), summary: "late rewrite" },
      ctx,
    )).rejects.toThrow(/FIRST profile change/);
    const out = (await tools.edit_personality.execute(
      { edits: [{ search: "Composed.", replace: "Still composed." }], summary: "2" },
      ctx,
    )) as never;
    expect(out.proposed).toContain("# PERSONALITY\nStill composed.");
  });
});

describe("coauthor-tools: edit_alt_greeting", () => {
  test("returns target greeting with given index", async () => {
    const tools = buildCoauthorTools();
    const out = (await tools.edit_alt_greeting.execute(
      { index: 1, content: "Replaced alt.", summary: "Swap alt." },
      { messages: [], toolCallId: "t12", abort: () => {} } as never,
    )) as never;

    expect(out.target).toBe("greeting");
    expect(out.greetingIndex).toBe(1);
    expect(out.proposed).toBe("Replaced alt.");
  });
});

describe("coauthor-tools: toolSet filtering", () => {
  test("filters tools by the provided toolSet config", () => {
    const tools = buildCoauthorTools({ toolSet: { write_profile: true, edit_scenario: false } }) as unknown as Record<string, unknown>;
    expect(tools.write_profile).toBeDefined();
    expect(tools.edit_scenario).toBeUndefined();
    expect(tools.edit_greeting).toBeUndefined();
  });

  test("filters write_* tools independently from their edit siblings (CED-2)", () => {
    const tools = buildCoauthorTools({
      toolSet: { write_personality: true, write_examples: true },
    }) as unknown as Record<string, unknown>;
    expect(tools.write_personality).toBeDefined();
    expect(tools.write_examples).toBeDefined();
    expect(tools.write_scenario).toBeUndefined();
    expect(tools.write_profile).toBeUndefined();
    expect(tools.edit_personality).toBeUndefined();
  });
});
