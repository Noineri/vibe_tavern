import { test, expect } from "bun:test";

import {
  importCharacterCardV3Json,
  type ImportedCharacterCardBundle,
} from "../src/cards/chara-card-v3.js";
import { extractCardRegexScripts, type RegexScriptImportDraft } from "../src/cards/regex-scripts.js";
import { REGEX_PLACEMENT, REGEX_SUBSTITUTE } from "@vibe-tavern/domain";

// ── Fixtures (real card data, cross-repo test assets) ──────────────────────

const FIXTURE_DIR = "N:/janitor_characters/vibe_tavern_plan/plans/v1.3/fixtures";
const CARD_WITH_REGEX = `${FIXTURE_DIR}/card-with-regex-seraphina.json`;
const CARD_BASE = `${FIXTURE_DIR}/seraphina-base.json`;

async function loadCard(path: string): Promise<Record<string, unknown>> {
  return (await Bun.file(path).json()) as Record<string, unknown>;
}

function importBundle(card: Record<string, unknown>): ImportedCharacterCardBundle {
  return importCharacterCardV3Json(card);
}

// ── extractCardRegexScripts — unit behavior ────────────────────────────────

test("extractCardRegexScripts — non-array / missing / undefined → []", () => {
  expect(extractCardRegexScripts(undefined)).toEqual([]);
  expect(extractCardRegexScripts({})).toEqual([]);
  expect(extractCardRegexScripts({ regex_scripts: "garbage" })).toEqual([]);
  expect(extractCardRegexScripts({ regex_scripts: null })).toEqual([]);
});

test("extractCardRegexScripts — drops entries without findRegex, no throw on garbage", () => {
  const drafts = extractCardRegexScripts({
    regex_scripts: [
      "garbage",
      42,
      { scriptName: "no find pattern", replaceString: "x" },
      { findRegex: "/a/g", scriptName: "valid" },
    ],
  });
  expect(drafts).toHaveLength(1);
  expect(drafts[0]!.name).toBe("valid");
  expect(drafts[0]!.findRegex).toBe("/a/g");
});

test("extractCardRegexScripts — malformed fields fall back to defaults", () => {
  const drafts = extractCardRegexScripts({
    regex_scripts: [
      {
        findRegex: "/x/g",
        scriptName: "",
        placement: [4, "bogus"], // 4 is not an ST code; no valid codes remain
        trimStrings: "not-an-array",
        minDepth: "x",
        maxDepth: "also-x",
        substituteRegex: 9,
        markdownOnly: "yes",
        promptOnly: 1,
      },
    ],
  });
  expect(drafts).toHaveLength(1);
  const d = drafts[0]!;
  expect(d.name).toBe("Imported regex script"); // blank name falls back
  expect(d.placement).toEqual([REGEX_PLACEMENT.AiOutput]); // no valid codes → default
  expect(extractCardRegexScripts({ regex_scripts: [{ findRegex: "/y/g", placement: [1, 4, "bogus"] }] })[0]!.placement)
    .toEqual([REGEX_PLACEMENT.UserInput]); // valid codes kept, invalid dropped
  expect(d.trimStrings).toEqual([]);
  expect(d.minDepth).toBeNull();
  expect(d.maxDepth).toBeNull();
  expect(d.substituteRegex).toBe(REGEX_SUBSTITUTE.None);
  expect(d.markdownOnly).toBe(false);
  expect(d.promptOnly).toBe(false);
  expect(d.runOnEdit).toBe(true); // default when absent
});

test("extractCardRegexScripts — SECURITY GATE: always disabled regardless of card flag", () => {
  const drafts = extractCardRegexScripts({
    regex_scripts: [{ findRegex: "/a/g", disabled: false }],
  });
  expect(drafts[0]!.disabled).toBe(true);
});

test("extractCardRegexScripts — full ST field mapping + lossless sourceScript", () => {
  const original = {
    id: "st-1",
    scriptName: "Censor word (depth 0-2)",
    findRegex: "/badword/gi",
    replaceString: "███",
    trimStrings: [" ", "-"],
    placement: [1, 2],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: false,
    substituteRegex: 2,
    minDepth: 0,
    maxDepth: 2,
    someFutureStField: { nested: true },
  };
  const drafts = extractCardRegexScripts({ regex_scripts: [original] });
  expect(drafts).toHaveLength(1);
  const d = drafts[0]!;
  expect(d.name).toBe("Censor word (depth 0-2)");
  expect(d.findRegex).toBe("/badword/gi");
  expect(d.replaceString).toBe("███");
  expect(d.trimStrings).toEqual([" ", "-"]);
  expect(d.placement).toEqual([REGEX_PLACEMENT.UserInput, REGEX_PLACEMENT.AiOutput]);
  expect(d.markdownOnly).toBe(true);
  expect(d.promptOnly).toBe(false);
  expect(d.runOnEdit).toBe(false);
  expect(d.substituteRegex).toBe(REGEX_SUBSTITUTE.Escaped);
  expect(d.minDepth).toBe(0);
  expect(d.maxDepth).toBe(2);
  expect(d.isGlobal).toBe(false);
  expect(d.sortOrder).toBe(0);
  // Lossless channel: the ORIGINAL object is carried verbatim.
  expect(d.sourceScript).toBe(original);
  expect((d.sourceScript as Record<string, unknown>).someFutureStField).toEqual({ nested: true });
});

test("extractCardRegexScripts — sortOrder follows array index across drafts", () => {
  const drafts = extractCardRegexScripts({
    regex_scripts: [
      { findRegex: "/a/g", scriptName: "first" },
      { findRegex: "/b/g", scriptName: "second" },
    ],
  });
  expect(drafts.map((d) => d.sortOrder)).toEqual([0, 1]);
});

// ── Real fixture card (V3 with 3 embedded scripts) ─────────────────────────

test("fixture card yields exactly 3 drafts, names/placements correct, ALL disabled", async () => {
  const card = await loadCard(CARD_WITH_REGEX);
  const bundle = importBundle(card);

  expect(bundle.regexScripts).toHaveLength(3);
  const byName = new Map<string, RegexScriptImportDraft>(bundle.regexScripts.map((d) => [d.name, d]));
  expect([...byName.keys()].sort()).toEqual([
    "Censor word (depth 0-2)",
    "Mood tag styling",
    "Strip thinking tags",
  ]);
  expect(byName.get("Strip thinking tags")!.placement).toEqual([
    REGEX_PLACEMENT.AiOutput,
    REGEX_PLACEMENT.Reasoning,
  ]);
  expect(byName.get("Censor word (depth 0-2)")!.placement).toEqual([
    REGEX_PLACEMENT.UserInput,
    REGEX_PLACEMENT.AiOutput,
  ]);
  // The card says disabled:false — the gate overrides to true. ALWAYS.
  for (const draft of bundle.regexScripts) {
    expect(draft.disabled).toBe(true);
  }
});

test("fixture control card (no regex_scripts) yields [] and bundle stays lossless", async () => {
  const base = await loadCard(CARD_BASE);
  const bundle = importBundle(base);
  expect(bundle.regexScripts).toEqual([]);

  // The WITH-regex card keeps its raw scripts inside extensions untouched.
  const withRegex = await loadCard(CARD_WITH_REGEX);
  const imported = importBundle(withRegex);
  const rawScripts = (imported.normalized.extensions.regex_scripts ?? null) as unknown;
  expect(Array.isArray(rawScripts)).toBe(true);
  expect(rawScripts).toHaveLength(3);
});

test("bundle.extensions still carries the RAW regex_scripts after extraction (lossless pin)", async () => {
  const card = await loadCard(CARD_WITH_REGEX);
  const bundle = importBundle(card);
  const raw = bundle.normalized.extensions.regex_scripts;
  expect(Array.isArray(raw)).toBe(true);
  const first = (raw as Array<Record<string, unknown>>)[0]!;
  expect(first.scriptName).toBe("Strip thinking tags");
  expect(first.disabled).toBe(false); // raw copy is UNTOUCHED — gate lives only in drafts
});

// ── V2 path (extensions at top level) ──────────────────────────────────────

test("pure-V2 card (no data block) extracts top-level extensions.regex_scripts", () => {
  const v2card = {
    name: "V2 Char",
    description: "old-style card",
    spec: "chara_card_v2",
    extensions: {
      regex_scripts: [{ findRegex: "/v2/g", scriptName: "from v2" }],
    },
  };
  const bundle = importBundle(v2card);
  expect(bundle.regexScripts).toHaveLength(1);
  expect(bundle.regexScripts[0]!.name).toBe("from v2");
  expect(bundle.regexScripts[0]!.disabled).toBe(true);
});

test("hybrid card: data.extensions wins over stale top-level copy; fallback applies when data has none", () => {
  const scriptA = { findRegex: "/a/g", scriptName: "in-data" };
  const scriptB = { findRegex: "/b/g", scriptName: "at-top-level" };
  // Both present → data block preferred.
  const both = importBundle({
    name: "Hybrid",
    extensions: { regex_scripts: [scriptB] },
    data: { name: "Hybrid", extensions: { regex_scripts: [scriptA] } },
  });
  expect(both.regexScripts.map((d) => d.name)).toEqual(["in-data"]);

  // Only top-level present → fallback picks it up.
  const topLevelOnly = importBundle({
    name: "Hybrid2",
    extensions: { regex_scripts: [scriptB] },
    data: { name: "Hybrid2", extensions: {} },
  });
  expect(topLevelOnly.regexScripts.map((d) => d.name)).toEqual(["at-top-level"]);
});
