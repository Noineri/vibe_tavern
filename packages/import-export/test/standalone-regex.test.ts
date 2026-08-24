import { test, expect } from "bun:test";

import {
  parseStandaloneRegexJson,
  serializeStandaloneRegexJson,
} from "../src/presets/standalone-regex.js";
import { REGEX_PLACEMENT, REGEX_SUBSTITUTE } from "@vibe-tavern/domain";

// ── Fixtures (real ST regex-script data, cross-repo test assets) ───────────

const FIXTURE_DIR = "N:/janitor_characters/vibe_tavern_plan/plans/v1.3/fixtures";
const TRIM_INCOMPLETE = `${FIXTURE_DIR}/st-regex-sphiratrioth/regex-trim_incomplete.json`;

async function loadFixtureText(path: string): Promise<string> {
  return await Bun.file(path).text();
}

// ── Shape handling ─────────────────────────────────────────────────────────

test("parseStandaloneRegexJson — single-object shape (real sphiratrioth fixture)", async () => {
  const text = await loadFixtureText(TRIM_INCOMPLETE);
  const drafts = parseStandaloneRegexJson(text);

  expect(drafts).toHaveLength(1);
  const d = drafts[0];
  expect(d.name).toBe("Trim Incomplete");
  expect(d.findRegex).toBe("(.*?)([.!?]|```)(?!.*([.!?]|```))[^.!?]*$");
  expect(d.replaceString).toBe("$1$2");
  expect(d.placement).toEqual([REGEX_PLACEMENT.AiOutput]);
  expect(d.runOnEdit).toBe(true);
  expect(d.substituteRegex).toBe(REGEX_SUBSTITUTE.None);
  expect(d.minDepth).toBeNull();
  expect(d.maxDepth).toBeNull();
});

test("parseStandaloneRegexJson — array-of-objects shape", () => {
  const json = JSON.stringify([
    { scriptName: "first", findRegex: "/a/g", replaceString: "x" },
    { scriptName: "second", findRegex: "/b/g", replaceString: "y" },
  ]);
  const drafts = parseStandaloneRegexJson(json);
  expect(drafts.map((d) => d.name)).toEqual(["first", "second"]);
  // sortOrder follows array index
  expect(drafts.map((d) => d.sortOrder)).toEqual([0, 1]);
});

test("parseStandaloneRegexJson — { scripts: [...] } wrapper shape", () => {
  const json = JSON.stringify({
    scripts: [
      { scriptName: "wrapped", findRegex: "/c/g", replaceString: "" },
    ],
  });
  const drafts = parseStandaloneRegexJson(json);
  expect(drafts).toHaveLength(1);
  expect(drafts[0].name).toBe("wrapped");
});

// ── Degradation (never throws) ─────────────────────────────────────────────

test("parseStandaloneRegexJson — garbage / empty / wrong shapes → [] without throwing", () => {
  expect(parseStandaloneRegexJson("not json at all {{{")).toEqual([]);
  expect(parseStandaloneRegexJson("")).toEqual([]);
  expect(parseStandaloneRegexJson("[]")).toEqual([]);
  expect(parseStandaloneRegexJson(JSON.stringify({ scripts: "garbage" }))).toEqual([]);
  expect(parseStandaloneRegexJson(JSON.stringify(42))).toEqual([]);
  expect(parseStandaloneRegexJson(JSON.stringify(null))).toEqual([]);
});

test("parseStandaloneRegexJson — skips meaningless entries inside a valid array", () => {
  const json = JSON.stringify([
    { scriptName: "no pattern" },
    "garbage",
    { scriptName: "valid", findRegex: "/z/g", replaceString: "q" },
  ]);
  const drafts = parseStandaloneRegexJson(json);
  expect(drafts).toHaveLength(1);
  expect(drafts[0].name).toBe("valid");
  // sortOrder counts ACCEPTED drafts, not raw array positions
  expect(drafts[0].sortOrder).toBe(0);
});

// ── Security gate ──────────────────────────────────────────────────────────

test("parseStandaloneRegexJson — security gate: disabled:false in file lands true, never global", async () => {
  const text = await loadFixtureText(TRIM_INCOMPLETE); // fixture has disabled:false
  const drafts = parseStandaloneRegexJson(text);
  expect(drafts).toHaveLength(1);
  expect(drafts[0].disabled).toBe(true);
  expect(drafts[0].isGlobal).toBe(false);

  const explicit = parseStandaloneRegexJson(
    JSON.stringify([{ scriptName: "x", findRegex: "/a/g", disabled: false }]),
  );
  expect(explicit[0].disabled).toBe(true);
});

// ── Round-trip ─────────────────────────────────────────────────────────────

test("round-trip — serialize → parse ≡ input minus sourceScript", async () => {
  const first = parseStandaloneRegexJson(await loadFixtureText(TRIM_INCOMPLETE));
  const second = parseStandaloneRegexJson(
    JSON.stringify([
      {
        scriptName: "Mood tag",
        findRegex: "/<mood>([\\s\\S]*?)<\\/mood>/g",
        replaceString: "$1",
        trimStrings: [" ", "-"],
        placement: [2],
        disabled: false,
        markdownOnly: true,
        promptOnly: false,
        runOnEdit: false,
        substituteRegex: 2,
        minDepth: 0,
        maxDepth: 4,
      },
    ]),
  );

  const all = [...first, ...second];
  const serialized = serializeStandaloneRegexJson(all);
  const reparsed = parseStandaloneRegexJson(serialized);

  expect(reparsed).toHaveLength(all.length);
  for (let i = 0; i < all.length; i++) {
    const { sourceScript: _dropped, ...expected } = all[i];
    void _dropped;
    // Strip the re-parsed lossless channel too — it now carries the
    // SERIALIZED plain object, not the original file object.
    const { sourceScript: _regot, ...reparsedRest } = reparsed[i];
    void _regot;
    // sortOrder is reassigned by the parse (accepted order across the whole
    // combined array), so compare it by position.
    expect(reparsedRest).toEqual({ ...expected, sortOrder: i });
  }
});

test("serializeStandaloneRegexJson — output parses as plain JSON array of ST-shaped objects", () => {
  const out = serializeStandaloneRegexJson([
    {
      name: "Solo",
      findRegex: "/a/g",
      replaceString: "",
      trimStrings: [],
      substituteRegex: 0,
      disabled: true,
      markdownOnly: false,
      promptOnly: false,
      runOnEdit: true,
      minDepth: null,
      maxDepth: null,
      placement: [2],
      isGlobal: false,
      sortOrder: 0,
    },
  ]);
  const parsed: unknown = JSON.parse(out);
  expect(Array.isArray(parsed)).toBe(true);
  const entry = (parsed as Array<Record<string, unknown>>)[0];
  expect(entry.scriptName).toBe("Solo");
  expect(entry.findRegex).toBe("/a/g");
  // Draft-only fields must not leak into the ST shape.
  expect("sourceScript" in entry).toBe(false);
  expect("name" in entry).toBe(false);
  expect("isGlobal" in entry).toBe(false);
});
