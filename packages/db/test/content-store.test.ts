import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContentStore } from "../src/content-store.js";
import { createFileStore, STORAGE_FOLDERS } from "../src/file-store.js";

const CHARS = STORAGE_FOLDERS.characters;
const PERSONAS = STORAGE_FOLDERS.personas;

describe("ContentStore folder primitives", () => {
	test("writeEntityFile writes data/{folder}/{id}/{name}.json and readEntityFile round-trips", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-cs-test-"));
		const content = new ContentStore({ fileStore: createFileStore(dir) });
		const data = { name: "Aria", description: "test" };

		const hash = await content.writeEntityFile(CHARS, "char_1", "card", data);
		expect(typeof hash).toBe("string");
		expect(hash.length).toBeGreaterThan(0);

		// file lands at the expected path
		const raw = await readFile(join(dir, "characters", "char_1", "card.json"), "utf8");
		expect(JSON.parse(raw)).toEqual(data);

		const back = await content.readEntityFile<{ name: string }>(CHARS, "char_1", "card");
		expect(back).toEqual(data);
	});

	test("readEntityFile returns null when the file is missing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-cs-test-"));
		const content = new ContentStore({ fileStore: createFileStore(dir) });
		expect(await content.readEntityFile(CHARS, "char_1", "card")).toBeNull();
	});

	test("card.json and original.json occupy separate cache slots (no collision)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-cs-test-"));
		const content = new ContentStore({ fileStore: createFileStore(dir) });
		await content.writeEntityFile(CHARS, "char_1", "card", { role: "card" });
		await content.writeEntityFile(CHARS, "char_1", "original", { role: "original" });

		expect(await content.readEntityFile(CHARS, "char_1", "card")).toEqual({ role: "card" });
		expect(await content.readEntityFile(CHARS, "char_1", "original")).toEqual({ role: "original" });
	});

	test("re-writing the same name reflects the new content", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-cs-test-"));
		const content = new ContentStore({ fileStore: createFileStore(dir) });
		await content.writeEntityFile(PERSONAS, "per_1", "persona", { name: "v1" });
		await content.writeEntityFile(PERSONAS, "per_1", "persona", { name: "v2" });
		expect(await content.readEntityFile(PERSONAS, "per_1", "persona")).toEqual({ name: "v2" });
	});

	test("writeBinary / readBinary round-trip avatar bytes; null when missing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-cs-test-"));
		const content = new ContentStore({ fileStore: createFileStore(dir) });
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);

		await content.writeBinary(CHARS, "char_1", "avatar.png", bytes);

		const back = await content.readBinary(CHARS, "char_1", "avatar.png");
		expect(back).not.toBeNull();
		expect(Buffer.from(back as Buffer)).toEqual(Buffer.from(bytes));

		expect(await content.readBinary(CHARS, "char_1", "avatar.jpg")).toBeNull();
	});

	test("deleteEntityFolder removes the whole folder + nested cache; leaves the legacy flat file intact (copy-forward)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-cs-test-"));
		const content = new ContentStore({ fileStore: createFileStore(dir) });

		// folder-resident files
		await content.writeEntityFile(CHARS, "char_1", "card", { a: 1 });
		await content.writeEntityFile(CHARS, "char_1", "original", { a: 2 });
		await content.writeBinary(CHARS, "char_1", "avatar.png", new Uint8Array([9]));

		// legacy flat file — must survive folder deletion (copy-forward policy)
		await content.writeEntity(CHARS, "char_1", { legacy: true });

		expect(await content.entityFolderExists(CHARS, "char_1")).toBe(true);

		await content.deleteEntityFolder(CHARS, "char_1");

		// folder + nested contents gone
		expect(await content.entityFolderExists(CHARS, "char_1")).toBe(false);
		expect(await content.readEntityFile(CHARS, "char_1", "card")).toBeNull();
		expect(await content.readBinary(CHARS, "char_1", "avatar.png")).toBeNull();

		// legacy flat file still readable
		expect(await content.readEntity<{ legacy: boolean }>(CHARS, "char_1")).toEqual({ legacy: true });
	});

	test("deleteEntityFolder is a no-op when the folder is missing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-cs-test-"));
		const content = new ContentStore({ fileStore: createFileStore(dir) });
		await expect(content.deleteEntityFolder(CHARS, "ghost")).resolves.toBeUndefined();
	});
});

describe("ContentStore legacy flat-file helpers", () => {
	test("findLegacyFlatFile finds the exact {id}.json", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-cs-test-"));
		const content = new ContentStore({ fileStore: createFileStore(dir) });
		await content.writeEntity(CHARS, "char_1", { a: 1 });
		expect(await content.findLegacyFlatFile(CHARS, "char_1")).toBe(join(dir, CHARS, "char_1.json"));
	});

	test("findLegacyFlatFile finds {id}.{slug}.json", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-cs-test-"));
		const content = new ContentStore({ fileStore: createFileStore(dir) });
		await content.writeEntity(CHARS, "char_1", { a: 1 }, { displayName: "Aria" });
		const found = await content.findLegacyFlatFile(CHARS, "char_1");
		expect(found).not.toBeNull();
		expect(found).toMatch(/char_1\..*\.json$/);
	});

	test("findLegacyFlatFile does not match ids that merely share a prefix", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-cs-test-"));
		const content = new ContentStore({ fileStore: createFileStore(dir) });
		// char_1 vs char_10 — must not cross-match
		await content.writeEntity(CHARS, "char_10", { big: true });
		expect(await content.findLegacyFlatFile(CHARS, "char_1")).toBeNull();
	});

	test("findLegacyFlatFile returns null when nothing exists", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-cs-test-"));
		const content = new ContentStore({ fileStore: createFileStore(dir) });
		expect(await content.findLegacyFlatFile(CHARS, "char_1")).toBeNull();
	});

	test("migrateFlatToFolder copies {id}.json → {id}/card.json and leaves the source", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-cs-test-"));
		const content = new ContentStore({ fileStore: createFileStore(dir) });
		await content.writeEntity(CHARS, "char_1", { name: "Aria", desc: "x" });

		const migrated = await content.migrateFlatToFolder(CHARS, "char_1", "card");
		expect(migrated).toBe(true);

		// folder file exists with identical content
		const moved = await content.readEntityFile<{ name: string }>(CHARS, "char_1", "card");
		expect(moved).toEqual({ name: "Aria", desc: "x" });

		// source flat file still on disk
		const source = await readFile(join(dir, CHARS, "char_1.json"), "utf8");
		expect(JSON.parse(source)).toEqual({ name: "Aria", desc: "x" });
	});

	test("migrateFlatToFolder picks up the slug variant too", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-cs-test-"));
		const content = new ContentStore({ fileStore: createFileStore(dir) });
		await content.writeEntity(CHARS, "char_1", { name: "Aria" }, { displayName: "Aria Storm" });

		const migrated = await content.migrateFlatToFolder(CHARS, "char_1", "card");
		expect(migrated).toBe(true);
		expect(await content.readEntityFile(CHARS, "char_1", "card")).toEqual({ name: "Aria" });
	});

	test("migrateFlatToFolder is idempotent — second call is a no-op", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-cs-test-"));
		const content = new ContentStore({ fileStore: createFileStore(dir) });
		await content.writeEntity(CHARS, "char_1", { a: 1 });

		expect(await content.migrateFlatToFolder(CHARS, "char_1", "card")).toBe(true);
		expect(await content.migrateFlatToFolder(CHARS, "char_1", "card")).toBe(false);
	});

	test("migrateFlatToFolder returns false when there is no legacy source", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-cs-test-"));
		const content = new ContentStore({ fileStore: createFileStore(dir) });
		expect(await content.migrateFlatToFolder(CHARS, "char_1", "card")).toBe(false);
	});
});

describe("ContentStore directory rename + listing (HUMAN_READABLE_FOLDERS)", () => {
	test("listSubdirs returns immediate subdirectory names; [] when the folder is missing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-cs-test-"));
		const content = new ContentStore({ fileStore: createFileStore(dir) });
		// Missing folder → empty.
		expect(await content.listSubdirs(CHARS)).toEqual([]);
		// Create two character dirs + one flat file (flat files are NOT subdirs).
		await content.writeEntityTextFile(CHARS, "char_1", "profile.md", "x");
		await content.writeEntityTextFile(CHARS, "Andrea", "profile.md", "y");
		await content.writeEntity(CHARS, "flat_only", { legacy: true });
		const subdirs = (await content.listSubdirs(CHARS)).sort();
		expect(subdirs).toEqual(["Andrea", "char_1"]);
	});

	test("renameEntityFolder moves the directory and evicts old-name cache entries", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-cs-test-"));
		const content = new ContentStore({ fileStore: createFileStore(dir) });
		await content.writeEntityTextFile(CHARS, "char_old", "profile.md", "body");
		// Populate the text cache for the old name.
		expect(await content.readEntityTextFile(CHARS, "char_old", "profile.md")).toBe("body");

		await content.renameEntityFolder(CHARS, "char_old", "Andrea");

		// The directory moved: old path gone, new path has the file.
		expect(await content.readEntityTextFile(CHARS, "char_old", "profile.md")).toBeNull();
		expect(await content.readEntityTextFile(CHARS, "Andrea", "profile.md")).toBe("body");
	});

	test("renameEntityFolder is a no-op when the source folder is absent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-cs-test-"));
		const content = new ContentStore({ fileStore: createFileStore(dir) });
		// No throw, no destination created.
		await content.renameEntityFolder(CHARS, "char_gone", "Andrea");
		expect(await content.entityFolderExists(CHARS, "Andrea")).toBe(false);
	});

	test("renameEntityFolder rejects an occupied destination before touching the filesystem", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vt-cs-test-"));
		const content = new ContentStore({ fileStore: createFileStore(dir) });
		await content.writeEntityTextFile(CHARS, "char_src", "profile.md", "src");
		await content.writeEntityTextFile(CHARS, "Andrea", "profile.md", "existing");

		await expect(content.renameEntityFolder(CHARS, "char_src", "Andrea")).rejects.toThrow(/destination already exists/);
		// Source is untouched (the throw happened before the rename).
		expect(await content.readEntityTextFile(CHARS, "char_src", "profile.md")).toBe("src");
		expect(await content.readEntityTextFile(CHARS, "Andrea", "profile.md")).toBe("existing");
	});
});
