import { describe, test, expect } from "bun:test";
import { diffIntraLine, annotateHunkLines } from "./intra-line-diff.js";
import type { TextDiffLine } from "../components/shared/TextDiffPreview.js";

const rem = (text: string): TextDiffLine => ({ kind: "remove", text });
const add = (text: string): TextDiffLine => ({ kind: "add", text });

function plain(segments: { text: string; common: boolean }[]): string {
  return segments.map((s) => s.text).join("");
}

function changedText(segments: { text: string; common: boolean }[]): string {
  return segments
    .filter((s) => !s.common)
    .map((s) => s.text)
    .join("");
}

describe("diffIntraLine", () => {
  test("marks the single changed word while keeping the rest common", () => {
    // "The quick brown fox" → "The slow brown fox": only quick/slow differ.
    const d = diffIntraLine("The quick brown fox", "The slow brown fox")!;
    expect(d).not.toBeNull();
    expect(plain(d.oldSegments)).toBe("The quick brown fox");
    expect(plain(d.newSegments)).toBe("The slow brown fox");
    expect(changedText(d.oldSegments)).toBe("quick");
    expect(changedText(d.newSegments)).toBe("slow");
    // Shared scaffolding is flagged common on both sides.
    expect(d.newSegments.some((s) => s.common && s.text.includes("brown"))).toBe(true);
  });

  test("identical lines mark everything common (no highlight)", () => {
    const d = diffIntraLine("same line", "same line")!;
    expect(d.oldSegments.every((s) => s.common)).toBe(true);
    expect(d.newSegments.every((s) => s.common)).toBe(true);
  });

  test("collapses consecutive same-flag tokens into one segment", () => {
    const d = diffIntraLine("a b c", "a b c")!;
    // All-common → a single collapsed segment, not three.
    expect(d.newSegments.length).toBe(1);
    expect(d.newSegments[0]).toEqual({ text: "a b c", common: true });
  });

  test("returns null for empty input (whole-line change fallback)", () => {
    expect(diffIntraLine("", "added")).toBeNull();
    expect(diffIntraLine("removed", "")).toBeNull();
  });

  test("handles Cyrillic prose per-word (Unicode-aware tokenizer)", () => {
    // "Быстрый" → "Медленный"; rest shared.
    const d = diffIntraLine("Он был смелым героем", "Он был добрым героем")!;
    expect(changedText(d.oldSegments)).toBe("смелым");
    expect(changedText(d.newSegments)).toBe("добрым");
    expect(plain(d.newSegments)).toBe("Он был добрым героем");
  });

  test("realistic greeting-sized paragraph (~230 tokens/side) does not bail out", () => {
    // Regression: an overly low MAX_INTRA_TOKENS cap made this return null and
    // fall back to whole-line coloring, defeating intra-line highlighting for
    // any single-line greeting/paragraph. Only one word differs.
    const base = "Before you could do anything, a quiet hiss from above made you look up. Something predatory was descending, sensing your movements on her web. She lowered herself smoothly, her long spider legs moving gracefully as she loomed over your face. Her hands, as if mocking your misfortune, rested on the threads on either side of your head, somehow not sticking. Her long platinum hair fell onto your shoulders; her gray, detached eyes, which held a hidden mockery, stared at you. Her slender female body transitioned naturally into the thorax of a huge spider.";
    const d = diffIntraLine(base, base.replace("detached", "unblinking"))!;
    expect(d).not.toBeNull();
    expect(changedText(d.oldSegments)).toBe("detached");
    expect(changedText(d.newSegments)).toBe("unblinking");
    expect(plain(d.newSegments)).toBe(base.replace("detached", "unblinking"));
  });
});

describe("annotateHunkLines", () => {
  test("pairs 1st remove with 1st add and annotates both sides", () => {
    const annotated = annotateHunkLines([rem("A cave."), add("A cave at dusk.")]);
    expect(annotated).toHaveLength(2);
    // Old side: "A cave" common, "." changed? The LCS shares "A cave" + " ";
    // the inserted tokens are "at dusk". The removed "." has no new counterpart
    // token-wise only if "." also appears on new side — it does ("dusk.").
    // Just assert round-trip + that something is flagged changed on the new side.
    expect(plain(annotated[0]!.segments!)).toBe("A cave.");
    expect(plain(annotated[1]!.segments!)).toBe("A cave at dusk.");
    expect(changedText(annotated[1]!.segments!)).toContain("at");
    expect(changedText(annotated[1]!.segments!)).toContain("dusk");
  });

  test("unpaired pure insertion gets null segments (whole-line change)", () => {
    // A hunk that is purely additive: no remove to pair against.
    const annotated = annotateHunkLines([add("a brand new line")]);
    expect(annotated[0]!.segments).toBeNull();
  });

  test("unpaired pure removal gets null segments", () => {
    const annotated = annotateHunkLines([rem("doomed line")]);
    expect(annotated[0]!.segments).toBeNull();
  });

  test("extra adds beyond remove count are unpaired (null)", () => {
    const annotated = annotateHunkLines([
      rem("old"),
      add("new"),
      add("extra line"),
    ]);
    // remove↔add[0] paired; add[1] ("extra line") is unpaired.
    expect(annotated[0]!.segments).not.toBeNull();
    expect(annotated[1]!.segments).not.toBeNull();
    expect(annotated[2]!.segments).toBeNull();
  });

  test("context (same) lines pass through with null segments", () => {
    const same: TextDiffLine = { kind: "same", text: "unchanged" };
    const annotated = annotateHunkLines([same, rem("x"), add("y")]);
    expect(annotated[0]!.line.kind).toBe("same");
    expect(annotated[0]!.segments).toBeNull();
  });

  test("preserves document order of the original hunk lines", () => {
    const lines = [rem("a"), add("b"), rem("c"), add("d")];
    const annotated = annotateHunkLines(lines);
    expect(annotated.map((a) => a.line.kind)).toEqual(["remove", "add", "remove", "add"]);
    expect(annotated.map((a) => a.line.text)).toEqual(["a", "b", "c", "d"]);
  });
});
