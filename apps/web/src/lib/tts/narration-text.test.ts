import { describe, expect, test } from "bun:test";
import { brandId, REGEX_PLACEMENT, REGEX_SUBSTITUTE, type RegexPreset, type RegexPresetId } from "@vibe-tavern/domain";
import { defaultNarrationTextOptions, prepareNarrationText } from "./narration-text.js";

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
