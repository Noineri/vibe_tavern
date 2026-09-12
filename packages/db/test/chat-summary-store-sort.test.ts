import { describe, test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb, type AppDb } from "../src/db-connection.js";
import * as schema from "../src/db-schema.js";
import { ContentStore } from "../src/content-store.js";
import { createFileStore } from "../src/file-store.js";
import { ChatStore } from "../src/stores/chat-store.js";
import { ChatSummaryStore } from "../src/stores/chat-summary-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

// SUM-3a: sortOrder auto-increments past the branch max on create, so a new
// summary lands at the END of the list instead of wedging between existing
// entries (ordering is asc(sortOrder), asc(summarizedFrom), asc(createdAt)).
// The old `?? 0` default put every new full-range draft (summarizedFrom: 1)
// between an existing from=1 summary and the next from>1 one.

const FIXED_NOW = "2026-07-23T00:00:00.000Z";
let n = 0;
const tickClock: StoreClock = {
  now() {
    return new Date(Date.parse(FIXED_NOW) + ++n * 1000).toISOString();
  },
};
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_sum3a_${++n}` };

function bootstrapCharacter(db: AppDb) {
  db.insert(schema.characters).values({
    id: "char_1", name: "TestChar", description: "", firstMessage: "hi",
    alternateGreetingsJson: "[]", extensionsJson: "{}", tagsJson: "[]",
    status: "active", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).run();
}

async function makeStore(): Promise<{
  db: AppDb;
  summaryStore: ChatSummaryStore;
  chatStore: ChatStore;
}> {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-sum3a-"));
  const db: AppDb = await createDb(join(dataRoot, "test.db"));
  bootstrapCharacter(db);
  const content = new ContentStore({ fileStore: createFileStore(dataRoot) });
  return {
    db,
    chatStore: new ChatStore(db, { clock: tickClock, idGenerator: idGen }),
    summaryStore: new ChatSummaryStore(db, { clock: tickClock, idGenerator: idGen, content }),
  };
}

describe("ChatSummaryStore.create sortOrder auto-increment (SUM-3)", () => {
  test("unset sortOrder lands new summaries after the branch max (0, 1, 2)", async () => {
    const { summaryStore, chatStore } = await makeStore();
    const chat = await chatStore.createChat({ characterId: "char_1", title: "T", promptPresetId: null });
    const branchId = chat.activeBranchId;

    const a = await summaryStore.create({ chatId: chat.id, branchId, summarizedFrom: 1, summarizedTo: 50 });
    const b = await summaryStore.create({ chatId: chat.id, branchId, summarizedFrom: 51, summarizedTo: 100 });
    // The user's exact wedge: a new full-range draft created LAST must not
    // sort between the two ranged summaries.
    const c = await summaryStore.create({ chatId: chat.id, branchId, summarizedFrom: 1, summarizedTo: 276 });

    expect(a.sortOrder).toBe(0);
    expect(b.sortOrder).toBe(1);
    expect(c.sortOrder).toBe(2);

    const list = await summaryStore.listByChatBranch(chat.id, branchId);
    expect(list.map((s) => s.id)).toEqual([a.id, b.id, c.id]);
  });

  test("an explicit sortOrder is honored verbatim; the next unset create continues from the MAX", async () => {
    const { summaryStore, chatStore } = await makeStore();
    const chat = await chatStore.createChat({ characterId: "char_1", title: "T", promptPresetId: null });
    const branchId = chat.activeBranchId;

    const a = await summaryStore.create({ chatId: chat.id, branchId, summarizedFrom: 1, summarizedTo: 10 });
    const pinned = await summaryStore.create({ chatId: chat.id, branchId, summarizedFrom: 11, summarizedTo: 20, sortOrder: 42 });
    const next = await summaryStore.create({ chatId: chat.id, branchId, summarizedFrom: 21, summarizedTo: 30 });

    expect(pinned.sortOrder).toBe(42);
    expect(next.sortOrder).toBe(43);
    expect(a.sortOrder).toBe(0);
  });

  test("branches are independent — the other branch's max does not leak", async () => {
    const { db, summaryStore, chatStore } = await makeStore();
    const chat = await chatStore.createChat({ characterId: "char_1", title: "T", promptPresetId: null });
    const other = await chatStore.createChat({ characterId: "char_1", title: "T2", promptPresetId: null });
    // A second branch on the same chat, inserted directly (fork-free fixture).
    const secondBranchId = `brnch_sum3a_${++n}`;
    db.insert(schema.chatBranches).values({
      id: secondBranchId,
      chatId: chat.id,
      label: "Second",
      createdAt: FIXED_NOW,
    }).run();

    await summaryStore.create({ chatId: chat.id, branchId: chat.activeBranchId, summarizedFrom: 1, summarizedTo: 10 });
    await summaryStore.create({ chatId: chat.id, branchId: chat.activeBranchId, summarizedFrom: 11, summarizedTo: 20 });

    const otherBranch = await summaryStore.create({ chatId: chat.id, branchId: secondBranchId, summarizedFrom: 1, summarizedTo: 10 });
    const otherChat = await summaryStore.create({ chatId: other.id, branchId: other.activeBranchId, summarizedFrom: 1, summarizedTo: 10 });

    expect(otherBranch.sortOrder).toBe(0);
    expect(otherChat.sortOrder).toBe(0);
  });
});
