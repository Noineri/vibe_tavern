/**
 * Characterization tests for `extractVtmdMonolith` (VTF_NATIVE_ROUNDTRIP Wave 2).
 *
 * `extractVtmdMonolith` is the read-side inverse of png-writer's
 * `embedCharaMetadata` `vtmd` path: the writer encodes the VTF monolith as
 * `utf8ToBase64(packMonolith(content))` into a `vtmd` tEXt chunk; the reader
 * must base64-decode it back to the ORIGINAL UTF-8 text (no JSON.parse — the
 * monolith is YAML frontmatter + markdown). These tests pin that round-trip so
 * a regression that drops the `vtmd` read (or breaks the UTF-8 byte loop)
 * fails loudly. The encoder here mirrors png-writer's `utf8ToBase64` exactly
 * (TextEncoder → btoa), so the test exercises the real on-the-wire encoding.
 */
import { test, expect } from "bun:test";
import { extractVtmdMonolith, type PngMetadata } from "./png-reader.js";

/** Mirrors png-writer's internal `utf8ToBase64` (UTF-8 aware). */
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

const MONOLITH = `---
name: Silvius
mes_example_mode: depth
mes_example_depth: 4
extensions:
  talkativeness: '0.5'
---

# PERSONALITY
calm and watchful.

# SCENARIO
A tavern at the forest's edge.

# FIRST MESSAGE
The door creaks open.`;

function vtmdEntry(text: string): PngMetadata {
  return { keyword: "vtmd", text };
}

test("decodes a vtmd chunk back to the original monolith text", () => {
  const metadata = [vtmdEntry(utf8ToBase64(MONOLITH))];
  expect(extractVtmdMonolith(metadata)).toBe(MONOLITH);
});

test("decodes UTF-8 multibyte content losslessly (not latin1 truncation)", () => {
  const withUnicode = "---\nname: Эльдар ❄\n---\n\n# PERSONALITY\nсеребряные волосы.\n";
  const metadata = [vtmdEntry(utf8ToBase64(withUnicode))];
  expect(extractVtmdMonolith(metadata)).toBe(withUnicode);
});

test("returns null when no vtmd chunk is present (plain ST card)", () => {
  const metadata: PngMetadata[] = [
    { keyword: "ccv3", text: "e30=" },
    { keyword: "chara", text: "e30=" },
  ];
  expect(extractVtmdMonolith(metadata)).toBeNull();
});

test("returns null for an empty metadata list", () => {
  expect(extractVtmdMonolith([])).toBeNull();
});

test("ignores other keywords and reads only vtmd", () => {
  const metadata = [
    { keyword: "ccv3", text: utf8ToBase64(JSON.stringify({ spec: "chara_card_v3" })) },
    vtmdEntry(utf8ToBase64(MONOLITH)),
  ];
  expect(extractVtmdMonolith(metadata)).toBe(MONOLITH);
});
