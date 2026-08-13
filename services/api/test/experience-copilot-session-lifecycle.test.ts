import { describe, expect, it } from "bun:test";
import { createDb, ExperienceCopilotStore, type StoreClock, type StoreIdGenerator, type StoreContainer } from "@vibe-tavern/db";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";

// ─── Real store + adapter wiring ─────────────────────────────────────────────
//
// Unlike experience-copilot-lifecycle.test.ts (which uses a fake store to pin
// the adapter's wire mapping in isolation), this test drives the REAL
// ExperienceCopilotStore through the adapter against an in-memory SQLite DB —
// because the session-lifecycle contracts (ordering, at-most-one-active sibling
// archiving, idempotent archive, not-found) are store semantics, not adapter
// mapping. The adapter is still the system under test: every assertion reads
// through its wire-typed methods, so the store + mapper path is pinned together.

// Advancing clock so timestamps differ between sessions (listSessions orders by
// updatedAt desc). Resets per test via setup().
let clockBase = Date.parse("2026-06-15T00:00:00.000Z");
let clockStep = 0;
function makeClock(): StoreClock {
  return { now: () => new Date(clockBase + clockStep++ * 1000).toISOString() };
}
let idCounter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++idCounter}` };

async function setup() {
  clockStep = 0;
  const db = await createDb(":memory:");
  const store = new ExperienceCopilotStore(db, { clock: makeClock(), idGenerator: idGen });
  const adapter = new ExperienceCopilotAdapter({ experienceCopilot: store } as unknown as StoreContainer);
  return { store, adapter };
}

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

describe("ExperienceCopilotAdapter session lifecycle (ER-12a)", () => {
  it("listSessions returns active + archived threads newest-first and excludes other scripts", async () => {
    const { store, adapter } = await setup();

    const older = await store.startNewSession("script_a", "Older");
    const newer = await store.startNewSession("script_a", "Newer"); // archives `older`
    const other = await store.startNewSession("script_b", "Other");

    const sessions = await adapter.experienceCopilotListSessions("script_a");

    // Store's documented order: updatedAt desc (newer was touched last, so it
    // leads), with `older` archived but still present.
    expect(sessions.map((s) => s.id)).toEqual([newer.id, older.id]);
    expect(sessions.some((s) => s.archivedAt === null)).toBe(true);
    expect(sessions.some((s) => s.archivedAt !== null)).toBe(true);
    // A different script's threads never leak into the result.
    expect(sessions.some((s) => s.id === other.id)).toBe(false);

    // Wire mapping: branded ids flatten to plain strings, nullable fields stay
    // null (never undefined).
    expect(sessions[0]).toEqual({
      id: newer.id,
      scriptId: "script_a",
      draftSessionId: null,
      title: "Newer",
      archivedAt: null,
      createdAt: newer.createdAt,
      updatedAt: newer.updatedAt,
    });
  });

  it("activate resumes an archived session and archives its previously-active sibling", async () => {
    const { store, adapter } = await setup();

    const first = await store.startNewSession("script_a", "First");
    const second = await store.startNewSession("script_a", "Second"); // second active

    const wire = await adapter.experienceCopilotActivate(first.id);
    expect(wire).not.toBeNull();
    expect(wire?.id).toBe(first.id);
    expect(wire?.archivedAt).toBeNull();

    // At-most-one-active holds: `first` is now the sole active, `second` archived.
    const sessions = await store.listSessions("script_a");
    const actives = sessions.filter((s) => s.archivedAt === null);
    expect(actives).toHaveLength(1);
    expect(actives[0].id).toBe(first.id);
    expect((await store.getById(second.id))?.archivedAt).not.toBeNull();
  });

  it("activate on the already-active session is a no-op (returns it unchanged)", async () => {
    const { store, adapter } = await setup();

    const active = await store.startNewSession("script_a", "Active");
    const wire = await adapter.experienceCopilotActivate(active.id);

    expect(wire?.id).toBe(active.id);
    expect(wire?.archivedAt).toBeNull();
    const sessions = await store.listSessions("script_a");
    expect(sessions.filter((s) => s.archivedAt === null)).toHaveLength(1);
  });

  it("archive sets archivedAt and is idempotent", async () => {
    const { store, adapter } = await setup();

    const active = await store.startNewSession("script_a", "Active");
    const archived = await adapter.experienceCopilotArchive(active.id);
    expect(archived?.archivedAt).not.toBeNull();
    expect(await store.getActive("script_a")).toBeNull();

    // Second archive returns the thread unchanged (same archivedAt, no error).
    const archivedAgain = await adapter.experienceCopilotArchive(active.id);
    expect(archivedAgain?.archivedAt).not.toBeNull();
    expect(archivedAgain?.archivedAt).toBe(archived?.archivedAt);
  });

  it("activate / archive on a missing id return null", async () => {
    const { adapter } = await setup();

    expect(await adapter.experienceCopilotActivate("nope")).toBeNull();
    expect(await adapter.experienceCopilotArchive("nope")).toBeNull();
  });
});
