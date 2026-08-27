import { describe, expect, test } from "bun:test";
import { chunkNarrationText, splitParagraphs } from "./kokoro-text.js";

describe("splitParagraphs", () => {
  test("splits on blank lines and trims", () => {
    expect(splitParagraphs("para one\n\npara two")).toEqual(["para one", "para two"]);
  });

  test("tolerates CRLF and multiple consecutive blank lines", () => {
    expect(splitParagraphs("a\r\n\r\nb\r\n\r\n\r\nc")).toEqual(["a", "b", "c"]);
  });

  test("blank lines containing whitespace are treated as delimiters", () => {
    expect(splitParagraphs("a\n   \n b")).toEqual(["a", "b"]);
  });

  test("does not emit empty chunks, single newlines inside paragraph stay", () => {
    expect(splitParagraphs("line one\nline two\n\nline three")).toEqual([
      "line one\nline two",
      "line three",
    ]);
  });

  test("empty and whitespace-only input → []", () => {
    expect(splitParagraphs("")).toEqual([]);
    expect(splitParagraphs("   \n  \n ")).toEqual([]);
  });
});

describe("chunkNarrationText", () => {
  test("empty and whitespace-only input → []", () => {
    expect(chunkNarrationText("")).toEqual([]);
    expect(chunkNarrationText("   \n \n ")).toEqual([]);
  });

  test("never emits empty or whitespace-only chunks", () => {
    const chunks = chunkNarrationText("a\n\n\nb\n\n  \n\nc");
    for (const c of chunks) {
      expect(c.trim().length).toBeGreaterThan(0);
      expect(c.length).toBeGreaterThan(0);
    }
  });

  test("1200-char multi-sentence paragraph → chunks ≤ 400 and word order preserved", () => {
    // Build a ~1200-char paragraph: 12 sentences of ~100 chars each.
    const sentence = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. ";
    const paragraph = sentence.repeat(12).trim(); // ~12*~71 = ~852; add more to reach ~1200
    const long = `${paragraph} ${sentence.repeat(5).trim()}`;
    expect(long.length).toBeGreaterThan(1100);

    const chunks = chunkNarrationText(long, { maxChars: 400 });
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(400);
    expect(chunks.length).toBeGreaterThan(1);

    // Word order preserved: splitting the joined chunks back into words yields
    // the same word sequence as the original paragraph (modulo whitespace collapse).
    const originalWords = long.split(/\s+/).filter(Boolean);
    const chunkedWords = chunks.join(" ").split(/\s+/).filter(Boolean);
    expect(chunkedWords).toEqual(originalWords);
  });

  test("punctuation-free 500-char paragraph → word-boundary split, no chars lost", () => {
    const paragraph = Array.from({ length: 100 }, () => "word").join(" "); // 100*4 +99 = 499
    expect(paragraph.length).toBeGreaterThan(400);
    // No sentence punctuation at all.
    expect(paragraph.includes(".")).toBe(false);
    expect(paragraph.includes("!")).toBe(false);
    expect(paragraph.includes("?")).toBe(false);

    const chunks = chunkNarrationText(paragraph, { maxChars: 400 });
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(400);
    expect(chunks.length).toBeGreaterThan(1);

    // No characters lost or duplicated: word multiset preserved.
    const originalWords = paragraph.split(/\s+/).filter(Boolean);
    const chunkedWords = chunks.join(" ").split(/\s+/).filter(Boolean);
    expect(chunkedWords).toEqual(originalWords);
    // Also verify total non-whitespace characters preserved.
    const origChars = originalWords.join("").length;
    const chunkChars = chunkedWords.join("").length;
    expect(chunkChars).toBe(origChars);
  });

  test("CRLF input does not throw and chunks correctly", () => {
    const text = "First paragraph line one.\r\nSecond line of first paragraph.\r\n\r\nSecond paragraph here.";
    const chunks = chunkNarrationText(text);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c.trim().length).toBeGreaterThan(0);
  });

  test("single short paragraph ≤ maxChars is emitted as-is", () => {
    const p = "Short paragraph.";
    expect(chunkNarrationText(p, { maxChars: 400 })).toEqual([p]);
  });
});
