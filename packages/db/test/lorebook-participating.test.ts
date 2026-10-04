// Characterization of `LorebookStore.listParticipatingForChat` — the «Текущие»
// backend query (LOREBOOK_LIST_FILTERS_REPORT step 2). Same fixture shape as
// lorebook-fk-activation.test.ts (the pipeline read's characterization): the
// participation BINDING rules are the same one source
// (`lorebook-chat-resolution.ts`); only the enabled POLICY differs —
// attached-list semantics per the owner's 2026-10-03 ruling:
//   character/persona/chat-bound books are included even while disabled (the
//   toggle is how the author turns them on); books participating only through
//   the global pool are included only while enabled.
// The pipeline-parity test pins the policy split on the same rows:
// `listAllActiveForChat` (activation semantics) keeps excluding the disabled
// bound books.
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { createDb } from "../src/db-connection.js";
import { LorebookStore } from "../src/stores/lorebook-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

const clock: StoreClock = { now: () => "2026-10-03T00:00:00.000Z" };
let n = 0;
const idGen: StoreIdGenerator = { next: (p) => `${p}_part_${++n}` };

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "vt-lore-part-"));
  const db = await createDb(join(dir, "test.db"));
  const store = new LorebookStore(db, { clock, idGenerator: idGen, content: null });
  await db.run(sql`INSERT INTO personas (id, name, description, default_for_new_chats, has_file_on_disk, created_at, updated_at) VALUES ('persona_X', 'P', '', 0, 0, '2026-01-01', '2026-01-01')`);
  await db.run(sql`INSERT INTO personas (id, name, description, default_for_new_chats, has_file_on_disk, created_at, updated_at) VALUES ('persona_Y', 'PY', '', 0, 0, '2026-01-01', '2026-01-01')`);
  await db.run(sql`INSERT INTO characters (id, name, created_at, updated_at) VALUES ('char_X', 'C', '2026-01-01', '2026-01-01')`);
  await db.run(sql`INSERT INTO characters (id, name, created_at, updated_at) VALUES ('char_Y', 'CY', '2026-01-01', '2026-01-01')`);
  await db.run(sql`INSERT INTO chats (id, character_id, active_branch_id, title, created_at, updated_at) VALUES ('chat_X', 'char_X', 'branch_X', 'T', '2026-01-01', '2026-01-01')`);
  await db.run(sql`INSERT INTO chats (id, character_id, active_branch_id, title, created_at, updated_at) VALUES ('chat_Y', 'char_Y', 'branch_Y', 'TY', '2026-01-01', '2026-01-01')`);
  return { store };
}

const names = (books: Array<{ name: string }>) => books.map((b) => b.name);

describe("LorebookStore.listParticipatingForChat («Текущие»)", () => {
  test("character + persona + chat + enabled global books are all included", async () => {
    const { store } = await setup();
    const charBook = await store.createLorebook({ name: "char-book", scopeType: "entity" });
    await store.addLink(charBook.id, "character", "char_X");
    const personaBook = await store.createLorebook({ name: "persona-book", scopeType: "entity" });
    await store.addLink(personaBook.id, "persona", "persona_X");
    await store.createLorebook({ name: "chat-book", scopeType: "chat", chatId: "chat_X" });
    await store.createLorebook({ name: "global-on", scopeType: "global" });

    const participating = names(await store.listParticipatingForChat("char_X", "persona_X", "chat_X"));
    expect(participating).toContain("char-book");
    expect(participating).toContain("persona-book");
    expect(participating).toContain("chat-book");
    expect(participating).toContain("global-on");
  });

  test("disabled global book is excluded (participates only through the global pool)", async () => {
    const { store } = await setup();
    await store.createLorebook({ name: "global-off", scopeType: "global", enabled: false });

    const participating = names(await store.listParticipatingForChat("char_X", "persona_X", "chat_X"));
    expect(participating).not.toContain("global-off");
  });

  test("disabled character / persona / chat books are included (attached — the toggle turns them on)", async () => {
    const { store } = await setup();
    const charOff = await store.createLorebook({ name: "char-off", scopeType: "entity", enabled: false });
    await store.addLink(charOff.id, "character", "char_X");
    const personaOff = await store.createLorebook({ name: "persona-off", scopeType: "entity", enabled: false });
    await store.addLink(personaOff.id, "persona", "persona_X");
    await store.createLorebook({ name: "chat-off", scopeType: "chat", chatId: "chat_X", enabled: false });

    const participating = names(await store.listParticipatingForChat("char_X", "persona_X", "chat_X"));
    expect(participating).toContain("char-off");
    expect(participating).toContain("persona-off");
    expect(participating).toContain("chat-off");
  });

  test("other characters' and other personas' books are excluded", async () => {
    const { store } = await setup();
    const otherChar = await store.createLorebook({ name: "other-char", scopeType: "entity" });
    await store.addLink(otherChar.id, "character", "char_Y");
    const otherPersona = await store.createLorebook({ name: "other-persona", scopeType: "entity" });
    await store.addLink(otherPersona.id, "persona", "persona_Y");
    await store.createLorebook({ name: "other-chat", scopeType: "chat", chatId: "chat_Y" });

    const participating = names(await store.listParticipatingForChat("char_X", "persona_X", "chat_X"));
    expect(participating).not.toContain("other-char");
    expect(participating).not.toContain("other-persona");
    expect(participating).not.toContain("other-chat");
  });

  test("links are honored: a book homed elsewhere but linked to this chat's owner participates", async () => {
    const { store } = await setup();
    // Owned by char_Y, additionally linked to the chat's persona → participates.
    const crossLinked = await store.createLorebook({ name: "cross-linked", scopeType: "entity" });
    await store.addLink(crossLinked.id, "character", "char_Y");
    await store.addLink(crossLinked.id, "persona", "persona_X");
    // Global book linked to the chat's character → participates through the
    // character binding even while disabled (most specific binding wins).
    const linkedGlobalOff = await store.createLorebook({ name: "linked-global-off", scopeType: "global", enabled: false });
    await store.addLink(linkedGlobalOff.id, "character", "char_X");
    // Multi-binding: linked to char_X AND persona_X — one row, both targets.
    const multiBound = await store.createLorebook({ name: "multi-bound", scopeType: "entity" });
    await store.addLink(multiBound.id, "character", "char_X");
    await store.addLink(multiBound.id, "persona", "persona_X");

    const participating = names(await store.listParticipatingForChat("char_X", "persona_X", "chat_X"));
    expect(participating).toContain("cross-linked");
    expect(participating).toContain("linked-global-off");
    expect(participating.filter((name) => name === "multi-bound")).toHaveLength(1);
    // The same link does NOT leak the book into an unrelated chat.
    const otherChat = names(await store.listParticipatingForChat("char_Z", "persona_Y", "chat_Z"));
    expect(otherChat).not.toContain("cross-linked");
  });

  test("pipeline parity: the same disabled bound books stay excluded from the activation read", async () => {
    const { store } = await setup();
    const charOff = await store.createLorebook({ name: "char-off", scopeType: "entity", enabled: false });
    await store.addLink(charOff.id, "character", "char_X");
    const personaOff = await store.createLorebook({ name: "persona-off", scopeType: "entity", enabled: false });
    await store.addLink(personaOff.id, "persona", "persona_X");
    await store.createLorebook({ name: "chat-off", scopeType: "chat", chatId: "chat_X", enabled: false });
    await store.createLorebook({ name: "global-off", scopeType: "global", enabled: false });
    const charOn = await store.createLorebook({ name: "char-on", scopeType: "entity" });
    await store.addLink(charOn.id, "character", "char_X");

    const active = names((await store.listAllActiveForChat("char_X", "persona_X", "chat_X")).map((s) => s.lorebook));
    expect(active).toEqual(["char-on"]);
  });
});
