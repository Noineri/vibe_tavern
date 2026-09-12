// Characterization of `LorebookStore.listAllActiveForChat` — the prompt-resolver
// read path (prompt-resolver.ts:97 calls exactly this). Pinned after the
// FK ∪ junction fix: an entity-FK-scoped lorebook created the normal
// way (createLorebook, which does NOT mirror the FK into lorebook_links) MUST
// activate in a chat for its owner. Before the fix this was a silent gap — the
// lorebook was visible in editor tabs (listLorebooksByScope is FK ∪ junction)
// but dropped by the chat resolver (was junction-only).
//
// Scope taxonomy collapse 4 → 3: 'character' and 'persona' merged into
// 'entity' — the home FK is whichever owner column is set, so one entity
// branch covers both homes, and a book M:N-bound to BOTH a character and a
// persona (home FK + junction) activates for a chat matching either target.
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

describe("LorebookStore.listAllActiveForChat (entity FK ∪ junction)", () => {
  test("entity-FK persona home activates in its chat (the fixed gap)", async () => {
    const { store } = await setup();
    const lb = await store.createLorebook({ name: "persona-owned", scopeType: "entity", personaId: "persona_X" });
    // No junction row created — createLorebook does not mirror FK into links.
    expect((await store.getLinks(lb.id)).length).toBe(0);

    const active = await store.listAllActiveForChat("char_X", "persona_X", "chat_X");
    expect(active.some((a) => a.lorebook.id === lb.id)).toBe(true);
  });

  test("entity-FK character home activates in its chat", async () => {
    const { store } = await setup();
    const lb = await store.createLorebook({ name: "char-owned", scopeType: "entity", characterId: "char_X" });
    expect((await store.getLinks(lb.id)).length).toBe(0);

    const active = await store.listAllActiveForChat("char_X", null, "chat_X");
    expect(active.some((a) => a.lorebook.id === lb.id)).toBe(true);
  });

  test("entity persona home does NOT activate for a chat without that persona", async () => {
    const { store } = await setup();
    await store.createLorebook({ name: "persona-home", scopeType: "entity", personaId: "persona_X" });
    // Same chat, but the persona column does not match — FK home must not fire.
    const active = await store.listAllActiveForChat("char_X", null, "chat_X");
    expect(active.some((a) => a.lorebook.name === "persona-home")).toBe(false);
  });

  test("a book M:N-bound to BOTH a character and a persona activates for a chat matching either target", async () => {
    const { store } = await setup();
    // Home FK = character; junction link = persona (the cross-binding picker).
    const viaLink = await store.createLorebook({ name: "both-link", scopeType: "entity", characterId: "char_X" });
    await store.addLink(viaLink.id, "persona", "persona_X");
    const charChat = await store.listAllActiveForChat("char_X", null, "chat_X");
    expect(charChat.some((a) => a.lorebook.id === viaLink.id)).toBe(true);
    const personaChat = await store.listAllActiveForChat("char_Y", "persona_X", "chat_Y");
    expect(personaChat.some((a) => a.lorebook.id === viaLink.id)).toBe(true);
    // Neither binding is lost — the junction row survives alongside the FK.
    expect((await store.getLinks(viaLink.id)).map((l) => `${l.targetType}:${l.targetId}`)).toEqual(["persona:persona_X"]);

    // Mirror: home FK = persona; junction link = character.
    const viaFk = await store.createLorebook({ name: "both-fk", scopeType: "entity", personaId: "persona_X" });
    await store.addLink(viaFk.id, "character", "char_X");
    expect((await store.listAllActiveForChat("char_X", "persona_X", "chat_X")).some((a) => a.lorebook.id === viaFk.id)).toBe(true);
    expect((await store.listAllActiveForChat("char_Y", "persona_X", "chat_Y")).some((a) => a.lorebook.id === viaFk.id)).toBe(true);
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
    // Entity persona-FK AND persona-junction-linked simultaneously — must appear once.
    const lb = await store.createLorebook({ name: "dual", scopeType: "entity", personaId: "persona_X" });
    await store.addLink(lb.id, "persona", "persona_X");
    const active = await store.listAllActiveForChat("char_X", "persona_X", "chat_X");
    const hits = active.filter((a) => a.lorebook.id === lb.id);
    expect(hits.length).toBe(1);
  });

  test("entity-FK lorebook of a DIFFERENT persona does not leak", async () => {
    const { store } = await setup();
    await store.createLorebook({ name: "other-persona", scopeType: "entity", personaId: "persona_X" });
    // Query as persona_Y — must not activate.
    const active = await store.listAllActiveForChat("char_X", "persona_Y", "chat_X");
    expect(active.some((a) => a.lorebook.name === "other-persona")).toBe(false);
  });

  test("disabled lorebook never activates", async () => {
    const { store } = await setup();
    const lb = await store.createLorebook({ name: "off", scopeType: "entity", personaId: "persona_X", enabled: false });
    const active = await store.listAllActiveForChat("char_X", "persona_X", "chat_X");
    expect(active.some((a) => a.lorebook.id === lb.id)).toBe(false);
  });

  test("listLorebooksByScope entity branch unions the typed FK home with junction links of EITHER target type", async () => {
    const { store } = await setup();
    const fkOwned = await store.createLorebook({ name: "fk", scopeType: "entity", characterId: "char_X" });
    const linkedChar = await store.createLorebook({ name: "linked-char", scopeType: "global" });
    await store.addLink(linkedChar.id, "character", "char_X");
    const linkedPersona = await store.createLorebook({ name: "linked-persona", scopeType: "global" });
    await store.addLink(linkedPersona.id, "persona", "char_X");
    const names = (await store.listLorebooksByScope("entity", "char_X")).map((l) => l.name);
    expect(names).toContain("fk");
    expect(names).toContain("linked-char");
    expect(names).toContain("linked-persona");
    // Persona view of the same owner id must not leak the character-FK home…
    const personaView = (await store.listLorebooksByScope("entity", "char_Y")).map((l) => l.name);
    expect(personaView).not.toContain("fk");
  });
});
