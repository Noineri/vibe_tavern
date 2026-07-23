import { describe, test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { createDb, type AppDb } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";
import { ContentStore } from "../src/content-store.js";
import { createFileStore } from "../src/file-store.js";
import { PresetStore } from "../src/stores/preset-store.js";
import { CharacterAssetStore } from "../src/stores/character-asset-store.js";
import { ChatStore } from "../src/stores/chat-store.js";
import { ChatSummaryStore } from "../src/stores/chat-summary-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// ASYNC_TRANSACTION_AUDIT fix-step 6 (remaining reorder operations): pins the
// three last reorder transactions (preset, character-asset, chat-summary) are
// truly SYNCHRONOUS bun:sqlite callbacks. Each is a plain loop of
// `tx.update(...).set({sortOrder|order})` over a caller-supplied id list; a
// failure on a LATER update must roll the EARLIER ones back so no half-applied
// reorder leaks. Step 6 is deliberately narrow — reorder/replace rollback only,
// no validate/dedup changes (those belong to steps 3–5).

// ─── Test harness ────────────────────────────────────────────────────────────

const FIXED_NOW = "2026-07-23T00:00:00.000Z";
let n = 0;
const tickClock: StoreClock = {
  now() {
    return new Date(Date.parse(FIXED_NOW) + ++n * 1000).toISOString();
  },
};
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_arb_${++n}` };

function bootstrapCharacter(db: AppDb) {
  db.insert(schema.characters).values({
    id: "char_1", name: "TestChar", description: "", firstMessage: "hi",
    alternateGreetingsJson: "[]", extensionsJson: "{}", tagsJson: "[]",
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
}

// ─── PresetStore ─────────────────────────────────────────────────────────────

describe("PresetStore synchronous reorder rollback (ASYNC_TRANSACTION_AUDIT step 6)", () => {
  test("reorder preserves the prior complete order when a mid-reorder update fails", async () => {
    const db = await createDb(":memory:");
    const store = new PresetStore(db, { clock: tickClock, idGenerator: idGen, content: null });
    const a = await store.create({ name: "A" }); // sortOrder 0
    const b = await store.create({ name: "B" }); // sortOrder 1
    const c = await store.create({ name: "C" }); // sortOrder 2
    expect((await store.listAll()).map((p) => p.name)).toEqual(["A", "B", "C"]);

    // Fail the LAST reorder update (c). The two earlier updates already landed
    // inside the tx; they must roll back too.
    db.run(sql`CREATE TRIGGER fail_preset_c BEFORE UPDATE ON prompt_presets WHEN NEW.id = '${sql.raw(c.id)}' BEGIN SELECT RAISE(ABORT, 'injected preset boom'); END`);

    await expect(store.reorder([
      { id: a.id, sortOrder: 2 },
      { id: b.id, sortOrder: 1 },
      { id: c.id, sortOrder: 0 },
    ])).rejects.toThrow("injected preset boom");

    expect((await store.listAll()).map((p) => p.name)).toEqual(["A", "B", "C"]);
  });
});

// ─── CharacterAssetStore ─────────────────────────────────────────────────────

describe("CharacterAssetStore synchronous reorder rollback (ASYNC_TRANSACTION_AUDIT step 6)", () => {
  test("reorder preserves the prior complete order when a mid-reorder update fails", async () => {
    const db = await createDb(":memory:");
    bootstrapCharacter(db);
    const store = new CharacterAssetStore(db, { clock: tickClock, idGenerator: idGen });
    const a = await store.create({ characterId: "char_1", ext: "png", mimeType: "image/png", order: 0 });
    const b = await store.create({ characterId: "char_1", ext: "jpg", mimeType: "image/jpeg", order: 1 });
    const c = await store.create({ characterId: "char_1", ext: "webp", mimeType: "image/webp", order: 2 });
    expect((await store.listByCharacter("char_1")).map((x) => x.id)).toEqual([a.id, b.id, c.id]);

    db.run(sql`CREATE TRIGGER fail_asset_c BEFORE UPDATE ON character_assets WHEN NEW.id = '${sql.raw(c.id)}' BEGIN SELECT RAISE(ABORT, 'injected asset boom'); END`);

    await expect(store.reorder("char_1", [c.id, b.id, a.id])).rejects.toThrow("injected asset boom");

    // Prior order intact — a/b updates rolled back with the failed c update.
    expect((await store.listByCharacter("char_1")).map((x) => x.id)).toEqual([a.id, b.id, c.id]);
  });
});

// ─── ChatSummaryStore ────────────────────────────────────────────────────────

describe("ChatSummaryStore synchronous reorder rollback (ASYNC_TRANSACTION_AUDIT step 6)", () => {
  test("reorder preserves the prior complete order when a mid-reorder update fails", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "vt-sum-reorder-"));
    const db = await createDb(join(dataRoot, "test.db"));
    bootstrapCharacter(db);
    const content = new ContentStore({ fileStore: createFileStore(dataRoot) });
    const chatStore = new ChatStore(db, { clock: tickClock, idGenerator: idGen });
    const summaryStore = new ChatSummaryStore(db, { clock: tickClock, idGenerator: idGen, content });

    const chat = await chatStore.createChat({ characterId: "char_1", title: "T", promptPresetId: null });
    const branchId = chat.activeBranchId;
    const a = await summaryStore.create({ chatId: chat.id, branchId, summarizedFrom: 0, summarizedTo: 1, sortOrder: 0, label: "A" });
    const b = await summaryStore.create({ chatId: chat.id, branchId, summarizedFrom: 2, summarizedTo: 3, sortOrder: 1, label: "B" });
    const c = await summaryStore.create({ chatId: chat.id, branchId, summarizedFrom: 4, summarizedTo: 5, sortOrder: 2, label: "C" });
    expect((await summaryStore.listByChatBranch(chat.id, branchId)).map((s) => s.label)).toEqual(["A", "B", "C"]);

    db.run(sql`CREATE TRIGGER fail_sum_c BEFORE UPDATE ON chat_summaries WHEN NEW.id = '${sql.raw(c.id)}' BEGIN SELECT RAISE(ABORT, 'injected summary boom'); END`);

    await expect(summaryStore.reorder(chat.id, branchId, [c.id, b.id, a.id])).rejects.toThrow("injected summary boom");

    expect((await summaryStore.listByChatBranch(chat.id, branchId)).map((s) => s.label)).toEqual(["A", "B", "C"]);
  });
});
