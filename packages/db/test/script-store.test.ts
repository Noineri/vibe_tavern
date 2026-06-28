import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { createDb } from "../src/db-connection.js";
import { ContentStore } from "../src/content-store.js";
import { createFileStore } from "../src/file-store.js";
import { ScriptStore } from "../src/stores/script-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

const fixedClock: StoreClock = { now: () => "2026-06-15T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

async function setup() {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-scriptstore-test-"));
	const db = await createDb(join(dataRoot, "test.db"));
	const content = new ContentStore({ fileStore: createFileStore(dataRoot) });
	const store = new ScriptStore(db, { content, clock: fixedClock, idGenerator: idGen });
	// FK parents (scripts reference characters + personas).
	await db.run(sql`INSERT INTO characters (id, name, created_at, updated_at) VALUES ('char_1', 'C', '2026-01-01', '2026-01-01')`);
	await db.run(sql`INSERT INTO personas (id, name, description, default_for_new_chats, has_file_on_disk, created_at, updated_at) VALUES ('persona_9', 'P', '', 0, 0, '2026-01-01', '2026-01-01')`);
	return { store };
}

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
