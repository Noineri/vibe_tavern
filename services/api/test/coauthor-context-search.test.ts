import { describe, test, expect } from "bun:test";
import { createContextSearchSession, type ContextSearchStoreReads } from "../src/domain/context/context-search-service.js";

/**
 * CE-D2: context-search session tests. Pin indexed search + canonical read
 * behavior using a small in-memory store mock (no DB, no FTS5 — the
 * underlying index is already pinned in packages/db/test/context-search-index.test.ts).
 */

function makeStores(overrides?: Partial<ContextSearchStoreReads>): ContextSearchStoreReads {
  return {
    listAllCharacters: async () => [
      { id: "ch_aria", name: "Aria Stormwind", description: "Captain of the northern fleet.", personalitySummary: "Bold leader.", tags: ["fantasy", "captain"] },
      { id: "ch_boris", name: "Борис Крэг", description: "Старый harbour-master.", personalitySummary: null, tags: [] },
    ],
    listAllPersonas: async () => [
      { id: "ps_default", name: "Default Persona", description: "Neutral narrator voice." },
    ],
    listAllLorebooks: async () => [
      { id: "lb_world", name: "World Lore", description: "Geography and factions.", scopeType: "character", characterId: "ch_aria", personaId: null, chatId: null },
      { id: "lb_global", name: "Global Encyclopedia", description: "Universal facts.", scopeType: "global", characterId: null, personaId: null, chatId: null },
    ],
    listEntries: async (lorebookId: string) => {
      if (lorebookId === "lb_world") {
        return [
          { id: "le_aurora", lorebookId: "lb_world", title: "The Aurora", content: "Aria's flagship, docked at harbor.", keys: ["aurora", "flagship"], logic: "and_any", enabled: true },
          { id: "le_disabled", lorebookId: "lb_world", title: "Disabled Entry", content: "This should not appear.", keys: [], logic: "and_any", enabled: false },
        ];
      }
      return [];
    },
    listAllScripts: async () => [
      { id: "sc_dice", name: "Dice Roller", description: "Rolls polyhedral dice.", code: "console.log('roll')", scopeType: "character", characterId: "ch_aria", personaId: null },
    ],
    listLorebooksLinkedToTarget: async () => [],
    listScriptsLinkedToTarget: async () => [],
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
});
