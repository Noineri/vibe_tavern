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
	// FK parents (scripts reference characters + personas).
	await db.run(sql`INSERT INTO characters (id, name, created_at, updated_at) VALUES ('char_1', 'C', '2026-01-01', '2026-01-01')`);
	await db.run(sql`INSERT INTO personas (id, name, description, default_for_new_chats, has_file_on_disk, created_at, updated_at) VALUES ('persona_9', 'P', '', 0, 0, '2026-01-01', '2026-01-01')`);
	return { store, db, content };
}

// Characterization of the prompt-resolution read path. Pinned BEFORE the
// script_links junction rewrite (AGENTS.md §1): FK-only resolution +
// sortOrder ordering. Every assertion here MUST keep passing after the
// union (FK ∪ junction) rewrite — the junction only ADDS scripts, never
// removes FK-owned ones.
describe("ScriptStore.listAllEnabledForChat (FK-only baseline)", () => {
	test("resolves global + character-FK + persona-FK scripts, sorted by sortOrder", async () => {
		const { store } = await setup();
		// sortOrder deliberately out of creation order to prove the sort.
		await store.create({ name: "char-a", scopeType: "character", characterId: "char_1", sortOrder: 30, enabled: true });
		await store.create({ name: "glob", scopeType: "global", sortOrder: 10, enabled: true });
		await store.create({ name: "persona-a", scopeType: "persona", personaId: "persona_9", sortOrder: 20, enabled: true });

		const resolved = await store.listAllEnabledForChat("char_1", "persona_9", "chat_x");
		expect(resolved.map((s) => s.name)).toEqual(["glob", "persona-a", "char-a"]);
	});

	test("persona-FK script is excluded when personaId is null", async () => {
		const { store } = await setup();
		await store.create({ name: "persona-a", scopeType: "persona", personaId: "persona_9", enabled: true });
		const resolved = await store.listAllEnabledForChat("char_1", null, "chat_x");
		expect(resolved.some((s) => s.name === "persona-a")).toBe(false);
	});

	test("a script homed to a different character is excluded", async () => {
		const { store } = await setup();
		await store.create({ name: "char-owned", scopeType: "character", characterId: "char_1", enabled: true });
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

// Junction (script_links) behavior — the M:N layer added on top of the
// FK ownership. The resolver must consult BOTH FK and junction (unlike
// lorebooks, which are junction-only for char/persona).
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

	test("listAllEnabledForChat unions FK-owned AND junction-linked (no lorebook-style gap)", async () => {
		const { store } = await setup();
		// FK-owned by char_1 (home scope) — never junction-linked.
		await store.create({ name: "fk-owned", scopeType: "character", characterId: "char_1", enabled: true });
		// Global script, junction-linked to char_1.
		const linked = await store.create({ name: "linked", scopeType: "global", enabled: true });
		await store.addLink(linked.id, "character", "char_1");

		const resolved = await store.listAllEnabledForChat("char_1", null, "chat_x");
		const names = resolved.map((s) => s.name);
		// CRITICAL: both must appear. Lorebooks miss fk-owned here because their
		// resolver is junction-only; scripts deliberately consult both.
		expect(names).toContain("fk-owned");
		expect(names).toContain("linked");
	});

	test("junction-linked script homed to a DIFFERENT character still resolves via link", async () => {
		const { store } = await setup();
		// Home scope is char_1, but linked to persona_9 — the link must surface it.
		const s = await store.create({ name: "cross", scopeType: "character", characterId: "char_1", enabled: true });
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

	test("listByScope unions FK and junction for character/persona tabs", async () => {
		const { store } = await setup();
		await store.create({ name: "fk", scopeType: "character", characterId: "char_1" });
		const linked = await store.create({ name: "linked", scopeType: "global" });
		await store.addLink(linked.id, "character", "char_1");
		const names = (await store.listByScope("character", "char_1")).map((s) => s.name);
		expect(names).toContain("fk");
		expect(names).toContain("linked");
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

describe("ScriptStore.setScope (PR-6)", () => {
	test("reassigns character → persona atomically (stale FK cleared)", async () => {
		const { store } = await setup();
		const created = await store.create({ name: "S1", scopeType: "character", characterId: "char_1" });
		expect(created.scopeType).toBe("character");
		expect(created.characterId).toBe("char_1");

		const moved = await store.setScope(created.id, "persona", "persona_9");
		expect(moved.scopeType).toBe("persona");
		expect(moved.personaId).toBe("persona_9");
		// The stale character FK MUST be cleared — the whole point of setScope
		// vs a raw update({ scopeType, personaId }).
		expect(moved.characterId).toBeNull();
		expect(moved.chatId).toBeNull();

		// listByScope reflects the new scope; the old scope no longer lists it.
		const personaScripts = await store.listByScope("persona", "persona_9");
		expect(personaScripts.some((s) => s.id === created.id)).toBe(true);
		const charScripts = await store.listByScope("character", "char_1");
		expect(charScripts.some((s) => s.id === created.id)).toBe(false);
	});

	test("reassigning to global clears ALL FK columns", async () => {
		const { store } = await setup();
		const created = await store.create({ name: "S2", scopeType: "persona", personaId: "persona_9" });
		const globalized = await store.setScope(created.id, "global", null);
		expect(globalized.scopeType).toBe("global");
		expect(globalized.characterId).toBeNull();
		expect(globalized.personaId).toBeNull();
		expect(globalized.chatId).toBeNull();
		const globalScripts = await store.listByScope("global");
		expect(globalScripts.some((s) => s.id === created.id)).toBe(true);
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
		const moved = await store.setScope(s.id, "character", "char_1");
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

	test("the dice resolver preserves FK ∪ junction dedup/order (mirrors prompt path)", async () => {
		const { store } = await setup();
		await store.create({ name: "dice-fk", scopeType: "character", characterId: "char_1", enabled: true, scriptKind: "dice", sortOrder: 20 });
		const linked = await store.create({ name: "dice-linked", scopeType: "global", enabled: true, scriptKind: "dice", sortOrder: 10 });
		await store.addLink(linked.id, "character", "char_1");
		const names = (await store.listAllEnabledDiceScriptsForChat("char_1", null, "chat_x")).map((s) => s.name);
		// CRITICAL: both FK-owned and junction-linked dice scripts appear (FK ∪
		// junction), sorted by sortOrder — the same shape as the prompt resolver.
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
