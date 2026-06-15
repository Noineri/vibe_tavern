import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";

import { createDb } from "../src/db-connection.js";
import { ContentStore } from "../src/content-store.js";
import { createFileStore, STORAGE_FOLDERS } from "../src/file-store.js";
import { personas as personasTable } from "../src/db-schema.js";
import { PersonaStore } from "../src/stores/persona-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

const PERSONAS = STORAGE_FOLDERS.personas;

const fixedClock: StoreClock = { now: () => "2026-06-15T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

async function setup() {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-personastore-test-"));
	const db = await createDb(join(dataRoot, "test.db"));
	const content = new ContentStore({ fileStore: createFileStore(dataRoot) });
	const store = new PersonaStore(db, { content, clock: fixedClock, idGenerator: idGen });
	return { dataRoot, db, content, store };
}

describe("PersonaStore folder storage (B2)", () => {
	test("create writes {id}/persona.json (no flat file)", async () => {
		const { dataRoot, store } = await setup();
		const persona = await store.create({ name: "Alex", description: "traveler", pronouns: "they/them" });

		const raw = JSON.parse(await readFile(join(dataRoot, PERSONAS, persona.id, "persona.json"), "utf8"));
		expect(raw).toEqual({ name: "Alex", description: "traveler", pronouns: "they/them" });

		// NO new flat {id}.json created
		const dirFiles = await readdir(join(dataRoot, PERSONAS));
		expect(dirFiles.some((f) => f === `${persona.id}.json`)).toBe(false);
	});

	test("getById is idempotent", async () => {
		const { store } = await setup();
		const created = await store.create({ name: "Alex" });
		expect((await store.getById(created.id))?.name).toBe("Alex");
		expect((await store.getById(created.id))?.name).toBe("Alex");
	});

	test("update rewrites {id}/persona.json", async () => {
		const { dataRoot, store } = await setup();
		const persona = await store.create({ name: "Alex" });
		await store.update(persona.id, { name: "Alex 2", description: "updated" });

		const raw = JSON.parse(await readFile(join(dataRoot, PERSONAS, persona.id, "persona.json"), "utf8"));
		expect(raw).toEqual({ name: "Alex 2", description: "updated", pronouns: null });
	});

	test("delete removes the DB row and the {id}/ folder", async () => {
		const { dataRoot, store } = await setup();
		// create two so the last-persona guard doesn't block
		const a = await store.create({ name: "A" });
		const b = await store.create({ name: "B" });

		await store.delete(a.id);
		expect(await store.getById(a.id)).toBeNull();
		await expect(readdir(join(dataRoot, PERSONAS, a.id))).rejects.toThrow();
		// b survives
		expect(await store.getById(b.id)).not.toBeNull();
	});

	test("delete refuses to remove the last persona (guard preserved)", async () => {
		const { store } = await setup();
		const only = await store.create({ name: "Solo" });
		await expect(store.delete(only.id)).rejects.toThrow(/last persona/i);
		expect(await store.getById(only.id)).not.toBeNull();
	});

	test("lazy migration: getById on a legacy flat {id}.json copies it to {id}/persona.json and leaves the source", async () => {
		const { dataRoot, db, content, store } = await setup();
		const id = "persona_legacy_1";
		await db.run(sql`INSERT INTO personas (id, name, description, pronouns, default_for_new_chats, has_file_on_disk, created_at, updated_at)
			VALUES (${id}, ${"Legacy User"}, ${"old desc"}, ${"she/her"}, 0, 0, ${fixedClock.now()}, ${fixedClock.now()})`);
		// legacy flat file (persona has no slug → {id}.json)
		await content.writeEntity(PERSONAS, id, { name: "Legacy User", description: "old desc", pronouns: "she/her" });
		const legacyPath = join(dataRoot, PERSONAS, `${id}.json`);

		const fetched = await store.getById(id);
		expect(fetched?.name).toBe("Legacy User");

		// {id}/persona.json exists with copied content
		const raw = JSON.parse(await readFile(join(dataRoot, PERSONAS, id, "persona.json"), "utf8"));
		expect(raw.description).toBe("old desc");

		// legacy flat file still on disk (copy-forward)
		const stillThere = await readFile(legacyPath, "utf8").then(() => true).catch(() => false);
		expect(stillThere).toBe(true);

		// DB stamped
		const row = db
			.select({ h: personasTable.hasFileOnDisk, ch: personasTable.contentHash })
			.from(personasTable)
			.where(eq(personasTable.id, id))
			.get();
		expect(row?.h).toBe(1);
		expect(row?.ch).not.toBeNull();
	});

	test("lazy migration: no legacy source + hasFileOnDisk=0 writes fresh from the DB row", async () => {
		const { dataRoot, db, store } = await setup();
		const id = "persona_orphan_1";
		await db.run(sql`INSERT INTO personas (id, name, description, pronouns, default_for_new_chats, has_file_on_disk, created_at, updated_at)
			VALUES (${id}, ${"Orphan User"}, '', NULL, 0, 0, ${fixedClock.now()}, ${fixedClock.now()})`);

		const fetched = await store.getById(id);
		expect(fetched?.name).toBe("Orphan User");
		const raw = JSON.parse(await readFile(join(dataRoot, PERSONAS, id, "persona.json"), "utf8"));
		expect(raw.name).toBe("Orphan User");
	});

	// ── B3: avatarExt plumbing ────────────────────────────────────────────

	test("create persists avatarExt and mapRow surfaces it", async () => {
		const { store } = await setup();
		const created = await store.create({ name: "Alex", avatarExt: "png" });
		expect(created.avatarExt).toBe("png");
		expect((await store.getById(created.id))?.avatarExt).toBe("png");
	});

	test("update writes avatarExt (including clearing to null)", async () => {
		const { store } = await setup();
		const created = await store.create({ name: "Alex", avatarExt: "png" });
		await store.update(created.id, { avatarExt: "webp" });
		expect((await store.getById(created.id))?.avatarExt).toBe("webp");
		await store.update(created.id, { avatarExt: null });
		expect((await store.getById(created.id))?.avatarExt).toBeNull();
	});

	// ── B4: lazy avatar migration in getById ───────────────────────────────

	test("getById lazy-migrates a legacy flat avatar into {id}/avatar.{ext} and clears avatarAssetId", async () => {
		const { dataRoot, db, store } = await setup();
		const id = "pers_ava_1";
		const assetId = "asset_test_pava1";
		await mkdir(join(dataRoot, "assets"), { recursive: true });
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		await Bun.write(join(dataRoot, "assets", `${assetId}.png`), bytes);
		await db.run(sql`INSERT INTO personas (id, name, description, pronouns, default_for_new_chats, has_file_on_disk, avatar_asset_id, avatar_ext, created_at, updated_at)
			 VALUES (${id}, ${"Ava User"}, '', NULL, 0, 1, ${assetId}, NULL, ${fixedClock.now()}, ${fixedClock.now()})`);

		const fetched = await store.getById(id);
		expect(fetched?.avatarExt).toBe("png");
		expect(fetched?.avatarAssetId).toBeNull();

		const copied = await readFile(join(dataRoot, PERSONAS, id, "avatar.png"));
		expect(new Uint8Array(copied)).toEqual(bytes);

		// legacy flat asset still on disk (copy-forward)
		const legacy = await readFile(join(dataRoot, "assets", `${assetId}.png`));
		expect(new Uint8Array(legacy)).toEqual(bytes);

		const row = db.select({ ext: personasTable.avatarExt, aid: personasTable.avatarAssetId }).from(personasTable).where(eq(personasTable.id, id)).get();
		expect(row?.ext).toBe("png");
		expect(row?.aid).toBeNull();

		// idempotent
		await store.getById(id);
		const row2 = db.select({ ext: personasTable.avatarExt }).from(personasTable).where(eq(personasTable.id, id)).get();
		expect(row2?.ext).toBe("png");
	});

	test("getById leaves avatarAssetId as-is when the flat asset is missing (no throw)", async () => {
		const { db, store } = await setup();
		const id = "pers_ava_2";
		await db.run(sql`INSERT INTO personas (id, name, description, pronouns, default_for_new_chats, has_file_on_disk, avatar_asset_id, avatar_ext, created_at, updated_at)
			 VALUES (${id}, ${"NoAva User"}, '', NULL, 0, 1, ${"asset_gone"}, NULL, ${fixedClock.now()}, ${fixedClock.now()})`);

		const fetched = await store.getById(id);
		expect(fetched?.avatarExt).toBeNull();
		expect(fetched?.avatarAssetId).toBe("asset_gone");
	});
});
