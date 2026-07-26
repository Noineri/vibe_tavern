/**
 * TextDiffPreview — component + builder characterization tests.
 *
 * Pins BOTH granularities at the SAME boundary the rest of the app relies on:
 *   - line mode (default, backward-compatible): the `buildLineDiff` summary
 *     shape consumed by `lib/coauthor-hunk-merge.ts` (hunk grouping) and the
 *     AiAssistantModal diff preview; the rendered `<pre>` rows with `+`/`-`/
 *     space prefixes and success/danger bg.
 *   - word mode (new): the `buildWordDiff` summary shape and the inline `<p>`
 *     renderer with the SAME success/danger visual language, plus the
 *     large-input fallback.
 *
 * Line-mode expectations were characterized from the pre-word-mode component
 * (callers in AiAssistantModal and CoauthorCharacterForm exercise this path);
 * do not change them without updating callers in wave 5.
 */
import { describe, it, expect } from "bun:test";
import { render } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";
import { buildLineDiff, buildWordDiff, TextDiffPreview } from "./TextDiffPreview.js";

useDomEnv();

const LABELS = { title: "Changes", tooLarge: "Diff too large", noChanges: "No changes" };

// ── buildLineDiff (line mode — backward-compatible contract) ──

describe("buildLineDiff", () => {
  it("returns added=0/removed=0 for identical input", () => {
    const d = buildLineDiff("same", "same");
    expect(d.tooLarge).toBe(false);
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
    expect(d.lines).toEqual([{ kind: "same", text: "same" }]);
  });

  it("tags a pure insertion as +1 with the new line text", () => {
    const d = buildLineDiff("A\nB", "A\nX\nB");
    expect(d.added).toBe(1);
    expect(d.removed).toBe(0);
    expect(d.lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      "same:A",
      "add:X",
      "same:B",
    ]);
  });

  it("tags a pure deletion as -1 with the removed line text", () => {
    const d = buildLineDiff("A\nX\nB", "A\nB");
    expect(d.added).toBe(0);
    expect(d.removed).toBe(1);
    expect(d.lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      "same:A",
      "remove:X",
      "same:B",
    ]);
  });

  it("tags a single-line replacement as +1 -1 in order (remove before add)", () => {
    const d = buildLineDiff("Kind.", "Fierce.");
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.lines).toEqual([
      { kind: "remove", text: "Kind." },
      { kind: "add", text: "Fierce." },
    ]);
  });

  it("counts a whitespace-only line-content change as a full line replace (+1 -1)", () => {
    // Line mode splits on "\n"; differing whitespace WITHIN a line means the
    // whole line is removed and re-added — jsdiff has no intra-line notion.
    const d = buildLineDiff("hello world", "hello  world");
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
  });

  it("emits one row per source line for multi-line input", () => {
    const old = ["# PERSONALITY", "Bold.", "Kind.", "", "# SCENARIO", "A cave.", ""].join("\n");
    const proposed = ["# PERSONALITY", "Bold.", "Fierce.", "", "# SCENARIO", "A cave at dusk.", ""].join("\n");
    const d = buildLineDiff(old, proposed);
    expect(d.lines.length).toBeGreaterThan(5);
    expect(d.lines.some((l) => l.kind === "add" && l.text === "Fierce.")).toBe(true);
    expect(d.lines.some((l) => l.kind === "remove" && l.text === "Kind.")).toBe(true);
  });

  it("returns tooLarge=true with an approximate net delta when the line budget is exceeded", () => {
    const big = "x\n".repeat(2000); // 2000 lines (+trailing empty)
    const d = buildLineDiff(big, "");
    expect(d.tooLarge).toBe(true);
    expect(d.lines).toEqual([]);
    // Net delta approximation: newLines (1) - oldLines (2001) → removed surplus.
    expect(d.removed).toBeGreaterThan(0);
    expect(d.added).toBe(0);
  });
});

// ── buildWordDiff (word mode — new) ──

describe("buildWordDiff", () => {
  it("returns added=0/removed=0 and an all-same run for identical input", () => {
    const d = buildWordDiff("The quick brown fox", "The quick brown fox");
    expect(d.tooLarge).toBe(false);
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
    expect(d.words.every((w) => w.kind === "same")).toBe(true);
    // Round-trip: every token concatenated equals the source.
    expect(d.words.map((w) => w.text).join("")).toBe("The quick brown fox");
  });

  it("tags a pure word insertion as add (words appended)", () => {
    const d = buildWordDiff("hello", "hello world");
    expect(d.removed).toBe(0);
    expect(d.added).toBe(1); // "world" — the inserted whitespace doesn't count
    expect(d.words.some((w) => w.kind === "add" && w.text.includes("world"))).toBe(true);
    expect(d.words.map((w) => w.text).join("")).toBe("hello world");
  });

  it("tags a pure word deletion as remove", () => {
    const d = buildWordDiff("hello world", "hello");
    expect(d.added).toBe(0);
    expect(d.removed).toBe(1); // "world"
    expect(d.words.some((w) => w.kind === "remove" && w.text.includes("world"))).toBe(true);
  });

  it("tags a single-word replacement as +1 -1 with shared scaffolding common", () => {
    const d = buildWordDiff("The quick brown fox", "The slow brown fox");
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    // Round-trip each side: remove-words reconstruct old, add-words reconstruct the new word.
    const oldReconstructed = d.words
      .filter((w) => w.kind === "remove" || w.kind === "same")
      .map((w) => w.text)
      .join("");
    const newReconstructed = d.words
      .filter((w) => w.kind === "add" || w.kind === "same")
      .map((w) => w.text)
      .join("");
    expect(oldReconstructed).toBe("The quick brown fox");
    expect(newReconstructed).toBe("The slow brown fox");
  });

  it("flags a whitespace-only change as a real diff (hasChanges), but does not bump the word count", () => {
    // "a b" → "a  b": only the inter-word space changed. The whitespace
    // tokens render inline (so the user SEES the spacing delta) but the
    // badge stays +0 -0 — no semantic word change.
    const d = buildWordDiff("a b", "a  b");
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
    expect(d.words.some((w) => w.kind === "add" || w.kind === "remove")).toBe(true);
  });

  it("renders multi-line input as a single contiguous token stream (word mode ignores line boundaries)", () => {
    // Word mode is for inline (single-paragraph) diffs; "\n" is just another
    // whitespace token in the stream. Reconstruct the NEW side by filtering
    // to same+add (the remove tokens are the OLD side, rendered inline for
    // visual context but not part of the new content).
    const d = buildWordDiff("line one\nline two", "line one\nline TWO");
    expect(d.added).toBe(1); // "TWO"
    expect(d.removed).toBe(1); // "two"
    const newContent = d.words
      .filter((w) => w.kind === "add" || w.kind === "same")
      .map((w) => w.text)
      .join("");
    expect(newContent).toBe("line one\nline TWO");
  });

  it("returns tooLarge=true when the combined token budget is exceeded", () => {
    // Build inputs whose combined token count exceeds MAX_WORD_DIFF_TOKENS (4000).
    // ~3000 chars/side of words at ~5 chars/token ≈ 600 tokens/side — too small.
    // Force it: a long single-word paragraph of 5000 word-tokens/side.
    const token = "word ";
    const huge = token.repeat(5000); // 5000 word tokens + 5000 whitespace tokens = 10000 segmenter tokens
    const d = buildWordDiff(huge, huge);
    expect(d.tooLarge).toBe(true);
    expect(d.words).toEqual([]);
  });

  it("counts only non-whitespace tokens so punctuation/word deltas are meaningful", () => {
    // Punctuation tokens from Intl.Segmenter are NOT whitespace → counted.
    // "Hi." → "Hi!" should count the punct change: +1 (the "!") -1 (the ".").
    const d = buildWordDiff("Hi.", "Hi!");
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
  });
});

// ── TextDiffPreview — rendered DOM contract (both granularities) ──

describe("TextDiffPreview rendering", () => {
  describe("line mode (default)", () => {
    it("shows the noChanges notice when there is no delta", () => {
      const { container, queryByText } = render(
        <TextDiffPreview summary={buildLineDiff("same", "same")} labels={LABELS} />,
      );
      expect(queryByText(LABELS.noChanges)).not.toBeNull();
      // No badge / pre rendered in the no-changes branch.
      expect(container.querySelector("pre")).toBeNull();
    });

    it("renders the title, +N -M badge, and a <pre> with prefixed rows for a replacement", () => {
      const d = buildLineDiff("Kind.", "Fierce.");
      const { container } = render(<TextDiffPreview summary={d} labels={LABELS} />);
      expect(container.textContent).toContain(LABELS.title);
      expect(container.textContent).toContain("+1");
      expect(container.textContent).toContain("-1");
      const rows = container.querySelectorAll("pre > div");
      expect(rows.length).toBe(2);
      // The prefix (+/-/space) lives in its own <span>; the line text is a
      // sibling of that span, so the row's textContent is "{prefix}{text}"
      // with no literal space (the visual gap comes from CSS `pr-2`).
      expect(rows[0]!.textContent).toBe("-Kind.");
      expect(rows[1]!.textContent).toBe("+Fierce.");
    });

    it("renders the tooLarge notice when the summary is tooLarge", () => {
      const tooLargeSummary = buildLineDiff("x\n".repeat(2000), "");
      const { queryByText, container } = render(
        <TextDiffPreview summary={tooLargeSummary} labels={LABELS} />,
      );
      expect(queryByText(LABELS.tooLarge)).not.toBeNull();
      expect(container.querySelector("pre")).toBeNull();
    });
  });

  describe("word mode", () => {
    it("shows the noChanges notice for identical input", () => {
      const { container, queryByText } = render(
        <TextDiffPreview granularity="word" summary={buildWordDiff("same", "same")} labels={LABELS} />,
      );
      expect(queryByText(LABELS.noChanges)).not.toBeNull();
      // Word mode renders a <p>, never a <pre>.
      expect(container.querySelector("p")).toBeNull();
      expect(container.querySelector("pre")).toBeNull();
    });

    it("renders inline spans inside a <p> with the add span carrying success-dim and remove span danger-dim", () => {
      const d = buildWordDiff("The quick brown fox", "The slow brown fox");
      const { container } = render(<TextDiffPreview granularity="word" summary={d} labels={LABELS} />);
      const p = container.querySelector("p");
      expect(p).not.toBeNull();
      const spans = p!.querySelectorAll("span");
      // Many spans: shared scaffolding + the remove token + the add token.
      expect(spans.length).toBeGreaterThan(2);
      // At least one add span (bg-success-dim) and one remove span (bg-danger-dim).
      const addSpans = Array.from(spans).filter((s) => s.className.includes("bg-success-dim"));
      const removeSpans = Array.from(spans).filter((s) => s.className.includes("bg-danger-dim"));
      expect(addSpans.length).toBeGreaterThan(0);
      expect(removeSpans.length).toBeGreaterThan(0);
      // Inline word diff renders BOTH sides in document order — the removed
      // "quick" appears immediately followed by the added "slow". Filter to
      // the NEW side (same + add) to reconstruct the post-edit content.
      const newContent = Array.from(spans)
        .filter((s) => !s.className.includes("bg-danger-dim"))
        .map((s) => s.textContent ?? "")
        .join("");
      expect(newContent.replace(/\s+/g, " ").trim()).toBe("The slow brown fox");
    });

    it("still renders body (not noChanges) for a whitespace-only change", () => {
      const d = buildWordDiff("a b", "a  b");
      const { container, queryByText } = render(
        <TextDiffPreview granularity="word" summary={d} labels={LABELS} />,
      );
      expect(queryByText(LABELS.noChanges)).toBeNull();
      expect(container.querySelector("p")).not.toBeNull();
      // Badge shows +0 -0 (no semantic word change) but the body is present.
      expect(container.textContent).toContain("+0");
      expect(container.textContent).toContain("-0");
    });

    it("renders the tooLarge notice when the word summary is tooLarge", () => {
      const huge = "word ".repeat(5000);
      const tooLargeSummary = buildWordDiff(huge, huge);
      expect(tooLargeSummary.tooLarge).toBe(true);
      const { container, queryByText } = render(
        <TextDiffPreview granularity="word" summary={tooLargeSummary} labels={LABELS} />,
      );
      expect(queryByText(LABELS.tooLarge)).not.toBeNull();
      expect(container.querySelector("p")).toBeNull();
    });

    it("renders multiline input as a single inline paragraph flow (no <pre>)", () => {
      const d = buildWordDiff("line one\nline two", "line one\nline TWO");
      const { container } = render(<TextDiffPreview granularity="word" summary={d} labels={LABELS} />);
      expect(container.querySelector("pre")).toBeNull();
      expect(container.querySelector("p")).not.toBeNull();
      expect(container.textContent).toContain("TWO");
    });
  });
});
