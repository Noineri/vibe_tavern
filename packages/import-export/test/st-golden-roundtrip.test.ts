/**
 * Golden parity probe (resweep step 29).
 *
 * A native ST world file with every template field set to a non-default value
 * runs through the importer — every VT field is asserted — and back through
 * the exporter — the ST-native shape is asserted field for field.
 *
 * The ST_TEMPLATE_FIELDS list mirrors SillyTavern's
 * newWorldInfoEntryDefinition (world-info.js:4004-4045, ST 1.18.0). When the
 * ST checkout updates, re-diff that definition against this list: a new ST
 * field must be added HERE and to the golden fixture, the importer, the
 * exporter, and the assertions — the completeness pin below fails until the
 * fixture carries it.
 *
 * Deliberate exceptions (defaults kept where a non-default value would
 * neutralize the probe or is behavior-tested elsewhere):
 * - entry 0 keeps `disable: false` (a disabled main entry tests nothing) and
 *   `useProbability: true` (false collapses probability to 100 — D3 pin in
 *   import-export.test.ts); `disable`/`selective: false` sweep on entry 1.
 * - `vectorized`/`triggers` are normalized but unpersisted (VT has no storage
 *   mapping — resweep step 25 named gap); import must merely not fail.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  exportLorebookToSt,
  importStLorebookJson,
  type StExportLoreEntry,
  type StExportLorebook,
  type StLorebookNormalized,
} from "../src/lorebooks/st-lorebook.js";
import type { LoreEntry } from "@vibe-tavern/domain";
import { LORE_MATCH_SOURCE } from "@vibe-tavern/domain";

const golden = (await Bun.file(join(import.meta.dir, "fixtures", "golden-st-world-info.json")).json()) as {
  entries: Record<string, Record<string, unknown>>;
};

/** ST 1.18.0 newWorldInfoEntryDefinition fields (world-info.js:4004-4045),
 * excluding the three `excludeFromTemplate` filter lists (they ride the
 * characterFilter object instead) — kept as a flat list for the re-diff. */
const ST_TEMPLATE_FIELDS = [
  "key", "keysecondary", "comment", "content", "constant", "vectorized", "selective",
  "selectiveLogic", "addMemo", "order", "position", "disable", "ignoreBudget",
  "excludeRecursion", "preventRecursion",
  "matchPersonaDescription", "matchCharacterDescription", "matchCharacterPersonality",
  "matchCharacterDepthPrompt", "matchScenario", "matchCreatorNotes",
  "delayUntilRecursion", "probability", "useProbability", "depth", "outletName",
  "group", "groupOverride", "groupWeight", "scanDepth", "caseSensitive",
  "matchWholeWords", "useGroupScoring", "automationId", "role", "sticky",
  "cooldown", "delay", "triggers",
] as const;

describe("golden ST world-info parity probe (step 29)", () => {
  test("the golden fixture carries every ST template field (completeness pin)", () => {
    for (const entry of Object.values(golden.entries)) {
      for (const field of ST_TEMPLATE_FIELDS) {
        expect(entry, `golden entry missing ST template field '${field}'`).toHaveProperty(field);
      }
    }
  });

  test("import maps every golden field to its VT field exactly", () => {
    const bundle = importStLorebookJson(JSON.stringify(golden));
    const normalized: StLorebookNormalized = bundle.normalized;

    // Book level: file values hold when no settings.json globals are supplied.
    expect(normalized.name).toBe("Golden Probe Book");
    expect(normalized.description).toBe("Golden probe description");
    expect(normalized.scanDepth).toBe(6);
    expect(normalized.tokenBudget).toBe(900);
    expect(normalized.tokenBudgetPercent).toBe(42);
    expect(normalized.tokenBudgetCap).toBe(700);
    expect(normalized.recursiveScanning).toBe(true);
    expect(normalized.maxRecursionSteps).toBe(9);

    expect(bundle.warnings).toContain("Lore entry 42 has character-filter tags that Vibe Tavern cannot import.");

    const main = bundle.entries.find((e) => e.title === "Golden Probe Entry");
    expect(main).toBeDefined();
    const e = main as LoreEntry;
    expect(e.keys).toEqual(["golden", "aurum"]);
    expect(e.secondaryKeys).toEqual(["secondary", "argentum"]);
    expect(e.logic).toBe("and_all"); // ST world_info_logic: 3 = AND_ALL (2 = NOT_ANY)
    expect(e.content).toBe("Golden probe content");
    expect(e.constant).toBe(true);
    expect(e.priority).toBe(321);
    expect(e.position).toBe("at_depth");
    expect(e.depth).toBe(9);
    expect(e.enabled).toBe(true);
    expect(e.ignoreBudget).toBe(true);
    expect(e.excludeRecursion).toBe(true);
    expect(e.preventRecursion).toBe(true);
    expect(e.matchSources).toEqual([
      LORE_MATCH_SOURCE.chatMessages,
      LORE_MATCH_SOURCE.personaDesc,
      LORE_MATCH_SOURCE.characterDesc,
      LORE_MATCH_SOURCE.characterPersonality,
      LORE_MATCH_SOURCE.characterNote,
      LORE_MATCH_SOURCE.scenario,
      LORE_MATCH_SOURCE.creatorNotes,
    ]);
    expect(e.delayUntilRecursion).toBe(true);
    expect(e.recursionLevel).toBe(3);
    expect(e.probability).toBe(77);
    expect(e.role).toBe("assistant");
    expect(e.groupName).toBe("golden-group");
    expect(e.groupWeight).toBe(55);
    expect(e.prioritizeInclusion).toBe(true);
    expect(e.useGroupScoring).toBe(true);
    expect(e.scanDepthOverride).toBe(8);
    expect(e.caseSensitive).toBe(true);
    expect(e.matchWholeWords).toBe(false);
    expect(e.automationId).toBe("gold-auto-7");
    expect(e.stickyWindow).toBe(4);
    expect(e.cooldownWindow).toBe(6);
    expect(e.minChatMessages).toBe(11);
    expect(e.characterFilter).toEqual([{ id: null, name: "Golden.png" }]);
    expect(e.characterFilterExclude).toBe(true);
    // Metadata round-trip carriers (steps 21-22).
    expect(e.metadata.stUid).toBe(42);
    expect(e.metadata.stOutletName).toBe("golden-outlet");
    expect(e.metadata.stAddMemo).toBe(true);
    expect(e.metadata.stUseProbability).toBe(true);
    expect(e.metadata.stCharacterFilterNames).toEqual(["Golden.png"]);
    expect(e.metadata.stCharacterFilterTags).toEqual(["golden-tag"]);

    // Sweep entry: disable true, selective false drops secondary keys (D4).
    const sweep = bundle.entries.find((entry) => entry.title === "Inactive sweep");
    expect(sweep).toBeDefined();
    const s = sweep as LoreEntry;
    expect(s.enabled).toBe(false);
    expect(s.secondaryKeys).toEqual([]);
    expect(s.logic).toBe("and_any");
  });

  test("export restores the ST-native shape field for field", () => {
    const bundle = importStLorebookJson(JSON.stringify(golden));
    const normalized = bundle.normalized;
    const book: StExportLorebook = {
      name: normalized.name,
      description: normalized.description,
      scanDepth: normalized.scanDepth,
      tokenBudget: normalized.tokenBudget,
      tokenBudgetPercent: normalized.tokenBudgetPercent,
      tokenBudgetCap: normalized.tokenBudgetCap,
      recursiveScanning: normalized.recursiveScanning,
      maxRecursionSteps: normalized.maxRecursionSteps,
      includeNames: normalized.includeNames,
      useGroupScoring: normalized.useGroupScoring,
      caseSensitive: normalized.caseSensitive,
      matchWholeWords: normalized.matchWholeWords,
      minActivations: normalized.minActivations,
      minActivationsDepthMax: normalized.minActivationsDepthMax,
      overflowAlert: normalized.overflowAlert,
      characterStrategy: normalized.characterStrategy,
    };
    const entries = bundle.entries as unknown as StExportLoreEntry[];
    const exported = exportLorebookToSt(book, entries, { create_date: 0 });
    const st = exported.entries["0"] as Record<string, unknown>;

    expect(st.uid).toBe(42);
    expect(st.key).toEqual(["golden", "aurum"]);
    expect(st.keysecondary).toEqual(["secondary", "argentum"]);
    expect(st.comment).toBe("Golden Probe Entry");
    expect(st.content).toBe("Golden probe content");
    expect(st.constant).toBe(true);
    expect(st.selective).toBe(true);
    expect(st.selectiveLogic).toBe(3);
    expect(st.addMemo).toBe(true);
    expect(st.order).toBe(321);
    expect(st.position).toBe(4);
    expect(st.disable).toBe(false);
    expect(st.ignoreBudget).toBe(true);
    expect(st.excludeRecursion).toBe(true);
    expect(st.preventRecursion).toBe(true);
    expect(st.matchPersonaDescription).toBe(true);
    expect(st.matchCharacterDescription).toBe(true);
    expect(st.matchCharacterPersonality).toBe(true);
    expect(st.matchCharacterDepthPrompt).toBe(true);
    expect(st.matchScenario).toBe(true);
    expect(st.matchCreatorNotes).toBe(true);
    expect(st.delayUntilRecursion).toBe(3);
    expect(st.probability).toBe(77);
    expect(st.useProbability).toBe(true);
    expect(st.depth).toBe(9);
    expect(st.outletName).toBe("golden-outlet");
    expect(st.group).toBe("golden-group");
    expect(st.groupOverride).toBe(true);
    expect(st.groupWeight).toBe(55);
    expect(st.scanDepth).toBe(8);
    expect(st.caseSensitive).toBe(true);
    expect(st.matchWholeWords).toBe(false);
    expect(st.useGroupScoring).toBe(true);
    expect(st.automationId).toBe("gold-auto-7");
    expect(st.role).toBe(2);
    expect(st.sticky).toBe(4);
    expect(st.cooldown).toBe(6);
    expect(st.delay).toBe(11);
    expect(st.characterFilter).toEqual({ isExclude: true, names: ["Golden.png"], tags: ["golden-tag"] });
  });
});
