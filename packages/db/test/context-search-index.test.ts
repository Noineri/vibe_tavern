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
    const out = idx.search("ARIA STORMWIND");
    expect(out[0].id).toBe("ch_aria");
    expect(out[0].matchKind).toBe("exact-title");
    // Cyrillic exact
    const ru = idx.search("борис крэг");
    expect(ru[0].id).toBe("ch_boris");
    expect(ru[0].matchKind).toBe("exact-title");
    idx.dispose();
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
    // Query "aria" has a strong content/exact match; ensure a trigram-only
    // partial such as a contrived "ari" does not outrank it. We verify the
    // banding invariant: any content result precedes any trigram-only result.
    const idx = buildContextSearchIndex(corpus);
    const out = idx.search("aria");
    let sawTrigram = false;
    for (const r of out) {
      if (r.matchKind === "trigram-title") sawTrigram = true;
      else if (sawTrigram && (r.matchKind === "content" || r.matchKind === "exact-title")) {
        throw new Error("content match appeared after a trigram match — banding broken");
      }
    }
    idx.dispose();
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
    // Two characters share no title here, so use a content query that hits both
    // a global and an active-scope record, then verify scope ordering.
    const local = [
      rec({ type: "character", id: "ch_x", title: "Harbor Master", body: "runs the docks", scope: "character:ch_active", ownerId: "ch_active" }),
      rec({ type: "character", id: "ch_y", title: "Harbor Master Duplicate", body: "runs the docks elsewhere", scope: "global" }),
    ];
    const idx = buildContextSearchIndex(local);
    const flat = idx.search("docks");
    const flatIds = flat.map((r) => r.id);
    const boosted = idx.search("docks", { scopeBoosts: ["character:ch_active"] });
    const boostedIds = boosted.map((r) => r.id);
    // with boost, the active-scope record precedes the global one
    const posActive = boostedIds.indexOf("ch_x");
    const posGlobal = boostedIds.indexOf("ch_y");
    expect(posActive).toBeGreaterThanOrEqual(0);
    expect(posGlobal).toBeGreaterThanOrEqual(0);
    expect(posActive).toBeLessThan(posGlobal);
    // both still present
    expect(boostedIds.sort()).toEqual(flatIds.sort());
    idx.dispose();
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
    for (const r of idx.search("aria")) {
      expect((r as unknown as Record<string, unknown>).body).toBeUndefined();
    }
    idx.dispose();
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
