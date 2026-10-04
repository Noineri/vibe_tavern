// Characterization of `LorebookStore.listAllActiveForChat` — the prompt-resolver
// read path (prompt-resolver.ts:97 calls exactly this).
//
// History: this file pinned the FK ∪ junction fix (2026-06-29) — an entity-FK
// lorebook created the normal way (createLorebook did NOT mirror the FK into
// lorebook_links) had to activate in its owner's chat. Migration 0107
// (LORE_SCRIPT_OWNERS_AS_LINKS step 1) removed the home-owner FK columns
// entirely: every owner IS a `lorebook_links` row now, and the fixtures below
// were migrated with the data exactly like the migration does (home → link).
// Every PARTICIPATION assertion keeps its original meaning; the "no junction
// row created" assertions died with the FK (a created book with no link is
// simply unbound — pinned by the link-only exclusion tests at the bottom).
//
// Scope taxonomy collapse 4 → 3: 'character' and 'persona' merged into
// 'entity' — owners are link rows (character or persona target), and a book
// M:N-bound to BOTH a character and a persona activates for a chat matching
// either target.
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
  await db.run(sql`INSERT INTO characters (id, name, created_at, updated_at) VALUES ('char_Y', 'CY', '2026-01-01', '2026-01-01')`);
  await db.run(sql`INSERT INTO chats (id, character_id, active_branch_id, title, created_at, updated_at) VALUES ('chat_X', 'char_X', 'branch_X', 'T', '2026-01-01', '2026-01-01')`);
  await db.run(sql`INSERT INTO chats (id, character_id, active_branch_id, title, created_at, updated_at) VALUES ('chat_Y', 'char_Y', 'branch_Y', 'T', '2026-01-01', '2026-01-01')`);
  return { store };
}

describe("LorebookStore.listAllActiveForChat (owners are links)", () => {
  test("a persona-linked lorebook activates in its chat (the originally-fixed gap)", async () => {
    const { store } = await setup();
    const lb = await store.createLorebook({ name: "persona-owned", scopeType: "entity" });
    await store.addLink(lb.id, "persona", "persona_X");

    const active = await store.listAllActiveForChat("char_X", "persona_X", "chat_X");
    expect(active.some((a) => a.lorebook.id === lb.id)).toBe(true);
  });

  test("a character-linked lorebook activates in its chat", async () => {
    const { store } = await setup();
    const lb = await store.createLorebook({ name: "char-owned", scopeType: "entity" });
    await store.addLink(lb.id, "character", "char_X");

    const active = await store.listAllActiveForChat("char_X", null, "chat_X");
    expect(active.some((a) => a.lorebook.id === lb.id)).toBe(true);
  });

  test("a persona-linked book does NOT activate for a chat without that persona", async () => {
    const { store } = await setup();
    const lb = await store.createLorebook({ name: "persona-home", scopeType: "entity" });
    await store.addLink(lb.id, "persona", "persona_X");
    // Same chat, but the persona column does not match — the link must not fire.
    const active = await store.listAllActiveForChat("char_X", null, "chat_X");
    expect(active.some((a) => a.lorebook.name === "persona-home")).toBe(false);
  });

  test("an unlinked entity book activates nowhere (links are the only owner source)", async () => {
    const { store } = await setup();
    // Since 0107 there is no hidden home owner: a book with no link rows is
    // bound to nobody. (Was: createLorebook({characterId}) wrote an invisible
    // home that fired in the owner's chats.)
    await store.createLorebook({ name: "orphan", scopeType: "entity", characterId: "char_X" });
    expect((await store.listAllActiveForChat("char_X", null, "chat_X")).some((a) => a.lorebook.name === "orphan")).toBe(false);
    expect((await store.listAllActiveForChat("char_Y", null, "chat_Y")).some((a) => a.lorebook.name === "orphan")).toBe(false);
  });

  test("a book M:N-bound to BOTH a character and a persona activates for a chat matching either target", async () => {
    const { store } = await setup();
    // Character link + persona link (the cross-binding picker).
    const viaLink = await store.createLorebook({ name: "both-link", scopeType: "entity" });
    await store.addLink(viaLink.id, "character", "char_X");
    await store.addLink(viaLink.id, "persona", "persona_X");
    const charChat = await store.listAllActiveForChat("char_X", null, "chat_X");
    expect(charChat.some((a) => a.lorebook.id === viaLink.id)).toBe(true);
    const personaChat = await store.listAllActiveForChat("char_Y", "persona_X", "chat_Y");
    expect(personaChat.some((a) => a.lorebook.id === viaLink.id)).toBe(true);
    // Neither binding is lost — both link rows survive side by side.
    expect((await store.getLinks(viaLink.id)).map((l) => `${l.targetType}:${l.targetId}`).sort()).toEqual(["character:char_X", "persona:persona_X"]);
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

  test("double-bound (two links to the same persona) does not double-activate (Set dedup by id)", async () => {
    const { store } = await setup();
    // One persona link twice would violate the composite PK — pin the dedup
    // with persona + character links both matching the same chat instead.
    const lb = await store.createLorebook({ name: "dual", scopeType: "entity" });
    await store.addLink(lb.id, "persona", "persona_X");
    await store.addLink(lb.id, "character", "char_X");
    const active = await store.listAllActiveForChat("char_X", "persona_X", "chat_X");
    const hits = active.filter((a) => a.lorebook.id === lb.id);
    expect(hits.length).toBe(1);
  });

  test("a lorebook linked to a DIFFERENT persona does not leak", async () => {
    const { store } = await setup();
    const lb = await store.createLorebook({ name: "other-persona", scopeType: "entity" });
    await store.addLink(lb.id, "persona", "persona_X");
    // Query as persona_Y — must not activate.
    const active = await store.listAllActiveForChat("char_X", "persona_Y", "chat_X");
    expect(active.some((a) => a.lorebook.name === "other-persona")).toBe(false);
  });

  test("disabled lorebook never activates", async () => {
    const { store } = await setup();
    const lb = await store.createLorebook({ name: "off", scopeType: "entity", enabled: false });
    await store.addLink(lb.id, "persona", "persona_X");
    const active = await store.listAllActiveForChat("char_X", "persona_X", "chat_X");
    expect(active.some((a) => a.lorebook.id === lb.id)).toBe(false);
  });

  test("listLorebooksByScope entity branch is links-only (either target type)", async () => {
    const { store } = await setup();
    const owned = await store.createLorebook({ name: "linked-owned", scopeType: "entity" });
    await store.addLink(owned.id, "character", "char_X");
    const linkedChar = await store.createLorebook({ name: "linked-char", scopeType: "global" });
    await store.addLink(linkedChar.id, "character", "char_X");
    const linkedPersona = await store.createLorebook({ name: "linked-persona", scopeType: "global" });
    await store.addLink(linkedPersona.id, "persona", "char_X");
    const names = (await store.listLorebooksByScope("entity", "char_X")).map((l) => l.name);
    expect(names).toContain("linked-owned");
    expect(names).toContain("linked-char");
    expect(names).toContain("linked-persona");
    // An owner with no links sees nothing.
    const strangerView = (await store.listLorebooksByScope("entity", "char_Z")).map((l) => l.name);
    expect(strangerView).not.toContain("linked-owned");
  });
});
