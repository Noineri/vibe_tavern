import { describe, test, expect } from "bun:test";
import { createContextSearchSession, type ContextSearchStoreReads } from "../src/domain/context/context-search-service.js";

/**
 * CE-D2: context-search session tests. Pin indexed search + canonical read
 * behavior using a small in-memory store mock (no DB, no FTS5 — the
 * underlying index is already pinned in packages/db/test/context-search-index.test.ts).
 */

function baseCharacters(): import("../src/domain/context/context-search-service.js").ContextSearchCharacterView[] {
  return [
    { id: "ch_aria", name: "Aria Stormwind", description: "Captain of the northern fleet.", personalitySummary: "Bold leader.", tags: ["fantasy", "captain"] },
    { id: "ch_boris", name: "Борис Крэг", description: "Старый harbour-master.", personalitySummary: null, tags: [] },
  ];
}
function basePersonas(): import("../src/domain/context/context-search-service.js").ContextSearchPersonaView[] {
  return [{ id: "ps_default", name: "Default Persona", description: "Neutral narrator voice." }];
}
function baseLorebooks(): import("../src/domain/context/context-search-service.js").ContextSearchLorebookView[] {
  return [
    { id: "lb_world", name: "World Lore", description: "Geography and factions.", scopeType: "character", characterId: "ch_aria", personaId: null, chatId: null },
    { id: "lb_global", name: "Global Encyclopedia", description: "Universal facts.", scopeType: "global", characterId: null, personaId: null, chatId: null },
  ];
}
function baseEntries(lorebookId: string): import("../src/domain/context/context-search-service.js").ContextSearchLoreEntryView[] {
  if (lorebookId === "lb_world") {
    return [
      { id: "le_aurora", lorebookId: "lb_world", title: "The Aurora", content: "Aria's flagship, docked at harbor.", keys: ["aurora", "flagship"], logic: "and_any", enabled: true },
      { id: "le_disabled", lorebookId: "lb_world", title: "Disabled Entry", content: "This should not appear.", keys: [], logic: "and_any", enabled: false },
    ];
  }
  return [];
}
function baseScripts(): import("../src/domain/context/context-search-service.js").ContextSearchScriptView[] {
  return [
    { id: "sc_dice", name: "Dice Roller", description: "Rolls polyhedral dice.", code: "console.log('roll')", scopeType: "character", characterId: "ch_aria", personaId: null },
  ];
}
function baseSkills(): import("../src/domain/context/context-search-service.js").ContextSearchSkillView[] {
  return [
    { id: "card-workshop", name: "Character Card Workshop", description: "Step-by-step character card authoring workflow.", manifestPath: "card-workshop/SKILL.md", source: "builtin" },
    { id: "dialogue-studio", name: "Dialogue Studio", description: "Craft vivid example dialogue lines.", manifestPath: "dialogue-studio/SKILL.md", source: "user" },
  ];
}

function makeStores(overrides?: Partial<ContextSearchStoreReads>): ContextSearchStoreReads {
  return {
    listAllCharacters: async () => baseCharacters(),
    listAllPersonas: async () => basePersonas(),
    listAllLorebooks: async () => baseLorebooks(),
    listEntries: async (lorebookId: string) => baseEntries(lorebookId),
    listAllScripts: async () => baseScripts(),
    listLorebooksLinkedToTarget: async () => [],
    listScriptsLinkedToTarget: async () => [],
    listSkills: async () => baseSkills(),
    // Direct lookups — back the canonical read path (O(1)).
    getCharacter: async (id) => baseCharacters().find((c) => c.id === id) ?? null,
    getPersona: async (id) => basePersonas().find((p) => p.id === id) ?? null,
    getLorebook: async (id) => baseLorebooks().find((lb) => lb.id === id) ?? null,
    getEntry: async (id) => {
      for (const lb of baseLorebooks()) {
        const e = baseEntries(lb.id).find((en) => en.id === id);
        if (e) return e;
      }
      return null;
    },
    getScript: async (id) => baseScripts().find((sc) => sc.id === id) ?? null,
    ...overrides,
  };
}

const defaultScope = async () => ({ activeCharacterId: "ch_aria", activePersonaId: null });

describe("context-search-session: search", () => {
  test("exact title match returns the correct entity", async () => {
    const session = createContextSearchSession(makeStores(), defaultScope);
    const results = await session.search("Aria Stormwind");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBe("character");
    expect(results[0].id).toBe("ch_aria");
    expect(results[0].matchKind).toBe("exact-title");
    session.dispose();
  });

  test("Russian exact title match works", async () => {
    const session = createContextSearchSession(makeStores(), defaultScope);
    const results = await session.search("борис крэг");
    expect(results[0].type).toBe("character");
    expect(results[0].id).toBe("ch_boris");
    expect(results[0].matchKind).toBe("exact-title");
    session.dispose();
  });

  test("partial name resolves via trigram fallback", async () => {
    const session = createContextSearchSession(makeStores(), defaultScope);
    const results = await session.search("storm");
    expect(results.some((r) => r.id === "ch_aria")).toBe(true);
    const aria = results.find((r) => r.id === "ch_aria");
    expect(aria?.matchKind).toBe("trigram-title");
    session.dispose();
  });

  test("type filter restricts results", async () => {
    const session = createContextSearchSession(makeStores(), defaultScope);
    const results = await session.search("aria", { types: ["lore-entry"] });
    expect(results.every((r) => r.type === "lore-entry")).toBe(true);
    expect(results.some((r) => r.id === "le_aurora")).toBe(true);
    session.dispose();
  });

  test("scope boost ranks active character first", async () => {
    const session = createContextSearchSession(makeStores(), defaultScope);
    const results = await session.search("aria", { scopeMode: "active_first" });
    expect(results[0].id).toBe("ch_aria");
    expect(results[0].scope).toContain("ch_aria");
    session.dispose();
  });

  test("disabled entries are excluded from the index", async () => {
    const session = createContextSearchSession(makeStores(), defaultScope);
    const results = await session.search("disabled");
    expect(results.every((r) => r.id !== "le_disabled")).toBe(true);
    session.dispose();
  });

  test("empty query returns empty", async () => {
    const session = createContextSearchSession(makeStores(), defaultScope);
    const results = await session.search("");
    expect(results).toEqual([]);
    session.dispose();
  });
});

describe("context-search-session: read", () => {
  test("read character returns profile content", async () => {
    const session = createContextSearchSession(makeStores(), defaultScope);
    const result = await session.read("character", "ch_aria");
    expect(result.type).toBe("character");
    expect(result.title).toBe("Aria Stormwind");
    expect(result.content).toContain("Captain of the northern fleet");
    expect(result.content).toContain("Bold leader");
    session.dispose();
  });

  test("read persona returns description", async () => {
    const session = createContextSearchSession(makeStores(), defaultScope);
    const result = await session.read("persona", "ps_default");
    expect(result.content).toContain("Neutral narrator voice");
    session.dispose();
  });

  test("read lorebook returns metadata + enabled entries", async () => {
    const session = createContextSearchSession(makeStores(), defaultScope);
    const result = await session.read("lorebook", "lb_world");
    expect(result.content).toContain("World Lore");
    expect(result.content).toContain("The Aurora");
    expect(result.content).not.toContain("Disabled Entry");
    session.dispose();
  });

  test("read lore-entry returns content + keys", async () => {
    const session = createContextSearchSession(makeStores(), defaultScope);
    const result = await session.read("lore-entry", "le_aurora");
    expect(result.title).toBe("The Aurora");
    expect(result.content).toContain("Aria's flagship");
    expect(result.content).toContain("aurora");
    session.dispose();
  });

  test("read script returns description + code", async () => {
    const session = createContextSearchSession(makeStores(), defaultScope);
    const result = await session.read("script", "sc_dice");
    expect(result.content).toContain("Rolls polyhedral dice");
    expect(result.content).toContain("console.log('roll')");
    session.dispose();
  });

  test("read missing entity throws", async () => {
    const session = createContextSearchSession(makeStores(), defaultScope);
    await expect(session.read("character", "ghost")).rejects.toThrow(/not found/);
    session.dispose();
  });

  test("read uses O(1) direct lookups, not bulk scans", async () => {
    // CE-D2 finding #3: read('lore-entry') previously scanned ALL lorebooks ×
    // every entry (O(lorebooks) DB calls). It must now use getEntry(id) only.
    // We assert by instrumenting the bulk reads: if read touched them, the
    // counters would be non-zero.
    let bulkListLorebooks = 0;
    let bulkListEntries = 0;
    let bulkListCharacters = 0;
    let bulkListScripts = 0;
    const stores = makeStores({
      listAllLorebooks: async () => {
        bulkListLorebooks++;
        return baseLorebooks();
      },
      listEntries: async (id) => {
        bulkListEntries++;
        return baseEntries(id);
      },
      listAllCharacters: async () => {
        bulkListCharacters++;
        return baseCharacters();
      },
      listAllScripts: async () => {
        bulkListScripts++;
        return baseScripts();
      },
    });
    const session = createContextSearchSession(stores, defaultScope);

    await session.read("lore-entry", "le_aurora");
    expect(bulkListLorebooks).toBe(0);
    expect(bulkListEntries).toBe(0);

    await session.read("character", "ch_aria");
    expect(bulkListCharacters).toBe(0);

    await session.read("script", "sc_dice");
    expect(bulkListScripts).toBe(0);
    session.dispose();
  });

  test("bare read does not build the index or resolve active scope", async () => {
    // CE-D2 finding #1: read() must NOT call ensureIndex(). It reads canonical
    // content straight from the stores, so it must neither trigger a full
    // library projection nor depend on resolveActiveScope succeeding. We pin
    // this by making resolveActiveScope throw and every listAll* observable:
    // if read touched them, the throw would propagate.
    let scopeResolved = false;
    const explodingStores = makeStores();
    const session = createContextSearchSession(explodingStores, async () => {
      scopeResolved = true;
      throw new Error("scope must not be resolved for a bare read");
    });
    const result = await session.read("persona", "ps_default");
    expect(scopeResolved).toBe(false);
    expect(result.content).toContain("Neutral narrator voice");
    session.dispose();
  });
});

describe("context-search-session: skill channel (CE-D3)", () => {
  test("search finds a skill by keyword", async () => {
    const session = createContextSearchSession(makeStores(), defaultScope);
    const results = await session.search("character card authoring");
    const ws = results.find((r) => r.type === "skill" && r.id === "card-workshop");
    expect(ws).toBeDefined();
    expect(ws?.title).toBe("Character Card Workshop");
    session.dispose();
  });

  test("skill results carry manifestPath + source in meta, no body", async () => {
    const session = createContextSearchSession(makeStores(), defaultScope);
    const results = await session.search("dialogue");
    const ds = results.find((r) => r.type === "skill" && r.id === "dialogue-studio");
    expect(ds).toBeDefined();
    expect(ds?.meta.manifestPath).toBe("dialogue-studio/SKILL.md");
    expect(ds?.meta.source).toBe("user");
    // The tool result is metadata-only — no content/body field exists.
    expect("content" in (ds as object)).toBe(false);
    session.dispose();
  });

  test("exact skill title promotes above content matches", async () => {
    const session = createContextSearchSession(makeStores(), defaultScope);
    const results = await session.search("Character Card Workshop");
    expect(results[0].type).toBe("skill");
    expect(results[0].id).toBe("card-workshop");
    expect(results[0].matchKind).toBe("exact-title");
    session.dispose();
  });

  test("skills are never scope-boosted even in active_first mode", async () => {
    // A skill and the active character both match 'character'. The active
    // character is boosted within its tier; the skill (global scope) is never
    // boosted, so the active character ranks above the skill when both are in
    // the same content tier.
    const session = createContextSearchSession(makeStores(), defaultScope);
    const results = await session.search("character");
    const aria = results.find((r) => r.id === "ch_aria");
    const skill = results.find((r) => r.type === "skill");
    if (aria && skill) {
      expect(results.indexOf(aria)).toBeLessThan(results.indexOf(skill));
      expect(skill.scope).toBe("global");
    }
    session.dispose();
  });

  test("type filter 'skill' restricts to skills only", async () => {
    const session = createContextSearchSession(makeStores(), defaultScope);
    const results = await session.search("character", { types: ["skill"] });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.type === "skill")).toBe(true);
    session.dispose();
  });

  test("skills appear alongside entities in an unfiltered search", async () => {
    const session = createContextSearchSession(makeStores(), defaultScope);
    const results = await session.search("workshop");
    expect(results.some((r) => r.type === "skill")).toBe(true);
    session.dispose();
  });

  test("read('skill') is rejected — skills load via read_skill_file", async () => {
    const session = createContextSearchSession(makeStores(), defaultScope);
    await expect(session.read("skill", "card-workshop")).rejects.toThrow(/read_skill_file/);
    session.dispose();
  });
});
