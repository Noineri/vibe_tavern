import { describe, it, expect } from "bun:test";
import {
  writeExtensions,
  readExtensions,
  isFrontmatterOwned,
  FRONTMATTER_OWNED_KEYS,
} from "../../src/vtf/extensions.js";

// ─── Frontmatter-owned keys ────────────────────────────────────────────────

describe("extensions: frontmatter-owned keys", () => {
  it("names creator + character_version as frontmatter-owned", () => {
    expect(FRONTMATTER_OWNED_KEYS).toEqual(["creator", "character_version"]);
    expect(isFrontmatterOwned("creator")).toBe(true);
    expect(isFrontmatterOwned("character_version")).toBe(true);
    expect(isFrontmatterOwned("talkativeness")).toBe(false);
  });
});

// ─── Write: strip + canonicalize ───────────────────────────────────────────

describe("extensions: write (strip + canonicalize)", () => {
  it("strips creator + character_version on write", () => {
    const json = writeExtensions({
      creator: "anonymous",
      character_version: "1.0",
      talkativeness: "0.5",
    });
    const parsed = JSON.parse(json);
    expect(parsed).not.toHaveProperty("creator");
    expect(parsed).not.toHaveProperty("character_version");
    expect(parsed).toEqual({ talkativeness: "0.5" });
  });

  it("emits a trailing newline", () => {
    expect(writeExtensions({ a: 1 }).endsWith("\n")).toBe(true);
  });

  it("canonicalizes an empty blob to `{}` + newline", () => {
    expect(writeExtensions({})).toBe("{}\n");
  });

  it("deep-sorts keys regardless of insertion order (byte-stable)", () => {
    const a = writeExtensions({ z: 1, a: 2, m: { y: 1, b: 2 } });
    const b = writeExtensions({ a: 2, m: { b: 2, y: 1 }, z: 1 });
    expect(a).toBe(b);
    const lines = a.split("\n");
    expect(lines.indexOf('  "a": 2,')).toBeLessThan(lines.indexOf('  "m": {'));
    expect(lines.indexOf('  "m": {')).toBeLessThan(lines.indexOf('  "z": 1'));
  });
});

// ─── Read: merge + tolerate ────────────────────────────────────────────────

describe("extensions: read (merge + tolerate)", () => {
  it("re-merges creator + character_version from frontmatter", () => {
    const json = writeExtensions({ creator: "ignored-on-write", talkativeness: "0.5" });
    const back = readExtensions(json, { creator: "anonymous", characterVersion: "1.0" });
    expect(back).toEqual({ talkativeness: "0.5", creator: "anonymous", character_version: "1.0" });
  });

  it("omits frontmatter keys when frontmatter values are null", () => {
    const json = writeExtensions({ talkativeness: "0.5" });
    const back = readExtensions(json, { creator: null, characterVersion: null });
    expect(back).toEqual({ talkativeness: "0.5" });
    expect(back).not.toHaveProperty("creator");
    expect(back).not.toHaveProperty("character_version");
  });

  it("tolerates an empty file (returns empty record, never throws)", () => {
    expect(readExtensions("", { creator: null, characterVersion: null })).toEqual({});
  });

  it("tolerates malformed JSON (returns empty record)", () => {
    expect(readExtensions("{not valid", { creator: null, characterVersion: null })).toEqual({});
  });

  it("tolerates a non-object JSON value (returns empty record)", () => {
    expect(readExtensions("[1, 2, 3]", { creator: null, characterVersion: null })).toEqual({});
  });
});

// ─── Round-trip invariants ─────────────────────────────────────────────────

describe("extensions: round-trip invariants", () => {
  it("write → read (with matching frontmatter) restores the original blob", () => {
    const original = {
      creator: "anonymous",
      character_version: "1.0",
      talkativeness: "0.5",
      fav: false,
      world: "",
    };
    const json = writeExtensions(original);
    const back = readExtensions(json, { creator: "anonymous", characterVersion: "1.0" });
    expect(back).toEqual(original);
  });

  it("write → read → write is byte-identical (canonical stability)", () => {
    const original = { depth_prompt: { depth: 4, prompt: "", role: "system" }, z: 1, a: 2 };
    const json1 = writeExtensions(original);
    const back = readExtensions(json1, { creator: null, characterVersion: null });
    const json2 = writeExtensions(back);
    expect(json2).toBe(json1);
  });

  it("preserves characterBook (V2 lorebook blob) losslessly", () => {
    const characterBook = {
      name: "world",
      entries: [{ keys: ["dragon"], content: "A great wyrm.", extensions: { position: "before_char" } }],
    };
    const json = writeExtensions({ character_book: characterBook });
    const back = readExtensions(json, { creator: null, characterVersion: null });
    expect(back.character_book).toEqual(characterBook);
  });

  it("preserves nested unknown structures with sorted keys", () => {
    const original = { nested: { z: { c: 1, a: 2 }, a: [3, 2, 1] } };
    const json = writeExtensions(original);
    expect(json).toContain('"a": [\n      3,\n      2,\n      1\n    ]');
    expect(json).toContain('"z": {\n      "a": 2,\n      "c": 1\n    }');
  });
});
