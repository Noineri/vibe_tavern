import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "../src/db-connection.js";
import { ContentStore } from "../src/content-store.js";
import { createFileStore, STORAGE_FOLDERS } from "../src/file-store.js";
import { CharacterAssetStore } from "../src/stores/character-asset-store.js";
import { CharacterStore } from "../src/stores/character-store.js";
import type { StoreClock, StoreIdGenerator } from "../src/persistence.js";

const CHARS = STORAGE_FOLDERS.characters;

const fixedClock: StoreClock = { now: () => "2026-06-15T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

async function setup() {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-assetstore-test-"));
	const db = await createDb(join(dataRoot, "test.db"));
	const content = new ContentStore({ fileStore: createFileStore(dataRoot) });
	const characterStore = new CharacterStore(db, { content, clock: fixedClock, idGenerator: idGen });
	const store = new CharacterAssetStore(db, { clock: fixedClock, idGenerator: idGen });
	const char = await characterStore.create({ name: "Aria" });
	return { dataRoot, db, content, store, characterStore, charId: char.id };
}

describe("CharacterAssetStore (DB-only)", () => {
	test("create → list (ordered by order, then createdAt)", async () => {
		const { store, charId } = await setup();
		const a = await store.create({ characterId: charId, ext: "png", mimeType: "image/png", order: 1 });
		const b = await store.create({ characterId: charId, ext: "jpg", mimeType: "image/jpeg", caption: "pic", order: 0 });

		const list = await store.listByCharacter(charId);
		expect(list.map((x) => x.id)).toEqual([b.id, a.id]); // order 0 before 1
		expect(list[0]).toMatchObject({ ext: "jpg", caption: "pic", description: null });
		expect(a.caption).toBe(""); // default
	});

	test("list is scoped by characterId", async () => {
		const { store, characterStore, charId } = await setup();
		const char2 = await characterStore.create({ name: "Other" });
		await store.create({ characterId: charId, ext: "png", mimeType: "image/png", order: 0 });
		await store.create({ characterId: char2.id, ext: "png", mimeType: "image/png", order: 0 });
		expect((await store.listByCharacter(charId)).length).toBe(1);
		expect((await store.listByCharacter(char2.id)).length).toBe(1);
	});

	test("update caption and description (null clears)", async () => {
		const { store, charId } = await setup();
		const a = await store.create({ characterId: charId, ext: "png", mimeType: "image/png", order: 0 });
		const updated = await store.update(a.id, { caption: "hello", description: "a portrait" });
		expect(updated).toMatchObject({ caption: "hello", description: "a portrait" });
		const cleared = await store.update(a.id, { description: null });
		expect(cleared?.description).toBeNull();
	});

	test("update returns null for unknown id", async () => {
		const { store } = await setup();
		expect(await store.update("nope", { caption: "x" })).toBeNull();
	});

	test("reorder rewrites order 0..n-1, scoped to characterId", async () => {
		const { store, charId } = await setup();
		const a = await store.create({ characterId: charId, ext: "png", mimeType: "image/png", order: 0 });
		const b = await store.create({ characterId: charId, ext: "png", mimeType: "image/png", order: 1 });
		const c = await store.create({ characterId: charId, ext: "png", mimeType: "image/png", order: 2 });

		// Reverse the order; pass a foreign id too to confirm it is ignored.
		await store.reorder(charId, [c.id, "foreign_id", a.id, b.id]);

		const list = await store.listByCharacter(charId);
		expect(list.map((x) => x.id)).toEqual([c.id, a.id, b.id]);
		expect(list.map((x) => x.order)).toEqual([0, 1, 2]);
	});

	test("delete returns {characterId, ext} and does NOT touch the filesystem", async () => {
		const { dataRoot, content, store, charId } = await setup();
		const a = await store.create({ characterId: charId, ext: "png", mimeType: "image/png", order: 0 });

		// Simulate the adapter having written the gallery file.
		const leaf = `gallery/${a.id}.png`;
		await content.writeBinary(CHARS, charId, leaf, new Uint8Array([1, 2, 3]));
		const fileBefore = await readFile(join(dataRoot, CHARS, charId, "gallery", `${a.id}.png`));
		expect(Array.from(fileBefore)).toEqual([1, 2, 3]);

		const result = await store.delete(a.id);
		expect(result).toEqual({ characterId: charId, ext: "png" });

		// Row is gone.
		expect(await store.getById(a.id)).toBeNull();
		// File is STILL there — the store is DB-only; the adapter owns file cleanup.
		const fileAfter = await readFile(join(dataRoot, CHARS, charId, "gallery", `${a.id}.png`));
		expect(Array.from(fileAfter)).toEqual([1, 2, 3]);
	});

	test("delete returns null for unknown id", async () => {
		const { store } = await setup();
		expect(await store.delete("nope")).toBeNull();
	});
});

describe("ContentStore.deleteBinary", () => {
	test("removes a single binary leaf inside an entity folder", async () => {
		const { dataRoot, content, store, charId } = await setup();
		const a = await store.create({ characterId: charId, ext: "png", mimeType: "image/png", order: 0 });
		const leaf = `gallery/${a.id}.png`;
		await content.writeBinary(CHARS, charId, leaf, new Uint8Array([1, 2, 3]));

		await content.deleteBinary(CHARS, charId, leaf);

		// The targeted leaf is gone.
		await expect(readFile(join(dataRoot, CHARS, charId, "gallery", `${a.id}.png`))).rejects.toThrow();
	});

	test("is a no-op when the file is missing", async () => {
		const { content, charId } = await setup();
		await expect(content.deleteBinary(CHARS, charId, "gallery/never_existed.png")).resolves.toBeUndefined();
	});
});
