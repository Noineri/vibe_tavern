// Characterization of `ScriptStore.listParticipatingForChat` — the «Текущие»
// script query (LOREBOOK_LIST_FILTERS_REPORT step 2), the counterpart of
// lorebook-participating.test.ts. The participation BINDING rules are the same
// one source the enabled resolvers read (`resolveChatScriptBindings`); only
// the enabled policy differs — attached-list semantics per the owner's
// 2026-10-03 ruling. Kind policy: prompt + dice (the two chat runtimes this
// binding core serves); interactive scripts never participate (owned by the
// Experience editor, excluded from the generic scripts tab).
// The pipeline-parity tests pin the policy split: `listAllEnabledForChat` /
// `listAllEnabledDiceScriptsForChat` keep excluding disabled and cross-kind
// scripts on the same rows.
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { createDb } from "../src/db-connection.js";
import { ScriptStore } from "../src/stores/script-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

const fixedClock: StoreClock = { now: () => "2026-10-03T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_part_${++counter}` };

async function setup() {
	const dir = await mkdtemp(join(tmpdir(), "vt-scriptpart-test-"));
	const db = await createDb(":memory:");
	const store = new ScriptStore(db, { content: null, clock: fixedClock, idGenerator: idGen });
	await db.run(sql`INSERT INTO characters (id, name, created_at, updated_at) VALUES ('char_1', 'C', '2026-01-01', '2026-01-01')`);
	await db.run(sql`INSERT INTO personas (id, name, description, default_for_new_chats, has_file_on_disk, created_at, updated_at) VALUES ('persona_9', 'P', '', 0, 0, '2026-01-01', '2026-01-01')`);
	await db.run(sql`INSERT INTO chats (id, character_id, active_branch_id, title, created_at, updated_at) VALUES ('chat_x', 'char_1', 'branch_x', 'T', '2026-01-01', '2026-01-01')`);
	await db.run(sql`INSERT INTO characters (id, name, created_at, updated_at) VALUES ('char_other', 'CO', '2026-01-01', '2026-01-01')`);
	return { store };
}

const names = (scripts: Array<{ name: string }>) => scripts.map((s) => s.name);

describe("ScriptStore.listParticipatingForChat («Текущие»)", () => {
	test("global + character + persona + chat scripts are included, sorted by sortOrder", async () => {
		const { store } = await setup();
		const charA = await store.create({ name: "char-a", scopeType: "entity", sortOrder: 30, enabled: true });
		await store.addLink(charA.id, "character", "char_1");
		await store.create({ name: "glob", scopeType: "global", sortOrder: 10, enabled: true });
		const personaA = await store.create({ name: "persona-a", scopeType: "entity", sortOrder: 20, enabled: true });
		await store.addLink(personaA.id, "persona", "persona_9");
		await store.create({ name: "chat-a", scopeType: "chat", chatId: "chat_x", sortOrder: 5, enabled: true });

		const participating = names(await store.listParticipatingForChat("char_1", "persona_9", "chat_x"));
		expect(participating).toEqual(["chat-a", "glob", "persona-a", "char-a"]);
	});

	test("disabled global script is excluded", async () => {
		const { store } = await setup();
		await store.create({ name: "global-off", scopeType: "global", enabled: false });

		const participating = names(await store.listParticipatingForChat("char_1", "persona_9", "chat_x"));
		expect(participating).not.toContain("global-off");
	});

	test("disabled character / persona / chat scripts are included (attached — the toggle turns them on)", async () => {
		const { store } = await setup();
		const charOff = await store.create({ name: "char-off", scopeType: "entity", enabled: false });
		await store.addLink(charOff.id, "character", "char_1");
		const personaOff = await store.create({ name: "persona-off", scopeType: "entity", enabled: false });
		await store.addLink(personaOff.id, "persona", "persona_9");
		await store.create({ name: "chat-off", scopeType: "chat", chatId: "chat_x", enabled: false });

		const participating = names(await store.listParticipatingForChat("char_1", "persona_9", "chat_x"));
		expect(participating).toContain("char-off");
		expect(participating).toContain("persona-off");
		expect(participating).toContain("chat-off");
	});

	test("other characters' and other personas' scripts are excluded", async () => {
		const { store } = await setup();
		const otherChar = await store.create({ name: "other-char", scopeType: "entity", enabled: true });
		await store.addLink(otherChar.id, "character", "char_other");
		const otherPersona = await store.create({ name: "other-persona", scopeType: "entity", enabled: true });
		await store.addLink(otherPersona.id, "persona", "persona_9");

		// The chat has no persona resolved → persona_9's script must not leak in.
		const participating = names(await store.listParticipatingForChat("char_1", null, "chat_x"));
		expect(participating).not.toContain("other-char");
		expect(participating).not.toContain("other-persona");
	});

	test("links are honored: a script linked to this chat's character participates, even disabled and cross-home", async () => {
		const { store } = await setup();
		// Dice-kind global linked to the chat's character → participates (Dice VM runtime).
		const linkedDice = await store.create({ name: "linked-dice", scopeType: "global", enabled: true, scriptKind: "dice" });
		await store.addLink(linkedDice.id, "character", "char_1");
		// Disabled global linked to the chat's persona → participates through the persona binding.
		const linkedGlobalOff = await store.create({ name: "linked-global-off", scopeType: "global", enabled: false });
		await store.addLink(linkedGlobalOff.id, "persona", "persona_9");
		// Multi-binding: linked to char_1 AND persona_9 — one row, both targets.
		const multiBound = await store.create({ name: "multi-bound", scopeType: "entity", enabled: true });
		await store.addLink(multiBound.id, "character", "char_1");
		await store.addLink(multiBound.id, "persona", "persona_9");

		const participating = names(await store.listParticipatingForChat("char_1", "persona_9", "chat_x"));
		expect(participating).toContain("linked-dice");
		expect(participating).toContain("linked-global-off");
		expect(participating.filter((name) => name === "multi-bound")).toHaveLength(1);
		// The link does NOT leak the persona-linked disabled global into an
		// unrelated chat — but the ENABLED global still participates everywhere
		// (global pool semantics, same as the pipeline resolver).
		const otherChat = names(await store.listParticipatingForChat("char_other", null, "chat_other"));
		expect(otherChat).toContain("linked-dice");
		expect(otherChat).not.toContain("linked-global-off");
	});

	test("interactive scripts never participate (owned by the Experience editor)", async () => {
		const { store } = await setup();
		const interactiveBound = await store.create({ name: "interactive-bound", scopeType: "entity", enabled: true, scriptKind: "interactive" });
		await store.addLink(interactiveBound.id, "character", "char_1");

		const participating = names(await store.listParticipatingForChat("char_1", "persona_9", "chat_x"));
		expect(participating).not.toContain("interactive-bound");
	});

	test("pipeline parity: the enabled resolvers still exclude disabled and cross-kind rows on the same fixture", async () => {
		const { store } = await setup();
		const charOff = await store.create({ name: "char-off", scopeType: "entity", enabled: false });
		await store.addLink(charOff.id, "character", "char_1");
		await store.create({ name: "global-off", scopeType: "global", enabled: false });
		await store.create({ name: "dice-glob", scopeType: "global", enabled: true, scriptKind: "dice" });
		const charOn = await store.create({ name: "char-on", scopeType: "entity", enabled: true });
		await store.addLink(charOn.id, "character", "char_1");

		const promptResolved = names(await store.listAllEnabledForChat("char_1", "persona_9", "chat_x"));
		expect(promptResolved).toEqual(["char-on"]);
		const diceResolved = names(await store.listAllEnabledDiceScriptsForChat("char_1", "persona_9", "chat_x"));
		expect(diceResolved).toEqual(["dice-glob"]);
		// «Текущие» includes the attached rows the resolvers excluded; the
		// disabled global stays excluded in both views (global-pool policy).
		const participating = names(await store.listParticipatingForChat("char_1", "persona_9", "chat_x"));
		expect(participating).toContain("char-off");
		expect(participating).toContain("dice-glob");
		expect(participating).not.toContain("global-off");
	});
});
