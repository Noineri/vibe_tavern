// Characterization of `LorebookStore.listAllActiveForChat` — the prompt-resolver
// read path (prompt-resolver.ts:97 calls exactly this). Pinned after the
// FK ∪ junction fix: a persona/character-FK-scoped lorebook created the normal
// way (createLorebook, which does NOT mirror the FK into lorebook_links) MUST
// activate in a chat for its owner. Before the fix this was a silent gap — the
// lorebook was visible in editor tabs (listLorebooksByScope is FK ∪ junction)
// but dropped by the chat resolver (was junction-only).
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { createDb } from "../src/db-connection.js";
import { LorebookStore } from "../src/stores/lorebook-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

const clock: StoreClock = { now: () => "2026-06-27T00:00:00.000Z" };
let n = 0;
const idGen: StoreIdGenerator = { next: (p) => `${p}_fkfix_${++n}` };

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "vt-lore-fkfix-"));
  const db = await createDb(join(dir, "test.db"));
  const store = new LorebookStore(db, { clock, idGenerator: idGen, content: null });
  await db.run(sql`INSERT INTO personas (id, name, description, default_for_new_chats, has_file_on_disk, created_at, updated_at) VALUES ('persona_X', 'P', '', 0, 0, '2026-01-01', '2026-01-01')`);
  await db.run(sql`INSERT INTO characters (id, name, created_at, updated_at) VALUES ('char_X', 'C', '2026-01-01', '2026-01-01')`);
  // Minimal chat row (chats has NOT NULL columns + active_branch_id which is a
  // free text column here, not FK-enforced in this test fixture).
  await db.run(sql`INSERT INTO chats (id, character_id, active_branch_id, title, created_at, updated_at) VALUES ('chat_X', 'char_X', 'branch_X', 'T', '2026-01-01', '2026-01-01')`);
  return { store };
}

describe("LorebookStore.listAllActiveForChat (FK ∪ junction)", () => {
  test("persona-FK-owned lorebook activates in chat (the fixed gap)", async () => {
    const { store } = await setup();
    const lb = await store.createLorebook({ name: "persona-owned", scopeType: "persona", personaId: "persona_X" });
    // No junction row created — createLorebook does not mirror FK into links.
    expect((await store.getLinks(lb.id)).length).toBe(0);

    const active = await store.listAllActiveForChat("char_X", "persona_X", "chat_X");
    expect(active.some((a) => a.lorebook.id === lb.id)).toBe(true);
  });

  test("character-FK-owned lorebook activates in chat", async () => {
    const { store } = await setup();
    const lb = await store.createLorebook({ name: "char-owned", scopeType: "character", characterId: "char_X" });
    expect((await store.getLinks(lb.id)).length).toBe(0);

    const active = await store.listAllActiveForChat("char_X", null, "chat_X");
    expect(active.some((a) => a.lorebook.id === lb.id)).toBe(true);
  });

  test("global lorebook activates regardless of owner", async () => {
    const { store } = await setup();
    const lb = await store.createLorebook({ name: "global", scopeType: "global" });
    const active = await store.listAllActiveForChat("char_X", null, "chat_X");
    expect(active.some((a) => a.lorebook.id === lb.id)).toBe(true);
  });

  test("chat-FK-scoped lorebook activates in that chat", async () => {
    const { store } = await setup();
    const lb = await store.createLorebook({ name: "chat-owned", scopeType: "chat", chatId: "chat_X" });
    const active = await store.listAllActiveForChat("char_X", null, "chat_X");
    expect(active.some((a) => a.lorebook.id === lb.id)).toBe(true);
  });

  test("junction-linked global lorebook activates for the linked owner", async () => {
    const { store } = await setup();
    const lb = await store.createLorebook({ name: "linked", scopeType: "global" });
    await store.addLink(lb.id, "persona", "persona_X");
    const active = await store.listAllActiveForChat("char_X", "persona_X", "chat_X");
    expect(active.some((a) => a.lorebook.id === lb.id)).toBe(true);
  });

  test("FK ∪ junction does not double-activate (Set dedup by id)", async () => {
    const { store } = await setup();
    // Persona-FK AND persona-junction-linked simultaneously — must appear once.
    const lb = await store.createLorebook({ name: "dual", scopeType: "persona", personaId: "persona_X" });
    await store.addLink(lb.id, "persona", "persona_X");
    const active = await store.listAllActiveForChat("char_X", "persona_X", "chat_X");
    const hits = active.filter((a) => a.lorebook.id === lb.id);
    expect(hits.length).toBe(1);
  });

  test("FK-owned lorebook of a DIFFERENT persona does not leak", async () => {
    const { store } = await setup();
    await store.createLorebook({ name: "other-persona", scopeType: "persona", personaId: "persona_X" });
    // Query as persona_Y — must not activate.
    const active = await store.listAllActiveForChat("char_X", "persona_Y", "chat_X");
    expect(active.some((a) => a.lorebook.name === "other-persona")).toBe(false);
  });

  test("disabled lorebook never activates", async () => {
    const { store } = await setup();
    const lb = await store.createLorebook({ name: "off", scopeType: "persona", personaId: "persona_X", enabled: false });
    const active = await store.listAllActiveForChat("char_X", "persona_X", "chat_X");
    expect(active.some((a) => a.lorebook.id === lb.id)).toBe(false);
  });
});
