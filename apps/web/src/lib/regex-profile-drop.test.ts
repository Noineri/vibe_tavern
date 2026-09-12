import { describe, expect, it } from "bun:test";
import { buildFlatVisualOrder, interpretRegexDrop, type FlatItem } from "./regex-profile-drop.js";

function makeFlat(sortableIds: string[], profileMap: Map<string, string | null> = new Map()): FlatItem[] {
  return sortableIds.map((sid) => {
    const [kind, id] = sid.split(":") as [ "profile" | "rule", string];
    return {
      sortableId: sid,
      id,
      kind,
      sortOrder: 0,
      profileId: kind === "rule" ? (profileMap.get(id) ?? null) : null,
    };
  });
}

describe("buildFlatVisualOrder", () => {
  it("interleaves profiles and standalone rules by sortOrder", () => {
    const profiles = [{ id: "p1", sortOrder: 1, name: "B" }, { id: "p2", sortOrder: 0, name: "A" }];
    const presets = [
      { id: "r1", sortOrder: 2, name: "R1", profileId: null as string | null },
      { id: "r2", sortOrder: 0, name: "R0", profileId: null },
    ];
    const flat = buildFlatVisualOrder(profiles, presets, new Set());
    expect(flat.map((f) => f.sortableId)).toEqual(["profile:p2", "rule:r2", "profile:p1", "rule:r1"]);
  });

  it("inline members when expanded", () => {
    const profiles = [{ id: "p1", sortOrder: 0, name: "P" }];
    const presets = [
      { id: "r1", sortOrder: 0, name: "A", profileId: null },
      { id: "r2", sortOrder: 1, name: "B", profileId: "p1" },
      { id: "r3", sortOrder: 0, name: "C", profileId: "p1" },
    ];
    const collapsed = buildFlatVisualOrder(profiles, presets, new Set());
    expect(collapsed.map((f) => f.sortableId)).toEqual(["rule:r1", "profile:p1"]);
    const expanded = buildFlatVisualOrder(profiles, presets, new Set(["p1"]));
    expect(expanded.map((f) => f.sortableId)).toEqual(["rule:r1", "profile:p1", "rule:r3", "rule:r2"]);
  });
});

describe("interpretRegexDrop", () => {
  it("standalone → profile header = attach", () => {
    const flat = makeFlat(["profile:p1", "rule:r1", "rule:r2"]);
    expect(interpretRegexDrop(flat, "rule:r1", "profile:p1")).toMatchObject({ kind: "attach", ruleId: "r1", profileId: "p1" });
  });

  it("standalone → member of profile = attach", () => {
    const flat = makeFlat(["profile:p1", "rule:r2", "rule:r1"], new Map([["r2", "p1"]]));
    // flat already has r2 as member, but our flat builder would set profileId for r2
    // simulate: r2 is member
    flat[1].profileId = "p1";
    expect(interpretRegexDrop(flat, "rule:r1", "rule:r2")).toMatchObject({ kind: "attach", ruleId: "r1", profileId: "p1" });
  });

  it("member → standalone = detach", () => {
    const flat = makeFlat(["profile:p1", "rule:r2", "rule:r1"], new Map([["r2", "p1"]]));
    flat[1].profileId = "p1";
    expect(interpretRegexDrop(flat, "rule:r2", "rule:r1")).toMatchObject({ kind: "detach", ruleId: "r2" });
  });

  it("member → different profile = attach", () => {
    const flat = makeFlat(["profile:p1", "rule:r1", "profile:p2", "rule:r2"], new Map([["r1", "p1"], ["r2", "p2"]]));
    flat[1].profileId = "p1";
    flat[3].profileId = "p2";
    expect(interpretRegexDrop(flat, "rule:r1", "profile:p2")).toMatchObject({ kind: "attach", ruleId: "r1", profileId: "p2" });
  });

  it("member within same profile = move-within-profile", () => {
    const flat = makeFlat(["profile:p1", "rule:r1", "rule:r2"], new Map([["r1", "p1"], ["r2", "p1"]]));
    flat[1].profileId = "p1";
    flat[2].profileId = "p1";
    expect(interpretRegexDrop(flat, "rule:r1", "rule:r2")).toMatchObject({ kind: "move-within-profile", ruleId: "r1", profileId: "p1" });
  });

  it("standalone → standalone = reorder", () => {
    const flat = makeFlat(["rule:r1", "rule:r2"]);
    expect(interpretRegexDrop(flat, "rule:r1", "rule:r2")).toMatchObject({ kind: "reorder" });
  });

  it("profile → profile = reorder", () => {
    const flat = makeFlat(["profile:p1", "profile:p2", "rule:r1"]);
    expect(interpretRegexDrop(flat, "profile:p1", "profile:p2")).toMatchObject({ kind: "reorder" });
  });
});
