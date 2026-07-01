import { describe, test, expect } from "bun:test";
import { buildLineDiff } from "../components/shared/TextDiffPreview.js";
import { groupHunks, mergeSelectedBody, allHunkIds } from "./coauthor-hunk-merge.js";

/**
 * CA-12 hunk-merge algebra. The load-bearing invariants: all-selected ===
 * proposed body, none === canonical body, subset === coherent hybrid. These
 * pin the contract the partial-Apply path (`buildPartialApplyRequest`) relies on.
 */

const CANONICAL = ["# PERSONALITY", "Bold.", "Kind.", "", "# SCENARIO", "A cave.", ""].join("\n");
const PROPOSED = ["# PERSONALITY", "Bold.", "Fierce.", "", "# SCENARIO", "A cave at dusk.", ""].join("\n");
// Hunks: Kind.→Fierce. (hunk 0), A cave.→A cave at dusk. (hunk 1).

describe("groupHunks", () => {
  test("groups consecutive add/remove into one hunk, splits at context lines", () => {
    const diff = buildLineDiff(CANONICAL, PROPOSED);
    const hunks = groupHunks(diff);
    expect(hunks.length).toBe(2);
    expect(hunks[0]).toMatchObject({ id: 0, added: 1, removed: 1 });
    expect(hunks[1]).toMatchObject({ id: 1, added: 1, removed: 1 });
    // Non-overlapping, in order.
    expect(hunks[0]!.end).toBeLessThanOrEqual(hunks[1]!.start);
  });

  test("identical bodies yield no hunks", () => {
    const diff = buildLineDiff(CANONICAL, CANONICAL);
    expect(groupHunks(diff)).toEqual([]);
  });

  test("tooLarge diff yields no hunks", () => {
    const diff = { lines: [], added: 0, removed: 0, tooLarge: true };
    expect(groupHunks(diff)).toEqual([]);
  });

  test("a pure-insertion proposal groups as add-only hunks", () => {
    const diff = buildLineDiff(["A", "B"].join("\n"), ["A", "X", "B"].join("\n"));
    const hunks = groupHunks(diff);
    expect(hunks.length).toBe(1);
    expect(hunks[0]).toMatchObject({ id: 0, added: 1, removed: 0 });
  });
});

describe("mergeSelectedBody", () => {
  test("ALL hunks selected → merged body === proposed body", () => {
    const diff = buildLineDiff(CANONICAL, PROPOSED);
    const merged = mergeSelectedBody(diff, allHunkIds(groupHunks(diff)));
    expect(merged).toBe(PROPOSED);
  });

  test("ALL selected is the default (omitted selection) — CA-11 wholesale parity", () => {
    const diff = buildLineDiff(CANONICAL, PROPOSED);
    expect(mergeSelectedBody(diff)).toBe(PROPOSED);
  });

  test("NO hunks selected → merged body === canonical body", () => {
    const diff = buildLineDiff(CANONICAL, PROPOSED);
    const merged = mergeSelectedBody(diff, new Set());
    expect(merged).toBe(CANONICAL);
  });

  test("subset: accept hunk 0 (Kind→Fierce), reject hunk 1 (scenario) → hybrid", () => {
    const diff = buildLineDiff(CANONICAL, PROPOSED);
    const merged = mergeSelectedBody(diff, new Set([0]));
    expect(merged).toBe(
      ["# PERSONALITY", "Bold.", "Fierce.", "", "# SCENARIO", "A cave.", ""].join("\n"),
    );
    // Personality reflects the proposed edit; scenario stays canonical.
    expect(merged).toContain("Fierce.");
    expect(merged).toContain("A cave.");
    expect(merged).not.toContain("A cave at dusk.");
  });

  test("subset: reject hunk 0, accept hunk 1 → inverse hybrid", () => {
    const diff = buildLineDiff(CANONICAL, PROPOSED);
    const merged = mergeSelectedBody(diff, new Set([1]));
    expect(merged).toContain("Kind."); // personality unchanged
    expect(merged).toContain("A cave at dusk."); // scenario edited
  });

  test("identical bodies (no hunks) → merge returns the (canonical=proposed) body", () => {
    const diff = buildLineDiff(CANONICAL, CANONICAL);
    expect(mergeSelectedBody(diff, new Set())).toBe(CANONICAL);
  });

  test("pure insertion: rejecting the add-only hunk keeps canonical; accepting inserts", () => {
    const canon = ["A", "B"].join("\n");
    const proposed = ["A", "X", "B"].join("\n");
    const diff = buildLineDiff(canon, proposed);
    expect(mergeSelectedBody(diff, new Set())).toBe(canon); // reject → no insert
    expect(mergeSelectedBody(diff, new Set([0]))).toBe(proposed); // accept → insert
  });

  test("pure deletion: accepting the remove-only hunk deletes; rejecting keeps", () => {
    const canon = ["A", "X", "B"].join("\n");
    const proposed = ["A", "B"].join("\n");
    const diff = buildLineDiff(canon, proposed);
    const hunks = groupHunks(diff);
    expect(hunks[0]).toMatchObject({ added: 0, removed: 1 });
    expect(mergeSelectedBody(diff, new Set([0]))).toBe(proposed); // accept deletion
    expect(mergeSelectedBody(diff, new Set())).toBe(canon); // reject → keep line
  });
});

describe("allHunkIds", () => {
  test("returns a set of every hunk id", () => {
    const diff = buildLineDiff(CANONICAL, PROPOSED);
    expect(allHunkIds(groupHunks(diff))).toEqual(new Set([0, 1]));
  });
  test("empty for no hunks", () => {
    expect(allHunkIds([])).toEqual(new Set());
  });
});
