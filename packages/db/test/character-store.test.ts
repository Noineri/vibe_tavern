import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql, eq } from "drizzle-orm";

import { createDb } from "../src/db-connection.js";
import { characters as charactersTable } from "../src/db-schema.js";
import { ContentStore } from "../src/content-store.js";
import { createFileStore, STORAGE_FOLDERS } from "../src/file-store.js";
import { CharacterStore } from "../src/stores/character-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

const CHARS = STORAGE_FOLDERS.characters;

const fixedClock: StoreClock = { now: () => "2026-06-15T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

async function setup() {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-charstore-test-"));
	const db = await createDb(join(dataRoot, "test.db"));
	const content = new ContentStore({ fileStore: createFileStore(dataRoot) });
	const store = new CharacterStore(db, { content, clock: fixedClock, idGenerator: idGen });
	return { dataRoot, db, content, store };
}

async function listCharFiles(dataRoot: string, id: string): Promise<string[]> {
	try {
		return await readdir(join(dataRoot, CHARS));
	} catch {
		return [];
	}
}

describe("CharacterStore folder storage (B1)", () => {
	test("create writes {id}/card.json (no flat file)", async () => {
		const { dataRoot, store } = await setup();
		const char = await store.create({ name: "Aria", description: "storm mage" });

		// folder file exists with the canonical body
		const cardPath = join(dataRoot, CHARS, char.id, "card.json");
		const raw = JSON.parse(await readFile(cardPath, "utf8"));
		expect(raw.spec).toBe("chara_card_v3");
		expect(raw.data.name).toBe("Aria");

		// NO new flat file {id}.json or {id}.*.json is created for new characters
		const allFiles = await listCharFiles(dataRoot, char.id);
		expect(allFiles.some((f) => f === `${char.id}.json`)).toBe(false);
		expect(allFiles.some((f) => f.startsWith(`${char.id}.`) && f.endsWith(".json"))).toBe(false);
	});

	test("getById returns the character and is idempotent on the file", async () => {
		const { store } = await setup();
		const created = await store.create({ name: "Aria" });
		const fetched = await store.getById(created.id);
		expect(fetched?.id).toBe(created.id);
		expect(fetched?.name).toBe("Aria");
		// second fetch does not throw / does not duplicate
		const fetched2 = await store.getById(created.id);
		expect(fetched2?.id).toBe(created.id);
	});

	test("update rewrites {id}/card.json with the new content", async () => {
		const { dataRoot, store } = await setup();
		const char = await store.create({ name: "Aria" });
		await store.update(char.id, { name: "Aria Storm", description: "updated" });

		const raw = JSON.parse(await readFile(join(dataRoot, CHARS, char.id, "card.json"), "utf8"));
		expect(raw.data.name).toBe("Aria Storm");
		expect(raw.data.description).toBe("updated");
	});

	test("delete removes the DB row and the whole {id}/ folder", async () => {
		const { dataRoot, store } = await setup();
		const char = await store.create({ name: "Aria" });
		const folderPath = join(dataRoot, CHARS, char.id);

		expect(await store.getById(char.id)).not.toBeNull();
		await store.delete(char.id);

		expect(await store.getById(char.id)).toBeNull();
		// folder gone
		await expect(readdir(folderPath)).rejects.toThrow();
	});

	test("duplicate writes a separate {newId}/card.json", async () => {
		const { dataRoot, store } = await setup();
		const original = await store.create({ name: "Aria", description: "unique" });
		const copy = await store.duplicate(original.id);

		expect(copy.id).not.toBe(original.id);
		expect(copy.name).toContain("copy");

		// copy has its own card.json with the duplicated content
		const raw = JSON.parse(await readFile(join(dataRoot, CHARS, copy.id, "card.json"), "utf8"));
		expect(raw.data.description).toBe("unique");
	});

	test("lazy migration: getById on a legacy flat file copies it to {id}/card.json and leaves the source", async () => {
		const { dataRoot, db, content, store } = await setup();

		// Simulate a pre-folder-layout character: DB row with hasFileOnDisk=0 and
		// a legacy flat {id}.{slug}.json on disk (no folder).
		const id = "char_legacy_1";
		await db.run(sql`INSERT INTO characters (id, name, description, personality_summary, alternate_greetings_json, extensions_json, tags_json, mes_example_mode, mes_example_depth, status, has_file_on_disk, created_at, updated_at)
			 VALUES (${id}, ${"Legacy Hero"}, '', NULL, '[]', '{}', '[]', 'always', 4, 'active', 0, ${fixedClock.now()}, ${fixedClock.now()})`);
		// write the legacy flat file via the legacy method (slugified name)
		await content.writeEntity(CHARS, id, { spec: "chara_card_v3", data: { name: "Legacy Hero" } }, { displayName: "Legacy Hero" });
		const legacyFiles = await listCharFiles(dataRoot, id);
		const legacyFile = legacyFiles.find((f) => f.startsWith(`${id}.`) && f.endsWith(".json"));
		expect(legacyFile).toBeDefined();
		const legacyPath = join(dataRoot, CHARS, legacyFile!);

		// getById triggers lazy migration
		const fetched = await store.getById(id);
		expect(fetched?.name).toBe("Legacy Hero");

		// {id}/card.json now exists
		const cardRaw = JSON.parse(await readFile(join(dataRoot, CHARS, id, "card.json"), "utf8"));
		expect(cardRaw.data.name).toBe("Legacy Hero");

		// legacy flat file STILL on disk (copy-forward)
		const legacyStillThere = await readFile(legacyPath, "utf8").then(() => true).catch(() => false);
		expect(legacyStillThere).toBe(true);

		// DB row stamped
		const row = db
			.select({ has_file_on_disk: charactersTable.hasFileOnDisk, content_hash: charactersTable.contentHash })
			.from(charactersTable)
			.where(eq(charactersTable.id, id))
			.get();
		expect(row?.has_file_on_disk).toBe(1);
		expect(row?.content_hash).not.toBeNull();
	});

	test("lazy migration: no legacy source + hasFileOnDisk=0 writes fresh {id}/card.json from the DB row", async () => {
		const { dataRoot, db, store } = await setup();
		const id = "char_orphan_1";
		await db.run(sql`INSERT INTO characters (id, name, description, personality_summary, alternate_greetings_json, extensions_json, tags_json, mes_example_mode, mes_example_depth, status, has_file_on_disk, created_at, updated_at)
			 VALUES (${id}, ${"Orphan Hero"}, '', NULL, '[]', '{}', '[]', 'always', 4, 'active', 0, ${fixedClock.now()}, ${fixedClock.now()})`);
		// no file on disk at all
		const fetched = await store.getById(id);
		expect(fetched?.name).toBe("Orphan Hero");
		const raw = JSON.parse(await readFile(join(dataRoot, CHARS, id, "card.json"), "utf8"));
		expect(raw.data.name).toBe("Orphan Hero");
	});

	// ── B3: avatarExt plumbing ────────────────────────────────────────────

	test("create persists avatarExt and mapRow surfaces it", async () => {
		const { store } = await setup();
		const created = await store.create({ name: "Aria", avatarExt: "png" });
		expect(created.avatarExt).toBe("png");
		// round-trip through getById
		expect((await store.getById(created.id))?.avatarExt).toBe("png");
	});

	test("update writes avatarExt (including clearing to null)", async () => {
		const { store } = await setup();
		const created = await store.create({ name: "Aria", avatarExt: "png" });
		await store.update(created.id, { avatarExt: "webp" });
		expect((await store.getById(created.id))?.avatarExt).toBe("webp");
		await store.update(created.id, { avatarExt: null });
		expect((await store.getById(created.id))?.avatarExt).toBeNull();
	});

	test("duplicate copies avatarExt column AND the folder avatar file", async () => {
		const { dataRoot, content, store } = await setup();
		const original = await store.create({ name: "Aria", avatarExt: "png" });
		// seed a folder avatar for the original
		await content.writeBinary(CHARS, original.id, "avatar.png", new Uint8Array([1, 2, 3]));

		const copy = await store.duplicate(original.id);
		expect(copy.avatarExt).toBe("png");
		// copy has its OWN avatar file (separate bytes, not a shared reference)
		const copyAvatar = await readFile(join(dataRoot, CHARS, copy.id, "avatar.png"));
		expect(copyAvatar).toEqual(Buffer.from([1, 2, 3]));
		// mutate the copy's avatar; original is untouched (separate file)
		await content.writeBinary(CHARS, copy.id, "avatar.png", new Uint8Array([9, 9]));
		const originalAvatar = await readFile(join(dataRoot, CHARS, original.id, "avatar.png"));
		expect(originalAvatar).toEqual(Buffer.from([1, 2, 3]));
	});

	// ── B4: lazy avatar migration in getById ───────────────────────────────

	test("getById lazy-migrates a legacy flat avatar into {id}/avatar.{ext} and clears avatarAssetId", async () => {
		const { dataRoot, db, store } = await setup();
		const id = "char_ava_1";
		const assetId = "asset_test_ava1";
		// seed a legacy flat asset under data/assets/ (pre-folder-layout avatar)
		await mkdir(join(dataRoot, "assets"), { recursive: true });
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		await Bun.write(join(dataRoot, "assets", `${assetId}.png`), bytes);
		// DB row: legacy avatar via avatarAssetId, avatarExt null, card on disk
		await db.run(sql`INSERT INTO characters (id, name, description, personality_summary, alternate_greetings_json, extensions_json, tags_json, mes_example_mode, mes_example_depth, status, has_file_on_disk, avatar_asset_id, avatar_ext, created_at, updated_at)
			 VALUES (${id}, ${"Ava Hero"}, '', NULL, '[]', '{}', '[]', 'always', 4, 'active', 1, ${assetId}, NULL, ${fixedClock.now()}, ${fixedClock.now()})`);

		const fetched = await store.getById(id);
		expect(fetched?.avatarExt).toBe("png");
		expect(fetched?.avatarAssetId).toBeNull();

		// avatar copied into the entity folder
		const copied = await readFile(join(dataRoot, CHARS, id, "avatar.png"));
		expect(new Uint8Array(copied)).toEqual(bytes);

		// legacy flat asset still on disk (copy-forward)
		const legacy = await readFile(join(dataRoot, "assets", `${assetId}.png`));
		expect(new Uint8Array(legacy)).toEqual(bytes);

		// DB stamped
		const row = db.select({ ext: charactersTable.avatarExt, aid: charactersTable.avatarAssetId }).from(charactersTable).where(eq(charactersTable.id, id)).get();
		expect(row?.ext).toBe("png");
		expect(row?.aid).toBeNull();

		// idempotent: a second getById is a no-op (avatarExt now set → block skipped)
		await store.getById(id);
		const row2 = db.select({ ext: charactersTable.avatarExt }).from(charactersTable).where(eq(charactersTable.id, id)).get();
		expect(row2?.ext).toBe("png");
	});

	test("getById leaves avatarAssetId as-is when the flat asset is missing (no throw)", async () => {
		const { db, store } = await setup();
		const id = "char_ava_2";
		await db.run(sql`INSERT INTO characters (id, name, description, personality_summary, alternate_greetings_json, extensions_json, tags_json, mes_example_mode, mes_example_depth, status, has_file_on_disk, avatar_asset_id, avatar_ext, created_at, updated_at)
			 VALUES (${id}, ${"NoAva Hero"}, '', NULL, '[]', '{}', '[]', 'always', 4, 'active', 1, ${"asset_gone"}, NULL, ${fixedClock.now()}, ${fixedClock.now()})`);

		const fetched = await store.getById(id);
		expect(fetched?.avatarExt).toBeNull();
		expect(fetched?.avatarAssetId).toBe("asset_gone");
	});
});
