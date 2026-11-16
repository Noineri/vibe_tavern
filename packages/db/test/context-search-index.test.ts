import { describe, expect, test } from "bun:test";

import {
  buildContextSearchIndex,
  DEFAULT_SEARCH_LIMIT,
  type IndexedContextRecord,
} from "../src/context-search-index.js";

/** Minimal factory; only the fields the index reads. */
function rec(partial: Partial<IndexedContextRecord> & Pick<IndexedContextRecord, "type" | "id" | "title">): IndexedContextRecord {
  return {
    channel: "entity",
    body: "",
    scope: "global",
    ownerId: null,
    parentId: null,
    meta: {},
    ...partial,
  };
}

/** A small corpus exercising exact names, partial names, duplicate titles
 * across types, EN/RU text, and parent metadata. */
const corpus: IndexedContextRecord[] = [
  rec({ type: "character", id: "ch_aria", title: "Aria Stormwind", body: "Captain of the northern fleet. Commands the Aurora.", scope: "character:ch_aria", ownerId: "ch_aria" }),
  rec({ type: "character", id: "ch_boris", title: "Борис Крэг", body: "Старый harbour-master, хранит маяк.", scope: "character:ch_boris", ownerId: "ch_boris" }),
  rec({ type: "persona", id: "ps_default", title: "Default Persona", body: "Neutral narrator voice.", scope: "persona:ps_default", ownerId: "ps_default" }),
  rec({ type: "lorebook", id: "lb_world", title: "World Lore", body: "Geography and factions of the setting.", scope: "character:ch_aria", ownerId: "ch_aria" }),
  rec({ type: "lore-entry", id: "le_aurora", title: "The Aurora", body: "Aria's flagship, docked at harbor.", scope: "character:ch_aria", ownerId: "ch_aria", parentId: "lb_world", meta: { lorebookId: "lb_world" } }),
  rec({ type: "lore-entry", id: "le_merfolk", title: "Merfolk Treaty", body: "Pact with the deep-sea folk; signed at the reef.", scope: "character:ch_aria", ownerId: "ch_aria", parentId: "lb_world", meta: { lorebookId: "lb_world" } }),
  rec({ type: "script", id: "sc_dice", title: "Dice Roller", body: "Rolls polyhedral dice on /roll.", scope: "character:ch_aria", ownerId: "ch_aria" }),
  // duplicate title across types — disambiguation case:
  rec({ type: "character", id: "ch_echo", title: "Echo", body: "A mimic who repeats words.", scope: "character:ch_echo", ownerId: "ch_echo" }),
  rec({ type: "script", id: "sc_echo", title: "Echo", body: "Prints the last message back to the user.", scope: "global" }),
];

describe("buildContextSearchIndex — tiered ranking", () => {
  test("exact normalized title is promoted above body matches", () => {
    const idx = buildContextSearchIndex(corpus);
    // "aria" matches the character title (exact) AND a lore-entry body mention.
    const out = idx.search("aria");
    const titles = out.map((r) => r.type + ":" + r.id);
    expect(titles[0]).toBe("character:ch_aria");
    expect(out[0].matchKind).toBe("exact-title");
    // the lore entry that mentions Aria's flagship should appear via content tier
    expect(titles).toContain("lore-entry:le_aurora");
    const aurora = out.find((r) => r.id === "le_aurora");
    expect(aurora?.matchKind === "content" || aurora?.matchKind === "trigram-title").toBe(true);
    idx.dispose();
  });

  test("case-insensitive and diacritic-folded exact title", () => {
    const idx = buildContextSearchIndex(corpus);
    try {
      const out = idx.search("Áríà Störmwînd");
      expect(out[0]?.id).toBe("ch_aria");
      expect(out[0]?.matchKind).toBe("exact-title");
      // Cyrillic exact with combining acute stress accent (escaped to keep diff ASCII-clean)
      const ru = idx.search("\u0431\u043E\u0301\u0440\u0438\u0441 \u043A\u0440\u044D\u0433");
      expect(ru[0]?.id).toBe("ch_boris");
      expect(ru[0]?.matchKind).toBe("exact-title");
    } finally {
      idx.dispose();
    }

    const accentedIdx = buildContextSearchIndex([
      rec({ type: "character", id: "ch_cafe", title: "Café Éclair", body: "" }),
    ]);
    try {
      const plainQuery = accentedIdx.search("cafe eclair");
      expect(plainQuery[0]?.id).toBe("ch_cafe");
      expect(plainQuery[0]?.matchKind).toBe("exact-title");

      const upperAccentedQuery = accentedIdx.search("CÀFÉ ÉCLAIR");
      expect(upperAccentedQuery[0]?.id).toBe("ch_cafe");
      expect(upperAccentedQuery[0]?.matchKind).toBe("exact-title");
    } finally {
      accentedIdx.dispose();
    }
  });

  test("partial name resolves via trigram fallback tier", () => {
    const idx = buildContextSearchIndex(corpus);
    const out = idx.search("storm");
    // "storm" is not a whole token of anything → no exact/content; trigram
    // matches "Aria Stormwind" and "Stormwind"-containing titles.
    expect(out.some((r) => r.id === "ch_aria")).toBe(true);
    const aria = out.find((r) => r.id === "ch_aria");
    expect(aria?.matchKind).toBe("trigram-title");
    idx.dispose();
  });

  test("trigram never pollutes content tier ordering", () => {
    // Seed distinct records that each trigger one tier for query "aria", so
    // the test genuinely exercises all three tiers in strict order.
    const idx = buildContextSearchIndex([
      rec({ type: "character", id: "ch_tri", title: "Valiariana", body: "unrelated" }),
      rec({ type: "character", id: "ch_content", title: "Harbor Log", body: "aria arrived at dawn" }),
      rec({ type: "character", id: "ch_exact", title: "Aria", body: "" }),
    ]);
    try {
      const out = idx.search("aria");
      expect(out.map((r) => [r.id, r.matchKind])).toEqual([
        ["ch_exact", "exact-title"],
        ["ch_content", "content"],
        ["ch_tri", "trigram-title"],
      ]);
    } finally {
      idx.dispose();
    }
  });

  test("duplicate titles across types both surface and stay stable", () => {
    const idx = buildContextSearchIndex(corpus);
    const out = idx.search("echo");
    const ids = out.map((r) => r.id).sort();
    expect(ids).toContain("ch_echo");
    expect(ids).toContain("sc_echo");
    // determinism: same query → same order
    const out2 = idx.search("echo");
    expect(out2.map((r) => r.id)).toEqual(out.map((r) => r.id));
    idx.dispose();
  });
});

describe("buildContextSearchIndex — filtering and scope", () => {
  test("type filter restricts results", () => {
    const idx = buildContextSearchIndex(corpus);
    const out = idx.search("aria", { types: ["lore-entry"] });
    expect(out.every((r) => r.type === "lore-entry")).toBe(true);
    // exact-title character match is filtered out by the type gate
    expect(out.some((r) => r.id === "le_aurora")).toBe(true);
    idx.dispose();
  });

  test("scope boost ranks active-scope records first within a tier", () => {
    // Construct a pair where the global record outranks the active-scope record
    // in the unboosted baseline so scopeBoosts must genuinely flip the ordering.
    const local = [
      rec({ type: "character", id: "ch_y", title: "Harbor Watch", body: "docks docks docks", scope: "global" }),
      rec({ type: "character", id: "ch_x", title: "Lantern Keeper", body: "docks", scope: "character:ch_active", ownerId: "ch_active" }),
    ];
    const idx = buildContextSearchIndex(local);
    try {
      const flat = idx.search("docks");
      expect(flat.map((r) => r.id)).toEqual(["ch_y", "ch_x"]);

      const boosted = idx.search("docks", { scopeBoosts: ["character:ch_active"] });
      expect(boosted.map((r) => r.id)).toEqual(["ch_x", "ch_y"]);
    } finally {
      idx.dispose();
    }
  });

  test("limit caps the result count and defaults to DEFAULT_SEARCH_LIMIT", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      rec({ type: "character", id: `ch_${i}`, title: `Clone ${i}`, body: "shared keyword flavor", scope: "global" }),
    );
    const idx = buildContextSearchIndex(many);
    expect(idx.search("flavor").length).toBe(DEFAULT_SEARCH_LIMIT);
    expect(idx.search("flavor", { limit: 3 }).length).toBe(3);
    idx.dispose();
  });
});

describe("buildContextSearchIndex — DTO contract", () => {
  test("results never expose body content", () => {
    const idx = buildContextSearchIndex(corpus);
    try {
      const out = idx.search("aria");
      expect(out.length).toBeGreaterThanOrEqual(2);
      for (const r of out) {
        expect("body" in r).toBe(false);
        expect(Object.keys(r).sort()).toEqual([
          "channel",
          "id",
          "matchKind",
          "meta",
          "ownerId",
          "parentId",
          "scope",
          "title",
          "type",
        ]);
        const serialized = JSON.stringify(r);
        expect(serialized).not.toContain("Captain of the northern fleet");
        expect(serialized).not.toContain("docked at harbor");
      }
    } finally {
      idx.dispose();
    }
  });

  test("parent and meta metadata are surfaced", () => {
    const idx = buildContextSearchIndex(corpus);
    const out = idx.search("aurora");
    const le = out.find((r) => r.id === "le_aurora");
    expect(le).toBeDefined();
    expect(le?.parentId).toBe("lb_world");
    expect(le?.meta.lorebookId).toBe("lb_world");
    idx.dispose();
  });
});

describe("buildContextSearchIndex — query safety", () => {
  test("FTS5 operators in input do not throw and a legitimate quoted token still resolves", () => {
    const idx = buildContextSearchIndex(corpus);
    // a quoted single token still resolves the character (quotes stripped by tokenization)
    expect(idx.search('"aria"').some((r) => r.id === "ch_aria")).toBe(true);
    // operator-laden garbage must not throw; it is safe for it to return nothing
    let threw = false;
    try {
      idx.search('"aria" OR (NOT nothing) * ');
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    idx.dispose();
  });

  test("empty / whitespace query returns no results", () => {
    const idx = buildContextSearchIndex(corpus);
    expect(idx.search("")).toEqual([]);
    expect(idx.search("   ")).toEqual([]);
    idx.dispose();
  });
});
