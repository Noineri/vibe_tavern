import { describe, expect, test } from "bun:test";

import { createDb } from "../src/db-connection.js";
import { SkillOrderStore } from "../src/stores/skill-order-store.js";

/** Entries shaped like scanner catalog entries (applyOrder is id-generic). */
function entry(id: string, extra: Record<string, unknown> = {}) {
  return { id, ...extra };
}

async function mkStore(): Promise<SkillOrderStore> {
  // :memory: rides the TS-1 template — the real migrations (incl. 0125) run
  // once per process into the template; this copy is <1 ms.
  const db = await createDb(":memory:");
  return new SkillOrderStore(db);
}

describe("SkillOrderStore — merge rule (ML-7)", () => {
  test("empty table (first boot): every id is unknown → plain alphabetical order, regardless of the caller's input order", async () => {
    const store = await mkStore();
    expect(await store.list("coauthor")).toEqual([]);
    const ordered = await store.applyOrder("coauthor", [entry("gamma"), entry("alpha"), entry("beta")]);
    expect(ordered.map((e) => e.id)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("known ids come first in stored order; unknown ids LAST, alphabetical between themselves", async () => {
    const store = await mkStore();
    await store.reorder("coauthor", [
      { id: "delta", sortOrder: 0 },
      { id: "beta", sortOrder: 1 },
    ]);
    const ordered = await store.applyOrder("coauthor", [
      entry("alpha"),
      entry("beta"),
      entry("gamma"),
      entry("delta"),
      entry("epsilon"),
    ]);
    // Known: delta (0), beta (1). Unknown alphabetical: alpha < epsilon < gamma.
    expect(ordered.map((e) => e.id)).toEqual(["delta", "beta", "alpha", "epsilon", "gamma"]);
  });

  test("equal stored positions fall back to id (total order — a payload with duplicate sortOrders never shuffles)", async () => {
    const store = await mkStore();
    await store.reorder("coauthor", [
      { id: "zeta", sortOrder: 0 },
      { id: "alpha", sortOrder: 0 },
    ]);
    const ordered = await store.applyOrder("coauthor", [entry("zeta"), entry("alpha")]);
    expect(ordered.map((e) => e.id)).toEqual(["alpha", "zeta"]);
  });

  test("a shadowed id has ONE deterministic position: the order keys rows by id alone (the catalog layer collapses a builtin/user shadow to one user-won entry, so the winner sits at the stored slot whichever source it came from)", async () => {
    const store = await mkStore();
    await store.reorder("coauthor", [
      { id: "shared", sortOrder: 0 },
      { id: "other", sortOrder: 1 },
    ]);
    // The catalog hands applyOrder ONE entry per id (source: "user",
    // shadowsBuiltin: true for the shadow) — extra fields ride along untouched.
    const ordered = await store.applyOrder("coauthor", [
      entry("other", { source: "builtin" }),
      entry("shared", { source: "user", shadowsBuiltin: true }),
    ]);
    expect(ordered.map((e) => e.id)).toEqual(["shared", "other"]);
    expect(ordered[0]).toEqual({ id: "shared", source: "user", shadowsBuiltin: true });
  });

  test("library isolation: one library's rows never surface in another library's order", async () => {
    const store = await mkStore();
    await store.reorder("coauthor", [{ id: "alpha", sortOrder: 0 }]);
    await store.reorder("experience", [
      { id: "beta", sortOrder: 0 },
      { id: "alpha", sortOrder: 1 },
    ]);
    expect((await store.list("coauthor")).map((r) => r.skillId)).toEqual(["alpha"]);
    expect((await store.list("experience")).map((r) => r.skillId)).toEqual(["beta", "alpha"]);
    // The coauthor order (alpha only) does not reorder experience's entries.
    const ordered = await store.applyOrder("coauthor", [entry("beta"), entry("alpha")]);
    expect(ordered.map((e) => e.id)).toEqual(["alpha", "beta"]);
  });
});

describe("SkillOrderStore — reorder (ML-7)", () => {
  test("persists the payload as the library's whole map: list returns the stored positions", async () => {
    const store = await mkStore();
    await store.reorder("coauthor", [
      { id: "gamma", sortOrder: 0 },
      { id: "alpha", sortOrder: 1 },
      { id: "beta", sortOrder: 2 },
    ]);
    expect(await store.list("coauthor")).toEqual([
      { library: "coauthor", skillId: "gamma", sortOrder: 0 },
      { library: "coauthor", skillId: "alpha", sortOrder: 1 },
      { library: "coauthor", skillId: "beta", sortOrder: 2 },
    ]);
  });

  test("the payload REPLACES the map: an id absent from the new payload loses its row (becomes unknown to the merge rule)", async () => {
    const store = await mkStore();
    await store.reorder("coauthor", [
      { id: "alpha", sortOrder: 0 },
      { id: "beta", sortOrder: 1 },
    ]);
    await store.reorder("coauthor", [{ id: "beta", sortOrder: 0 }]);
    expect((await store.list("coauthor")).map((r) => r.skillId)).toEqual(["beta"]);
    const ordered = await store.applyOrder("coauthor", [entry("alpha"), entry("beta")]);
    // alpha lost its row → unknown → after the known beta.
    expect(ordered.map((e) => e.id)).toEqual(["beta", "alpha"]);
  });

  test("unknown ids in the payload get slots too: the row is inert until that id exists, then the skill surfaces at its stored position", async () => {
    const store = await mkStore();
    await store.reorder("coauthor", [
      { id: "ghost", sortOrder: 0 },
      { id: "alpha", sortOrder: 1 },
    ]);
    // ghost not in the catalog yet → never surfaces.
    expect((await store.applyOrder("coauthor", [entry("alpha")])).map((e) => e.id)).toEqual(["alpha"]);
    // ghost appears (imported/created later) → takes its stored slot.
    const ordered = await store.applyOrder("coauthor", [entry("alpha"), entry("ghost")]);
    expect(ordered.map((e) => e.id)).toEqual(["ghost", "alpha"]);
  });

  test("one synchronous transaction: a duplicate id in the payload violates the composite PK and rolls back the WHOLE replace (the previous map survives)", async () => {
    const store = await mkStore();
    await store.reorder("coauthor", [{ id: "alpha", sortOrder: 0 }]);
    await expect(
      store.reorder("coauthor", [
        { id: "beta", sortOrder: 0 },
        { id: "beta", sortOrder: 1 },
      ]),
    ).rejects.toThrow();
    // The delete inside the failed transaction rolled back too.
    expect(await store.list("coauthor")).toEqual([{ library: "coauthor", skillId: "alpha", sortOrder: 0 }]);
  });

  test("an empty payload clears the library's map (everything becomes unknown — alphabetical)", async () => {
    const store = await mkStore();
    await store.reorder("coauthor", [{ id: "beta", sortOrder: 0 }, { id: "alpha", sortOrder: 1 }]);
    await store.reorder("coauthor", []);
    expect(await store.list("coauthor")).toEqual([]);
    const ordered = await store.applyOrder("coauthor", [entry("beta"), entry("alpha")]);
    expect(ordered.map((e) => e.id)).toEqual(["alpha", "beta"]);
  });
});
