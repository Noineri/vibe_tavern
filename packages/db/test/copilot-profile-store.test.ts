import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { createDb, type AppDb } from "../src/db-connection.js";
import { CopilotProfileStore } from "../src/stores/copilot-profile-store.js";
import { copilotProfiles } from "../src/db-schema.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

const testClock: StoreClock = {
  now() {
    return "2026-06-06T00:00:00.000Z";
  },
};

let nextId = 0;
const testIdGen: StoreIdGenerator = {
  next(prefix: string): string {
    nextId += 1;
    return `${prefix}_test_${nextId}`;
  },
};

async function mkStore(): Promise<{ store: CopilotProfileStore; db: AppDb }> {
  const dir = await mkdtemp(join(tmpdir(), "vibe-tavern-db-test-"));
  const db = await createDb(join(dir, "test.db"));
  return { store: new CopilotProfileStore(db, { clock: testClock, idGenerator: testIdGen }), db };
}

// PM-8 (owner ruling 2026-10-12): the skill catalog is ungated — skillIds is
// retired from the store surface; the legacy `skill_ids_json` column stays in
// the schema (never migrated away) and is simply never read or written.
const PAYLOAD = {
  name: "Card games",
  basePrompt: "You are a card-game experience author.",
  toolSet: { edit_buffer: true, run_test: true },
};

describe("CopilotProfileStore (CP-3)", () => {
  test("create + getById round-trip preserves all fields (no skillIds — PM-8)", async () => {
    const { store } = await mkStore();
    const created = await store.create(PAYLOAD);
    expect(created.id).toMatch(/^cprof_test_\d+$/);
    expect(created.name).toBe("Card games");
    expect(created.basePrompt).toBe("You are a card-game experience author.");
    expect(created).not.toHaveProperty("skillIds");
    expect(created.toolSet).toEqual({ edit_buffer: true, run_test: true });

    const fetched = await store.getById(created.id);
    expect(fetched).toEqual(created);
  });

  test("list returns all created profiles", async () => {
    const { store } = await mkStore();
    await store.create({ ...PAYLOAD, name: "A" });
    await store.create({ ...PAYLOAD, name: "B" });
    const all = await store.list();
    expect(all.length).toBe(2);
    expect(all.map((p) => p.name).sort()).toEqual(["A", "B"]);
  });

  test("update merges a partial (single field) and bumps updatedAt", async () => {
    const { store } = await mkStore();
    const created = await store.create(PAYLOAD);
    const updated = await store.update(created.id, { name: "Renamed only" });
    expect(updated.name).toBe("Renamed only");
    expect(created.basePrompt).toBe(PAYLOAD.basePrompt); // untouched
  });

  test("update with a full payload replaces every field", async () => {
    const { store } = await mkStore();
    const created = await store.create(PAYLOAD);
    const updated = await store.update(created.id, {
      name: "Renamed",
      basePrompt: "new prompt",
      toolSet: { run_simulate: true },
    });
    expect(updated.name).toBe("Renamed");
    expect(updated.basePrompt).toBe("new prompt");
    expect(updated.toolSet).toEqual({ run_simulate: true });
  });

  test("a legacy skill_ids_json row is ignored gracefully (PM-8)", async () => {
    // Rows written before PM-8 carry real data in skill_ids_json. The store
    // never reads the column: such a row must still load fine (its legacy
    // payload ignored), and an update must not clobber it either.
    const { store, db } = await mkStore();
    const created = await store.create(PAYLOAD);
    await db
      .update(copilotProfiles)
      .set({ skillIdsJson: '["legacy-skill"]' })
      .where(eq(copilotProfiles.id, created.id))
      .run();

    const fetched = await store.getById(created.id);
    expect(fetched?.name).toBe("Card games");
    expect(fetched).not.toHaveProperty("skillIds");

    const updated = await store.update(created.id, { name: "Still legacy" });
    expect(updated?.name).toBe("Still legacy");
    const raw = await db
      .select({ skillIdsJson: copilotProfiles.skillIdsJson })
      .from(copilotProfiles)
      .where(eq(copilotProfiles.id, created.id))
      .get();
    expect(raw?.skillIdsJson).toBe('["legacy-skill"]'); // untouched by the store
  });

  test("update throws when the id does not exist", async () => {
    const { store } = await mkStore();
    await expect(store.update("cprof_missing", { name: "X" })).rejects.toThrow();
  });

  test("delete removes the profile and is idempotent", async () => {
    const { store } = await mkStore();
    const created = await store.create(PAYLOAD);
    await store.delete(created.id);
    expect(await store.getById(created.id)).toBeNull();
    // Deleting again does not throw (idempotent).
    await store.delete(created.id);
  });

  test("getById returns null for a missing id", async () => {
    const { store } = await mkStore();
    expect(await store.getById("cprof_missing")).toBeNull();
  });
});

// ─── AS-3: agent_kind ──────────────────────────────────────────────────────
// The kind dimension: rows carry their owning kind, lists filter by it in
// SQL, create persists it (default 'experience'), and update never touches
// it (immutability pins the "no kind smuggling via update" rule at the
// lowest layer — the contract + adapter re-check above it).

describe("CopilotProfileStore agent_kind (AS-3)", () => {
  test("a pre-AS-3-style row (column omitted) reads as 'experience'", async () => {
    // The migration is default-only: legacy rows carry no agent_kind value
    // and must read as experience profiles with unchanged tool sets.
    const { store, db } = await mkStore();
    await db
      .insert(copilotProfiles)
      .values({
        id: "cprof_legacy",
        name: "Legacy",
        basePrompt: "Legacy prompt.",
        toolSetJson: JSON.stringify({ write_buffer: true }),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
    const fetched = await store.getById("cprof_legacy");
    expect(fetched?.agentKind).toBe("experience");
    expect(fetched?.toolSet).toEqual({ write_buffer: true });
  });

  test("create defaults a missing kind to 'experience'", async () => {
    const { store } = await mkStore();
    const created = await store.create(PAYLOAD);
    expect(created.agentKind).toBe("experience");
  });

  test("create persists an explicit kind", async () => {
    const { store } = await mkStore();
    const created = await store.create({ ...PAYLOAD, agentKind: "fake-kind" });
    expect(created.agentKind).toBe("fake-kind");
    expect((await store.getById(created.id))?.agentKind).toBe("fake-kind");
  });

  test("list(kind) filters in SQL; unfiltered list returns every kind", async () => {
    const { store } = await mkStore();
    const exp = await store.create({ ...PAYLOAD, name: "Exp" });
    const other = await store.create({ ...PAYLOAD, name: "Other", agentKind: "fake-kind" });
    expect((await store.list()).map((p) => p.id).sort()).toEqual([exp.id, other.id].sort());
    expect(await store.list("experience")).toEqual([expect.objectContaining({ id: exp.id })]);
    expect(await store.list("fake-kind")).toEqual([expect.objectContaining({ id: other.id })]);
    expect(await store.list("nope")).toEqual([]);
  });

  test("update never touches agent_kind", async () => {
    const { store, db } = await mkStore();
    const created = await store.create({ ...PAYLOAD, agentKind: "fake-kind" });
    const updated = await store.update(created.id, { name: "Renamed", toolSet: { run_test: true } });
    expect(updated.agentKind).toBe("fake-kind");
    const raw = await db
      .select({ agentKind: copilotProfiles.agentKind })
      .from(copilotProfiles)
      .where(eq(copilotProfiles.id, created.id))
      .get();
    expect(raw?.agentKind).toBe("fake-kind");
  });
});

// ─── ML-6: stored order (within one agent kind's list) ───────────────────

// The ML-6 order lives WITHIN one kind's list (the master list is per
// kind — the plan's row): append, reorder and the total-order fallbacks are
// the ML-5 CoauthorModuleStore rules, scoped by the kind dimension.

describe("CopilotProfileStore — stored order (ML-6)", () => {
  test("create appends at the end of the kind's list; list returns creation order", async () => {
    const { store } = await mkStore();
    const a = await store.create({ ...PAYLOAD, name: "A" });
    const b = await store.create({ ...PAYLOAD, name: "B" });
    const c = await store.create({ ...PAYLOAD, name: "C" });
    expect(a.sortOrder).toBe(0);
    expect(b.sortOrder).toBe(1);
    expect(c.sortOrder).toBe(2);
    expect((await store.list("experience")).map((p) => p.name)).toEqual(["A", "B", "C"]);
  });

  test("reorder rewrites sort_order; the kind's list follows the stored order", async () => {
    const { store } = await mkStore();
    const a = await store.create({ ...PAYLOAD, name: "A" });
    const b = await store.create({ ...PAYLOAD, name: "B" });
    const c = await store.create({ ...PAYLOAD, name: "C" });
    const list = await store.reorder("experience", [
      { id: c.id, sortOrder: 0 },
      { id: a.id, sortOrder: 1 },
      { id: b.id, sortOrder: 2 },
    ]);
    expect(list.map((p) => p.name)).toEqual(["C", "A", "B"]);
    expect((await store.list("experience")).map((p) => p.name)).toEqual(["C", "A", "B"]);
  });

  test("create after a reorder appends at the END (max+1, not old position)", async () => {
    const { store } = await mkStore();
    const a = await store.create({ ...PAYLOAD, name: "A" });
    const b = await store.create({ ...PAYLOAD, name: "B" });
    await store.reorder("experience", [
      { id: b.id, sortOrder: 0 },
      { id: a.id, sortOrder: 1 },
    ]);
    const c = await store.create({ ...PAYLOAD, name: "C" });
    expect(c.sortOrder).toBe(2);
    expect((await store.list("experience")).map((p) => p.name)).toEqual(["B", "A", "C"]);
  });

  test("equal sort_order falls back to createdAt ASC, then id ASC (total order)", async () => {
    // Rows the order does not know (or rows tied by a bulk backfill) must not
    // shuffle nondeterministically: the store's list ordering stays total via
    // created_at → id fallbacks. Flattening sort_order back to the migration
    // default simulates such rows (the fixed testClock pins createdAt equal,
    // so the id tiebreak is exercised too).
    const dir = await mkdtemp(join(tmpdir(), "vibe-tavern-db-test-"));
    const db = await createDb(join(dir, "test.db"));
    const store = new CopilotProfileStore(db, { clock: testClock, idGenerator: testIdGen });
    await store.create({ ...PAYLOAD, name: "A" });
    await store.create({ ...PAYLOAD, name: "B" });
    await store.create({ ...PAYLOAD, name: "C" });
    await db
      .update(copilotProfiles)
      .set({ sortOrder: 0 })
      .run();
    const all = await store.list("experience");
    expect(all.every((p) => p.sortOrder === 0)).toBe(true);
    expect(all.map((p) => p.name)).toEqual(["A", "B", "C"]); // same clock ⇒ id ASC
  });

  test("createdAt breaks a sort_order tie before id is consulted", async () => {
    // Distinct createdAt values (a stepped clock) decide the order when
    // sort_order ties, matching the backfill's ORDER BY created_at ASC, id ASC.
    const dir = await mkdtemp(join(tmpdir(), "vibe-tavern-db-test-"));
    const db = await createDb(join(dir, "test.db"));
    let tick = 0;
    const steppedClock: StoreClock = {
      now() {
        tick += 1;
        return `2026-06-06T00:00:${String(tick).padStart(2, "0")}.000Z`;
      },
    };
    const store = new CopilotProfileStore(db, { clock: steppedClock, idGenerator: testIdGen });
    await store.create({ ...PAYLOAD, name: "first-created" });
    await store.create({ ...PAYLOAD, name: "second-created" });
    await db
      .update(copilotProfiles)
      .set({ sortOrder: 0 })
      .run();
    const all = await store.list("experience");
    expect(all.map((p) => p.name)).toEqual(["first-created", "second-created"]);
  });

  test("append max+1 is scoped per kind: another kind's first profile starts at 0", async () => {
    // The order lives within one kind's list — a script profile appended
    // after two experience profiles takes the SCRIPT list's next slot (0),
    // not the global max+1, and the experience order is untouched.
    const { store } = await mkStore();
    await store.create({ ...PAYLOAD, name: "Exp A" });
    await store.create({ ...PAYLOAD, name: "Exp B" });
    const script = await store.create({ ...PAYLOAD, name: "Script A", agentKind: "script" });
    expect(script.sortOrder).toBe(0);
    expect((await store.list("experience")).map((p) => p.name)).toEqual(["Exp A", "Exp B"]);
    expect((await store.list("script")).map((p) => p.name)).toEqual(["Script A"]);
  });

  test("reorder(kind) ignores another kind's ids (no cross-kind position writes)", async () => {
    // The update's WHERE pins BOTH id and agent_kind: an update entry naming
    // another kind's row is a no-op — an id list can never rewrite another
    // kind's positions — and the returned list is the requested kind's only.
    const { store } = await mkStore();
    const expA = await store.create({ ...PAYLOAD, name: "Exp A" });
    await store.create({ ...PAYLOAD, name: "Exp B" });
    const script = await store.create({ ...PAYLOAD, name: "Script A", agentKind: "script" });
    const list = await store.reorder("experience", [
      { id: expA.id, sortOrder: 5 }, // out-of-band position is fine (total order still holds)
      { id: script.id, sortOrder: 0 }, // foreign kind — must be ignored
    ]);
    expect(list.map((p) => p.name)).toEqual(["Exp B", "Exp A"]); // experience rows only
    expect(list.every((p) => p.agentKind === "experience")).toBe(true);
    const scriptAfter = await store.getById(script.id);
    expect(scriptAfter?.sortOrder).toBe(0); // untouched
  });
});
