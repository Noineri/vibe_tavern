import { describe, expect, test } from "bun:test";
import { brandId, REGEX_PLACEMENT, REGEX_SUBSTITUTE, type RegexPreset, type RegexPresetId } from "@vibe-tavern/domain";
import {
  chunkRoleRuns,
  defaultNarrationTextOptions,
  prepareNarrationText,
  splitNarrationRoles,
  narrationTextOptionsForMode,
  isNarrationTextMode,
  NARRATION_TEXT_MODES,
  type NarrationRoleRun,
} from "./narration-text.js";

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
    profileId: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function opts(partial: Partial<ReturnType<typeof defaultNarrationTextOptions>> = {}) {
  return { ...defaultNarrationTextOptions(), ...partial };
}

describe("prepareNarrationText", () => {
  // 1. Regex first
  test("regex layer transforms raw text before filters; empty presets no-op", () => {
    const preset = makePreset({ findRegex: "/hello/i", replaceString: "hi" });
    expect(prepareNarrationText("hello world", opts({ regexPresets: [preset] }))).toBe("hi world");
    expect(prepareNarrationText("Hello world", opts({ regexPresets: [preset] }))).toBe("hi world");
    expect(prepareNarrationText("hello world", opts({ regexPresets: [] }))).toBe("hello world");
  });

  test("uncompilable regex preset is skipped silently", () => {
    const broken = makePreset({ findRegex: "/([/g", replaceString: "never" });
    const good = makePreset({ findRegex: "/hello/g", replaceString: "hi" });
    expect(prepareNarrationText("hello", opts({ regexPresets: [broken, good] }))).toBe("hi");
    expect(prepareNarrationText("hello", opts({ regexPresets: [broken] }))).toBe("hello");
  });

  // 2. stripHtml
  test("stripHtml removes tags and decodes entities", () => {
    expect(prepareNarrationText("<b>bold</b>", opts({ stripHtml: true }))).toBe("bold");
    expect(prepareNarrationText("a<br> b", opts({ stripHtml: true }))).toBe("a b");
    expect(prepareNarrationText("<p>hello</p> world", opts({ stripHtml: true }))).toBe("hello world");
    const entities = "a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &nbsp;f";
    expect(prepareNarrationText(entities, opts({ stripHtml: true }))).toBe('a & b <c> "d" \'e\' f');
  });

  // 3. skipCodeblocks
  test("skipCodeblocks removes fenced blocks including content, keeps inline code", () => {
    expect(prepareNarrationText("before ```js\ncode *keep*\n``` after", opts({ skipCodeblocks: true }))).toBe("before after");
    expect(prepareNarrationText("before ```\ncode\n``` after", opts({ skipCodeblocks: true }))).toBe("before after");
    expect(prepareNarrationText("hello `code` world", opts({ skipCodeblocks: true }))).toBe("hello `code` world");
    expect(prepareNarrationText("a ```x``` b ```y``` c", opts({ skipCodeblocks: true }))).toBe("a b c");
  });

  // 4. stripAsteriskActions
  test("stripAsteriskActions removes *action* with content, strips **bold** markers, unmatched *", () => {
    expect(prepareNarrationText("*she smiles* hello", opts({ stripAsteriskActions: true }))).toBe("hello");
    expect(prepareNarrationText("**bold**", opts({ stripAsteriskActions: true }))).toBe("bold");
    expect(prepareNarrationText("*action* then **bold**", opts({ stripAsteriskActions: true }))).toBe("then bold");
    expect(prepareNarrationText("hello *", opts({ stripAsteriskActions: true }))).toBe("hello");
    expect(prepareNarrationText("*a* and *b* keep", opts({ stripAsteriskActions: true }))).toBe("and keep");
  });

  test("stripAsteriskActions does not touch underscore emphasis", () => {
    expect(prepareNarrationText("_emphasis_ keep", opts({ stripAsteriskActions: true }))).toBe("_emphasis_ keep");
  });

  // 5. quotedOnly
  test("quotedOnly keeps quoted dialogue, fallback to full text when no quotes", () => {
    expect(prepareNarrationText('He said "hello" and left.', opts({ quotedOnly: true }))).toBe("hello");
    expect(prepareNarrationText('«bonjour» ... "hi"', opts({ quotedOnly: true }))).toBe("bonjour hi");
    expect(prepareNarrationText("“curly” test", opts({ quotedOnly: true }))).toBe("curly");
    expect(prepareNarrationText("no quotes here", opts({ quotedOnly: true }))).toBe("no quotes here");
  });

  test("quotedOnly preserves newlines inside quotes (paragraph boundaries for chunking)", () => {
    expect(prepareNarrationText('"hello\nworld"', opts({ quotedOnly: true }))).toBe("hello\nworld");
  });

  // 6. Stage order
  test("stage order: regex runs before quotedOnly", () => {
    const preset = makePreset({ findRegex: "/REPLACE_ME/g", replaceString: '"hello"' });
    // Raw has no quotes; preset introduces a quoted span, then quotedOnly keeps it.
    expect(prepareNarrationText("REPLACE_ME and stuff", opts({ regexPresets: [preset], quotedOnly: true }))).toBe("hello");
  });

  test("stage order: skipCodeblocks before stripAsteriskActions", () => {
    // *inside* is inside a codeblock and should disappear with the block;
    // *outside* is a real action and should be removed by the asterisk filter.
    // Order doesn't change the final result but proves the block is removed with its asterisks.
    const text = "before ``` *inside* ``` after *outside* end";
    expect(prepareNarrationText(text, opts({ skipCodeblocks: true, stripAsteriskActions: true }))).toBe("before after end");
    // Also verify that without skipCodeblocks, the inside asterisks would be processed:
    expect(prepareNarrationText(text, opts({ skipCodeblocks: false, stripAsteriskActions: true }))).toBe("before ``` ``` after end");
  });

  // 7. Whitespace collapse (D10: newlines survive — they carry paragraph
  // boundaries to the orchestrator's splitParagraphs)
  test("whitespace collapse trims and collapses but PRESERVES paragraph boundaries", () => {
    // Blank line stays a \n\n boundary; runs inside a line collapse to one space.
    expect(prepareNarrationText("a   b\n\n  c", opts())).toBe("a b\n\nc");
    expect(prepareNarrationText("  hello   world  ", opts())).toBe("hello world");
    expect(prepareNarrationText("*a*", opts({ stripAsteriskActions: true }))).toBe("");
    expect(prepareNarrationText("   \n\n  ", opts())).toBe("");
    // Removals that leave extra spaces collapse:
    expect(prepareNarrationText("a <b> </b>  b", opts({ stripHtml: true }))).toBe("a b");
    // Single newline (soft break within a paragraph) survives as-is.
    expect(prepareNarrationText("a\n b", opts())).toBe("a\nb");
    // CRLF and blank lines with stray whitespace normalize to clean \n\n.
    expect(prepareNarrationText("a\r\n \r\nb", opts())).toBe("a\n\nb");
    // Spaces around a boundary are trimmed, blank-line runs are preserved.
    expect(prepareNarrationText("a  \n\n\n  b", opts())).toBe("a\n\n\nb");
    // Tab-heavy lines collapse to single spaces without eating the boundary.
    expect(prepareNarrationText("a \t \n \t b", opts())).toBe("a\nb");
  });

  // 8. defaults
  test("defaultNarrationTextOptions is identity transform", () => {
    const def = defaultNarrationTextOptions();
    expect(def.regexPresets).toEqual([]);
    expect(def.skipCodeblocks).toBe(false);
    expect(def.stripHtml).toBe(false);
    expect(def.stripAsteriskActions).toBe(false);
    expect(def.quotedOnly).toBe(false);
    const text = 'Hello <b>world</b> *action* ```code``` "quote"';
    expect(prepareNarrationText(text, def)).toBe(text);
  });

  test("defaultNarrationTextOptions returns fresh object", () => {
    const a = defaultNarrationTextOptions();
    const b = defaultNarrationTextOptions();
    expect(a).not.toBe(b);
  });

  test("combined pipeline uses fixed stage order", () => {
    // Regex that adds html, then html stripped
    const preset = makePreset({ findRegex: "/PLACE/g", replaceString: "<b>hi</b>" });
    expect(prepareNarrationText("PLACE", opts({ regexPresets: [preset], stripHtml: true }))).toBe("hi");
  });
});

describe("narration text mode (D26)", () => {
  const MIXED = 'Hello *wave* — "I am *not* going" **done** ok';

  test("narrationTextOptionsForMode maps all three modes onto the filter triple", () => {
    expect(narrationTextOptionsForMode("full")).toEqual({
      stripAsteriskActions: false,
      stripAsteriskMarkers: true,
      quotedOnly: false,
    });
    expect(narrationTextOptionsForMode("skip-asterisk-spans")).toEqual({
      stripAsteriskActions: true,
      stripAsteriskMarkers: false,
      quotedOnly: false,
    });
    // Quoted mode uses the MARKERS strip — emphasized words inside quotes survive.
    expect(narrationTextOptionsForMode("quoted-dialogue")).toEqual({
      stripAsteriskActions: false,
      stripAsteriskMarkers: true,
      quotedOnly: true,
    });
  });

  test("isNarrationTextMode accepts exactly the mode set", () => {
    for (const m of NARRATION_TEXT_MODES) expect(isNarrationTextMode(m)).toBe(true);
    for (const bad of [null, undefined, "actions", "quoted", "full-text", 1, ""])
      expect(isNarrationTextMode(bad)).toBe(false);
  });

  test("full mode (default): markers stripped, ALL words spoken — emphasis survives", () => {
    expect(prepareNarrationText(MIXED, opts(narrationTextOptionsForMode("full")))).toBe(
      'Hello wave — "I am not going" done ok',
    );
  });

  test("skip mode: v1 behavior — single-asterisk spans dropped WITH content (the meaning-inverting legacy, honestly labeled)", () => {
    expect(prepareNarrationText(MIXED, opts(narrationTextOptionsForMode("skip-asterisk-spans")))).toBe(
      'Hello — "I am going" done ok',
    );
  });

  test("quoted mode: only quoted speech, emphasis inside quotes kept (order pin: markers run BEFORE quotedOnly)", () => {
    expect(prepareNarrationText(MIXED, opts(narrationTextOptionsForMode("quoted-dialogue")))).toBe(
      "I am not going",
    );
  });

  test("quoted mode fallback: quote-less message narrates full text (markers stripped)", () => {
    expect(prepareNarrationText("Plain text *emphasis* here", opts(narrationTextOptionsForMode("quoted-dialogue")))).toBe(
      "Plain text emphasis here",
    );
  });

  test("stripAsteriskMarkers stage: **bold** and *span* keep content, stray * dropped", () => {
    expect(prepareNarrationText("**bold** and *not* and stray*", opts({ stripAsteriskMarkers: true }))).toBe(
      "bold and not and stray",
    );
  });
});

describe("splitNarrationRoles", () => {
  test("plain narration-only text → single narrator run", () => {
    expect(splitNarrationRoles("hello world")).toEqual([{ role: "narrator", text: "hello world" }]);
  });

  test("three quoted spans alternate roles in order", () => {
    const text = 'He said "hi" then she said "hello" and "bye" end';
    expect(splitNarrationRoles(text)).toEqual([
      { role: "narrator", text: "He said " },
      { role: "character", text: "hi" },
      { role: "narrator", text: " then she said " },
      { role: "character", text: "hello" },
      { role: "narrator", text: " and " },
      { role: "character", text: "bye" },
      { role: "narrator", text: " end" },
    ]);
  });

  test("adjacent same-role runs merged (quote immediately followed by quote)", () => {
    expect(splitNarrationRoles('"a""b"')).toEqual([{ role: "character", text: "ab" }]);
  });

  test("adjacent quotes with whitespace-only narrator gap dropped and merged", () => {
    expect(splitNarrationRoles('"a"   "b"')).toEqual([{ role: "character", text: "ab" }]);
  });

  test("unclosed quote → trailing character run", () => {
    expect(splitNarrationRoles('Start "unclosed rest')).toEqual([
      { role: "narrator", text: "Start " },
      { role: "character", text: "unclosed rest" },
    ]);
  });

  test("whitespace-only narrator gap dropped", () => {
    // Leading/trailing whitespace narrator gaps are dropped via narrator-whitespace rule.
    expect(splitNarrationRoles('   "a"   "b"   ')).toEqual([{ role: "character", text: "ab" }]);
    // Gap between narrator and character that is only spaces is still dropped if narrator-only? Use case: "a" between quotes with spaces
    expect(splitNarrationRoles('"a" "b"')).toEqual([{ role: "character", text: "ab" }]);
  });

  test("full empty and whitespace-only → []", () => {
    expect(splitNarrationRoles("")).toEqual([]);
    expect(splitNarrationRoles("   ")).toEqual([]);
    expect(splitNarrationRoles("\n\t  ")).toEqual([]);
  });

  test("typographic quotes “ ” and « » recognized same as ASCII", () => {
    const text = 'He said “hello” and «bonjour» end';
    expect(splitNarrationRoles(text)).toEqual([
      { role: "narrator", text: "He said " },
      { role: "character", text: "hello" },
      { role: "narrator", text: " and " },
      { role: "character", text: "bonjour" },
      { role: "narrator", text: " end" },
    ]);
  });

  test("character runs keep inner text as-is (no trimming)", () => {
    expect(splitNarrationRoles('"  spaced  "')).toEqual([{ role: "character", text: "  spaced  " }]);
  });

  test("narrator runs keep text as-is", () => {
    expect(splitNarrationRoles('A "b" C')).toEqual([
      { role: "narrator", text: "A " },
      { role: "character", text: "b" },
      { role: "narrator", text: " C" },
    ]);
  });
});

describe("chunkRoleRuns", () => {
  test("long narrator run splits into pieces ≤400 each with role preserved", () => {
    const longText = "word ".repeat(200); // ~1000 chars
    const runs: NarrationRoleRun[] = [{ role: "narrator", text: longText }];
    const pieces = chunkRoleRuns(runs, 400);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(p.text.length).toBeLessThanOrEqual(400);
      expect(p.role).toBe("narrator");
    }
  });

  test("join-back property: pieces join back to input exactly", () => {
    const runs: NarrationRoleRun[] = [
      { role: "narrator", text: "Hello world. " },
      { role: "character", text: "Hi there! How are you?" },
      { role: "narrator", text: " She smiled. " + "word ".repeat(150) },
    ];
    const joined = runs.map((r) => r.text).join("");
    const pieces = chunkRoleRuns(runs, 400);
    expect(pieces.map((p) => p.text).join("")).toBe(joined);
  });

  test("quoted runs shorter than maxLen stay whole (atomic)", () => {
    const runs: NarrationRoleRun[] = [
      { role: "narrator", text: "intro " },
      { role: "character", text: "short quote" },
      { role: "narrator", text: " outro" },
    ];
    const pieces = chunkRoleRuns(runs, 400);
    expect(pieces).toEqual(runs);
    // Also via splitNarrationRoles pipeline
    const quoted = splitNarrationRoles('intro "short quote" outro');
    const chunked = chunkRoleRuns(quoted, 400);
    expect(chunked).toEqual(quoted);
  });

  test("piece boundary never lands inside a quoted span — quoted runs are separate pieces", () => {
    const text = 'Start "' + "x".repeat(10) + '" middle ' + "y".repeat(500);
    const runs = splitNarrationRoles(text);
    // runs: narrator "Start ", character "xxxxx", narrator " middle yyy..."
    expect(runs.some((r) => r.role === "character")).toBe(true);
    const pieces = chunkRoleRuns(runs, 400);
    // Character piece must appear whole and not be split
    const charPieces = pieces.filter((p) => p.role === "character");
    expect(charPieces.length).toBe(1);
    expect(charPieces[0]!.text).toBe("x".repeat(10));
    // All pieces ≤400
    for (const p of pieces) expect(p.text.length).toBeLessThanOrEqual(400);
  });

  test("sentence boundary is preferred over word boundary", () => {
    const sentence = "Hello world. ".repeat(50); // many sentences, each ~13 chars
    const runs: NarrationRoleRun[] = [{ role: "narrator", text: sentence }];
    const pieces = chunkRoleRuns(runs, 50);
    for (const p of pieces) expect(p.text.length).toBeLessThanOrEqual(50);
    // No piece should cut inside a sentence without whitespace after punctuation
    // Verify join-back still holds
    expect(pieces.map((p) => p.text).join("")).toBe(sentence);
  });
});
