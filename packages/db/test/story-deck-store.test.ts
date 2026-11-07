import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { StoryDeck } from "@vibe-tavern/domain";
import { createDb } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";
import { StoryDeckStore } from "../src/stores/story-deck-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// DIRECTOR_DECK_CALENDAR_PLAN DK-3 — the per-branch story deck store. Mirrors
// agent-plan-chat-owner.test.ts (SC-0h): the same character → chat → branches
// bootstrap (the owner columns carry real FKs, so the parent rows must exist
// and cascade deletes are testable) and the same advancing-clock/id fixtures.

const FIXED_NOW = "2026-11-07T00:00:00.000Z";
let clockBase = Date.parse(FIXED_NOW);
let clockStep = 0;
function makeClock(): StoreClock {
  return { now: () => new Date(clockBase + clockStep++ * 1_000).toISOString() };
}
let idCounter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_dk3_${++idCounter}` };

const PAIR = { chatId: "chat_1", branchId: "brnch_1" };
const OTHER_PAIR = { chatId: "chat_1", branchId: "brnch_2" };
const DECK: StoryDeck = {
  cards: [
    { id: "card_1", suit: "threat", title: "The door won't hold", body: "Something pushes back." },
    { id: "card_2", suit: "discovery", title: "A hidden ledger", body: "" },
  ],
};
const EMPTY_DECK: StoryDeck = { cards: [] };

/** character → chat → branches. createDb(":memory:") runs the real migrations,
 *  so story_branch_decks (migration 0137) is present. */
function bootstrap(db: Awaited<ReturnType<typeof createDb>>, chatId: string, branchIds: string[]) {
  db.insert(schema.characters).values({
    id: "char_1", name: "TestChar", description: "",
    alternateGreetingsJson: "[]", extensionsJson: "{}", tagsJson: "[]",
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
  db.insert(schema.chats).values({
    id: chatId, characterId: "char_1", personaId: null,
    activeBranchId: branchIds[0]!, promptPresetId: null,
    title: "Test chat", summary: "", messageHistoryLimit: 0,
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
  for (const [i, branchId] of branchIds.entries()) {
    db.insert(schema.chatBranches).values({
      id: branchId, chatId, parentBranchId: null,
      forkedFromMessageId: null, label: i === 0 ? "main" : "fork", createdAt: FIXED_NOW,
    }).run();
  }
}

async function setup(chatId = "chat_1", branchIds = ["brnch_1", "brnch_2"]) {
  clockStep = 0;
  const db = await createDb(":memory:");
  bootstrap(db, chatId, branchIds);
  const store = new StoryDeckStore(db, { clock: makeClock(), idGenerator: idGen });
  return { db, store };
}

describe("StoryDeckStore (DK-3)", () => {
  test("save/get round-trips a branch deck; no row reads null", async () => {
    const { store } = await setup();

    expect(await store.get(PAIR.chatId, PAIR.branchId)).toBeNull();
    await store.save(PAIR.chatId, PAIR.branchId, DECK);
    expect(await store.get(PAIR.chatId, PAIR.branchId)).toEqual(DECK);
  });

  test("pairs are isolated — the neighbor branch never collides", async () => {
    const { store } = await setup();
    await store.save(PAIR.chatId, PAIR.branchId, DECK);
    const otherDeck: StoryDeck = { cards: [{ ...DECK.cards[0]!, title: "Neighbor card" }] };
    await store.save(OTHER_PAIR.chatId, OTHER_PAIR.branchId, otherDeck);

    expect((await store.get(OTHER_PAIR.chatId, OTHER_PAIR.branchId))?.cards[0]?.title).toBe("Neighbor card");
    expect((await store.get(PAIR.chatId, PAIR.branchId))?.cards[0]?.title).toBe("The door won't hold");
  });

  test("upsert rewrites content, bumps updated_at, and keeps one row per pair", async () => {
    const { db, store } = await setup();
    await store.save(PAIR.chatId, PAIR.branchId, DECK);
    const before = await db
      .select()
      .from(schema.storyBranchDecks)
      .where(eq(schema.storyBranchDecks.branchId, "brnch_1"))
      .get();
    const replacement: StoryDeck = { cards: [{ ...DECK.cards[0]!, title: "Revised card" }] };

    await store.save(PAIR.chatId, PAIR.branchId, replacement);

    const rows = await db.select().from(schema.storyBranchDecks).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(before?.id);
    expect(rows[0]!.updatedAt > before!.updatedAt).toBe(true);
    expect(await store.get(PAIR.chatId, PAIR.branchId)).toEqual(replacement);
  });

  test("an EMPTY deck save keeps the row with empty content; GET reads the empty deck back", async () => {
    const { db, store } = await setup();

    await store.save(PAIR.chatId, PAIR.branchId, EMPTY_DECK);

    // Named representation (DK-3): the row is KEPT — no special empty case,
    // the plan store's convention. Only a missing row reads null.
    const rows = await db.select().from(schema.storyBranchDecks).all();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.contentJson)).toEqual({ cards: [] });
    expect(await store.get(PAIR.chatId, PAIR.branchId)).toEqual(EMPTY_DECK);
  });

  test("DB layer: the unique (chat_id, branch_id) index rejects a second row for a pair", async () => {
    const { db, store } = await setup();
    await store.save(PAIR.chatId, PAIR.branchId, DECK);

    expect(() => {
      db.insert(schema.storyBranchDecks).values({
        id: "story_deck_dup", chatId: "chat_1", branchId: "brnch_1",
        contentJson: JSON.stringify(DECK),
        createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
      }).run();
    }).toThrow();
  });

  test("deleting the branch cascades its deck — the neighbor branch's deck survives", async () => {
    const { db, store } = await setup();
    await store.save(PAIR.chatId, PAIR.branchId, DECK);
    await store.save(OTHER_PAIR.chatId, OTHER_PAIR.branchId, { cards: [{ ...DECK.cards[0]!, title: "Survivor" }] });

    db.delete(schema.chatBranches).where(eq(schema.chatBranches.id, "brnch_1")).run();

    expect(await store.get(PAIR.chatId, PAIR.branchId)).toBeNull();
    expect((await store.get(OTHER_PAIR.chatId, OTHER_PAIR.branchId))?.cards[0]?.title).toBe("Survivor");
    // The chat row itself survives a branch delete.
    expect(
      await db.select().from(schema.chats).where(eq(schema.chats.id, "chat_1")).all(),
    ).toHaveLength(1);
  });

  test("deleting the chat cascades every branch deck it owns", async () => {
    const { db, store } = await setup();
    await store.save(PAIR.chatId, PAIR.branchId, DECK);
    await store.save(OTHER_PAIR.chatId, OTHER_PAIR.branchId, DECK);

    db.delete(schema.chats).where(eq(schema.chats.id, "chat_1")).run();

    expect(await db.select().from(schema.storyBranchDecks).all()).toEqual([]);
    expect(await store.get(PAIR.chatId, PAIR.branchId)).toBeNull();
    expect(await store.get(OTHER_PAIR.chatId, OTHER_PAIR.branchId)).toBeNull();
  });

  test("returns null without throwing for malformed content_json", async () => {
    const { db, store } = await setup();
    await store.save(PAIR.chatId, PAIR.branchId, DECK);
    await db
      .update(schema.storyBranchDecks)
      .set({ contentJson: "not json" })
      .where(eq(schema.storyBranchDecks.branchId, "brnch_1"))
      .run();

    expect(await store.get(PAIR.chatId, PAIR.branchId)).toBeNull();
  });
});
