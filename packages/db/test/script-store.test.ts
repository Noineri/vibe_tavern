import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { createDb } from "../src/db-connection.js";
import { ContentStore } from "../src/content-store.js";
import { createFileStore, STORAGE_FOLDERS } from "../src/file-store.js";
import { ScriptStore } from "../src/stores/script-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

const fixedClock: StoreClock = { now: () => "2026-06-15T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

async function setup() {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-scriptstore-test-"));
	const db = await createDb(":memory:");
	const content = new ContentStore({ fileStore: createFileStore(dataRoot) });
	const store = new ScriptStore(db, { content, clock: fixedClock, idGenerator: idGen });
	// FK parents (scripts reference characters + personas; the chat FK is
	// exercised by the setScope chat transition).
	await db.run(sql`INSERT INTO characters (id, name, created_at, updated_at) VALUES ('char_1', 'C', '2026-01-01', '2026-01-01')`);
	await db.run(sql`INSERT INTO personas (id, name, description, default_for_new_chats, has_file_on_disk, created_at, updated_at) VALUES ('persona_9', 'P', '', 0, 0, '2026-01-01', '2026-01-01')`);
	await db.run(sql`INSERT INTO chats (id, character_id, active_branch_id, title, created_at, updated_at) VALUES ('chat_x', 'char_1', 'branch_x', 'T', '2026-01-01', '2026-01-01')`);
	return { store, db, content };
}

// Characterization of the prompt-resolution read path: sortOrder ordering and
// the source union. Migration 0107 (LORE_SCRIPT_OWNERS_AS_LINKS step 1) made
// links the ONLY owner source (the home-FK columns were copied into
// script_links and dropped), so the FK-home fixtures below were migrated with
// the data — each owner-bound script is now seeded with a link, and every
// participation assertion keeps its original meaning.
describe("ScriptStore.listAllEnabledForChat (FK-only baseline)", () => {
	test("resolves global + entity-FK (character home) + entity-FK (persona home) scripts, sorted by sortOrder", async () => {
		const { store } = await setup();
		// sortOrder deliberately out of creation order to prove the sort.
		const charA = await store.create({ name: "char-a", scopeType: "entity", sortOrder: 30, enabled: true });
		await store.addLink(charA.id, "character", "char_1");
		await store.create({ name: "glob", scopeType: "global", sortOrder: 10, enabled: true });
		const personaA = await store.create({ name: "persona-a", scopeType: "entity", sortOrder: 20, enabled: true });
		await store.addLink(personaA.id, "persona", "persona_9");

		const resolved = await store.listAllEnabledForChat("char_1", "persona_9", "chat_x");
		expect(resolved.map((s) => s.name)).toEqual(["glob", "persona-a", "char-a"]);
	});

	test("entity script homed to a persona is excluded when personaId is null", async () => {
		const { store } = await setup();
		const personaA = await store.create({ name: "persona-a", scopeType: "entity", enabled: true });
		await store.addLink(personaA.id, "persona", "persona_9");
		const resolved = await store.listAllEnabledForChat("char_1", null, "chat_x");
		expect(resolved.some((s) => s.name === "persona-a")).toBe(false);
	});

	test("a script homed to a different character is excluded", async () => {
		const { store } = await setup();
		const charOwned = await store.create({ name: "char-owned", scopeType: "entity", enabled: true });
		await store.addLink(charOwned.id, "character", "char_1");
		// Query as a different character — char_1's script must not leak in.
		const resolved = await store.listAllEnabledForChat("char_other", null, "chat_x");
		expect(resolved.some((s) => s.name === "char-owned")).toBe(false);
	});

	test("disabled scripts are never resolved", async () => {
		const { store } = await setup();
		await store.create({ name: "off", scopeType: "global", enabled: false });
		const resolved = await store.listAllEnabledForChat("char_1", null, "chat_x");
		expect(resolved.some((s) => s.name === "off")).toBe(false);
	});
});

// Junction (script_links) behavior — since migration 0107 the junction IS the
// owner layer (the home-FK columns are gone).
describe("ScriptStore link management (script_links junction)", () => {
	test("getLinks/setLinks/addLink/removeLink round-trip", async () => {
		const { store } = await setup();
		const s = await store.create({ name: "util", scopeType: "global" });

		expect(await store.getLinks(s.id)).toEqual([]);

		// setLinks replaces wholesale.
		await store.setLinks(s.id, [
			{ targetType: "character", targetId: "char_1" },
			{ targetType: "persona", targetId: "persona_9" },
		]);
		expect((await store.getLinks(s.id)).length).toBe(2);

		// addLink is idempotent (duplicate ignored, not thrown).
		await store.addLink(s.id, "character", "char_1");
		expect((await store.getLinks(s.id)).length).toBe(2);

		// removeLink takes one out.
		await store.removeLink(s.id, "persona", "persona_9");
		const remaining = await store.getLinks(s.id);
		expect(remaining.length).toBe(1);
		expect(remaining[0]).toEqual({ scriptId: s.id, targetType: "character", targetId: "char_1" });
	});

	test("listAllEnabledForChat resolves entity-linked AND globally-linked scripts alike", async () => {
		const { store } = await setup();
		// Entity script linked to char_1 (an owner binding).
		const entityLinked = await store.create({ name: "fk-owned", scopeType: "entity", enabled: true });
		await store.addLink(entityLinked.id, "character", "char_1");
		// Global script, junction-linked to char_1.
		const linked = await store.create({ name: "linked", scopeType: "global", enabled: true });
		await store.addLink(linked.id, "character", "char_1");

		const resolved = await store.listAllEnabledForChat("char_1", null, "chat_x");
		const names = resolved.map((s) => s.name);
		expect(names).toContain("fk-owned");
		expect(names).toContain("linked");
	});

	test("junction-linked script homed to a DIFFERENT character still resolves via link", async () => {
		const { store } = await setup();
		// Linked to char_1 and to persona_9 — the persona link must surface it in a persona chat.
		const s = await store.create({ name: "cross", scopeType: "entity", enabled: true });
		await store.addLink(s.id, "character", "char_1");
		await store.addLink(s.id, "persona", "persona_9");
		const resolved = await store.listAllEnabledForChat("char_other", "persona_9", "chat_x");
		expect(resolved.map((x) => x.name)).toContain("cross");
	});

	test("a disabled script does NOT resolve even if junction-linked", async () => {
		const { store } = await setup();
		const s = await store.create({ name: "off", scopeType: "global", enabled: false });
		await store.addLink(s.id, "character", "char_1");
		const resolved = await store.listAllEnabledForChat("char_1", null, "chat_x");
		expect(resolved.some((x) => x.name === "off")).toBe(false);
	});

	test("listByScope entity branch returns junction links of EITHER target type", async () => {
		const { store } = await setup();
		const fk = await store.create({ name: "fk", scopeType: "entity" });
		await store.addLink(fk.id, "character", "char_1");
		const linkedChar = await store.create({ name: "linked-char", scopeType: "global" });
		await store.addLink(linkedChar.id, "character", "char_1");
		const linkedPersona = await store.create({ name: "linked-persona", scopeType: "global" });
		await store.addLink(linkedPersona.id, "persona", "char_1");
		const names = (await store.listByScope("entity", "char_1")).map((s) => s.name);
		expect(names).toContain("fk");
		expect(names).toContain("linked-char");
		expect(names).toContain("linked-persona");
	});

	test("listByScope entity browse (no ownerId) lists every entity-home script regardless of owner kind", async () => {
		const { store } = await setup();
		// Browse semantics for the sidebar's Bound tab (mirrors LorebookStore):
		// no ownerId → every entity script, nothing else.
		await store.create({ name: "char-owned", scopeType: "entity" });
		await store.create({ name: "persona-owned", scopeType: "entity" });
		await store.create({ name: "global-one", scopeType: "global" });
		const names = (await store.listByScope("entity")).map((s) => s.name).sort();
		expect(names).toEqual(["char-owned", "persona-owned"]);
	});

	test("listScriptsLinkedToTarget is the reverse query (persona/character editor view)", async () => {
		const { store } = await setup();
		const a = await store.create({ name: "a", scopeType: "global" });
		const b = await store.create({ name: "b", scopeType: "global" });
		await store.addLink(a.id, "persona", "persona_9");
		await store.addLink(b.id, "character", "char_1"); // different target — must NOT appear
		const linked = await store.listScriptsLinkedToTarget("persona", "persona_9");
		expect(linked.map((s) => s.name)).toEqual(["a"]);
	});

	test("deleting a script cascades to its links", async () => {
		const { store } = await setup();
		const s = await store.create({ name: "doomed", scopeType: "global" });
		await store.addLink(s.id, "character", "char_1");
		expect((await store.getLinks(s.id)).length).toBe(1);
		await store.delete(s.id);
		// Reverse query no longer returns it.
		expect(await store.listScriptsLinkedToTarget("character", "char_1")).toEqual([]);
	});
});

describe("ScriptStore.setScope (PR-6, entity model)", () => {
	test("flipping to entity keeps the owner links untouched (no owner picker on the flip)", async () => {
		const { store } = await setup();
		const created = await store.create({ name: "S1", scopeType: "global" });
		await store.addLink(created.id, "character", "char_1");
		expect(created.scopeType).toBe("global");

		const flipped = await store.setScope(created.id, "entity", null);
		expect(flipped.scopeType).toBe("entity");
		// Since migration 0107 there is no owner FK to keep or clear — a scope
		// flip never touches links, so the owner binding survives the flip.
		expect(flipped.characterId).toBeNull();
		expect(flipped.personaId).toBeNull();
		// The entity branch of listByScope still lists it via the kept link.
		expect((await store.listByScope("entity", "char_1")).some((s) => s.id === created.id)).toBe(true);
	});

	test("reassigning to global leaves the chat FK empty and the links intact", async () => {
		const { store } = await setup();
		const created = await store.create({ name: "S2", scopeType: "entity" });
		await store.addLink(created.id, "persona", "persona_9");
		const globalized = await store.setScope(created.id, "global", null);
		expect(globalized.scopeType).toBe("global");
		expect(globalized.characterId).toBeNull();
		expect(globalized.personaId).toBeNull();
		expect(globalized.chatId).toBeNull();
		const globalScripts = await store.listByScope("global");
		expect(globalScripts.some((s) => s.id === created.id)).toBe(true);
		// Links survive the global flip — an owner-bound script stays bound
		// (same behavior as pre-0107 for linked scripts).
		expect((await store.getLinks(created.id)).length).toBe(1);
	});

	test("reassigning to chat sets the chat FK and keeps the links", async () => {
		const { store } = await setup();
		const created = await store.create({ name: "S3", scopeType: "entity" });
		await store.addLink(created.id, "character", "char_1");
		const moved = await store.setScope(created.id, "chat", "chat_x");
		expect(moved.scopeType).toBe("chat");
		expect(moved.characterId).toBeNull();
		expect(moved.chatId).toBe("chat_x");
		// Chat transitions keep the PR-6 chat guarantee; owner LINKS survive
		// (they always did — the pre-0107 home FK is gone, and a linked script
		// keeps participating through its link under any scope).
		expect((await store.listByScope("entity", "char_1")).some((s) => s.id === created.id)).toBe(true);
	});
});

// ─── DICE-B2: script_kind + creation-intent idempotency ─────────────────────
//
// Pins the new kind column (default prompt, persists dice), the server-
// idempotent creation key (duplicate intent returns the existing script), and
// the file-payload split (scriptKind IS canonical content; creationIntentId is
// operational and must NOT leak into the file). Migration 0018 adds both
// columns; every test below runs against a fresh DB created via createDb, so it
// also proves the migration applies cleanly.

describe("ScriptStore script_kind + creation intent (DICE-B2)", () => {
	test("defaults scriptKind to 'prompt' when omitted (legacy row behavior)", async () => {
		const { store } = await setup();
		const s = await store.create({ name: "legacy", scopeType: "global" });
		expect(s.scriptKind).toBe("prompt");
		expect(s.creationIntentId).toBeNull();
	});

	test("persists scriptKind 'dice' when set and round-trips it on read", async () => {
		const { store } = await setup();
		const s = await store.create({ name: "Fate", scopeType: "global", scriptKind: "dice" });
		expect(s.scriptKind).toBe("dice");
		const again = await store.getById(s.id);
		expect(again?.scriptKind).toBe("dice");
		expect(again?.creationIntentId).toBeNull();
	});

	test("a duplicate creationIntentId returns the EXISTING script (idempotent)", async () => {
		const { store } = await setup();
		const first = await store.create({ name: "Fate Die", scopeType: "global", scriptKind: "dice", creationIntentId: "intent_fate_1" });
		const second = await store.create({ name: "Fate Die (retry)", scopeType: "global", scriptKind: "dice", creationIntentId: "intent_fate_1" });
		// Same row — original identity preserved, not the retry's name.
		expect(second.id).toBe(first.id);
		expect(second.name).toBe("Fate Die");
		expect((await store.listAll()).length).toBe(1);
	});

	test("scripts WITHOUT a creationIntentId are not deduped (multiple distinct)", async () => {
		const { store } = await setup();
		const a = await store.create({ name: "a", scopeType: "global" });
		const b = await store.create({ name: "b", scopeType: "global" });
		expect(a.id).not.toBe(b.id);
		expect((await store.listAll()).length).toBe(2);
	});

	test("setScope preserves scriptKind and does not touch creationIntentId", async () => {
		const { store } = await setup();
		const s = await store.create({ name: "Fate", scopeType: "global", scriptKind: "dice", creationIntentId: "intent_1" });
		const moved = await store.setScope(s.id, "chat", "chat_x");
		expect(moved.scriptKind).toBe("dice");
		expect(moved.creationIntentId).toBe("intent_1");
	});
});

// ─── DICE-B2: kind-split resolvers ──────────────────────────────────────────
//
// The prompt resolver (listAllEnabledForChat) must exclude dice scripts, and
// the dice resolver (listAllEnabledDiceScriptsForChat) must exclude prompt
// scripts — at BOTH the FK and junction sources. Both keep the FK ∪ junction
// dedup/order. This is the runtime-isolation boundary: a dice script never
// enters prompt assembly.

describe("ScriptStore kind-split resolvers (DICE-B2)", () => {
	test("listAllEnabledForChat (prompt resolver) excludes dice scripts", async () => {
		const { store } = await setup();
		await store.create({ name: "prompt-glob", scopeType: "global", enabled: true, scriptKind: "prompt" });
		await store.create({ name: "dice-glob", scopeType: "global", enabled: true, scriptKind: "dice" });
		const names = (await store.listAllEnabledForChat("char_1", null, "chat_x")).map((s) => s.name);
		expect(names).toContain("prompt-glob");
		expect(names).not.toContain("dice-glob");
	});

	test("listAllEnabledDiceScriptsForChat excludes prompt scripts", async () => {
		const { store } = await setup();
		await store.create({ name: "prompt-glob", scopeType: "global", enabled: true, scriptKind: "prompt" });
		await store.create({ name: "dice-glob", scopeType: "global", enabled: true, scriptKind: "dice" });
		const names = (await store.listAllEnabledDiceScriptsForChat("char_1", null, "chat_x")).map((s) => s.name);
		expect(names).toContain("dice-glob");
		expect(names).not.toContain("prompt-glob");
	});

	test("a dice script junction-linked to a character resolves ONLY via the dice resolver", async () => {
		const { store } = await setup();
		const dice = await store.create({ name: "dice-linked", scopeType: "global", enabled: true, scriptKind: "dice" });
		await store.addLink(dice.id, "character", "char_1");
		const promptResolved = await store.listAllEnabledForChat("char_1", null, "chat_x");
		const diceResolved = await store.listAllEnabledDiceScriptsForChat("char_1", null, "chat_x");
		expect(promptResolved.some((s) => s.name === "dice-linked")).toBe(false);
		expect(diceResolved.some((s) => s.name === "dice-linked")).toBe(true);
	});

	test("the dice resolver preserves dedup/order across links (mirrors prompt path)", async () => {
		const { store } = await setup();
		const diceFk = await store.create({ name: "dice-fk", scopeType: "entity", enabled: true, scriptKind: "dice", sortOrder: 20 });
		await store.addLink(diceFk.id, "character", "char_1");
		const linked = await store.create({ name: "dice-linked", scopeType: "global", enabled: true, scriptKind: "dice", sortOrder: 10 });
		await store.addLink(linked.id, "character", "char_1");
		const names = (await store.listAllEnabledDiceScriptsForChat("char_1", null, "chat_x")).map((s) => s.name);
		// CRITICAL: both dice scripts appear, sorted by sortOrder — the same
		// shape as the prompt resolver.
		expect(names).toContain("dice-fk");
		expect(names).toContain("dice-linked");
		expect(names).toEqual(["dice-linked", "dice-fk"]);
	});

	test("a disabled dice script never resolves (enabled filter still applies)", async () => {
		const { store } = await setup();
		await store.create({ name: "off", scopeType: "global", enabled: false, scriptKind: "dice" });
		const resolved = await store.listAllEnabledDiceScriptsForChat("char_1", null, "chat_x");
		expect(resolved.some((s) => s.name === "off")).toBe(false);
	});
});

// ─── Chat-local Dice override resolver (fix 1) ─────────────────────────────
//
// listDiceScriptsByIds backs the chat-local override: an explicit id set
// replaces the inherited union for one chat. It must keep ONLY enabled dice
// rows, drop disabled / deleted / non-dice / duplicate ids silently, and order
// by sortOrder (deterministic, matching the inherit resolver — NOT the input
// array order).

describe("ScriptStore.listDiceScriptsByIds (chat-local override, fix 1)", () => {
	test("returns exactly the matching enabled dice scripts, ordered by sortOrder", async () => {
		const { store } = await setup();
		const a = await store.create({ name: "A", scopeType: "global", enabled: true, scriptKind: "dice", sortOrder: 30 });
		const b = await store.create({ name: "B", scopeType: "global", enabled: true, scriptKind: "dice", sortOrder: 10 });
		const c = await store.create({ name: "C", scopeType: "global", enabled: true, scriptKind: "dice", sortOrder: 20 });
		// Input order is [A, C, B]; output must be sorted by sortOrder → [B, C, A].
		const resolved = await store.listDiceScriptsByIds([a.id, c.id, b.id]);
		expect(resolved.map((s) => s.name)).toEqual(["B", "C", "A"]);
	});

	test("drops disabled, non-dice, and unknown ids silently", async () => {
		const { store } = await setup();
		const keep = await store.create({ name: "keep", scopeType: "global", enabled: true, scriptKind: "dice" });
		await store.create({ name: "disabled", scopeType: "global", enabled: false, scriptKind: "dice" });
		await store.create({ name: "prompt", scopeType: "global", enabled: true, scriptKind: "prompt" });
		const resolved = await store.listDiceScriptsByIds([keep.id, "disabled", "prompt", "does-not-exist"]);
		expect(resolved.map((s) => s.name)).toEqual(["keep"]);
	});

	test("deduplicates repeated ids and returns empty for an empty set", async () => {
		const { store } = await setup();
		const a = await store.create({ name: "A", scopeType: "global", enabled: true, scriptKind: "dice" });
		expect((await store.listDiceScriptsByIds([a.id, a.id, a.id])).map((s) => s.name)).toEqual(["A"]);
		expect(await store.listDiceScriptsByIds([])).toEqual([]);
	});
});

// ─── DICE-B2: file-payload parity ───────────────────────────────────────────
//
// scriptKind IS canonical content (it round-trips through the file so a re-
// import preserves the kind). creationIntentId is an operational idempotency
// key — it must NOT appear in the file payload (it is not mutable script
// content). This is the parity guard for the dual-write projection.

describe("ScriptStore file-payload parity (DICE-B2)", () => {
	test("scriptKind 'dice' is written to the canonical file payload", async () => {
		const { store, content } = await setup();
		const s = await store.create({ name: "Fate", scopeType: "global", scriptKind: "dice" });
		const payload = await content.readEntity(STORAGE_FOLDERS.scripts, s.id);
		expect(payload).not.toBeNull();
		expect((payload as Record<string, unknown>).scriptKind).toBe("dice");
	});

	test("creationIntentId is NOT written to the file payload (operational, not content)", async () => {
		const { store, content } = await setup();
		const s = await store.create({ name: "Fate", scopeType: "global", scriptKind: "dice", creationIntentId: "intent_1" });
		const payload = (await content.readEntity(STORAGE_FOLDERS.scripts, s.id)) as Record<string, unknown>;
		expect("creationIntentId" in payload).toBe(false);
		expect(payload.scriptKind).toBe("dice");
	});

	test("a prompt script's file payload carries scriptKind: 'prompt'", async () => {
		const { store, content } = await setup();
		const s = await store.create({ name: "legacy", scopeType: "global" });
		const payload = (await content.readEntity(STORAGE_FOLDERS.scripts, s.id)) as Record<string, unknown>;
		expect(payload.scriptKind).toBe("prompt");
	});
});

describe("ScriptStore.defaultVisualId (experience default-visual soft link)", () => {
	test("create + read round-trips defaultVisualId (null by default, set when provided)", async () => {
		const { store } = await setup();
		const plain = await store.create({ name: "no-default", scopeType: "global" });
		expect(plain.defaultVisualId).toBeNull();

		const paired = await store.create({ name: "with-default", scopeType: "global", defaultVisualId: "vis_a" });
		expect(paired.defaultVisualId).toBe("vis_a");

		// listAll / getById also surface the field.
		const all = await store.listAll();
		expect(all.find((s) => s.id === paired.id)?.defaultVisualId).toBe("vis_a");
		const byId = await store.getById(paired.id);
		expect(byId?.defaultVisualId).toBe("vis_a");
	});

	test("update sets and clears defaultVisualId without touching other fields", async () => {
		const { store } = await setup();
		const s = await store.create({ name: "exp", scopeType: "global" });

		const set = await store.update(s.id, { defaultVisualId: "vis_b" });
		expect(set.defaultVisualId).toBe("vis_b");
		expect(set.name).toBe("exp");

		const cleared = await store.update(s.id, { defaultVisualId: null });
		expect(cleared.defaultVisualId).toBeNull();
	});
});
