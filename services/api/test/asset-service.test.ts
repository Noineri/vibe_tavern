import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContentStore, createFileStore, STORAGE_FOLDERS } from "@vibe-tavern/db";
import { AssetService } from "../src/domain/asset/asset-service.js";

const CHARS = STORAGE_FOLDERS.characters;
const PERSONAS = STORAGE_FOLDERS.personas;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46]);

async function setup() {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-asset-test-"));
	const assetsDir = join(dataRoot, "assets");
	await mkdir(assetsDir, { recursive: true });
	const content = new ContentStore({ fileStore: createFileStore(dataRoot) });
	const service = new AssetService(assetsDir, content);
	return { dataRoot, assetsDir, content, service };
}

describe("AssetService folder-resident avatars (B3)", () => {
	test("writeCharacterAvatar writes {id}/avatar.{ext} and returns ext", async () => {
		const { dataRoot, service } = await setup();
		const file = new File([PNG_BYTES], "ava.png", { type: "image/png" });
		const { ext } = await service.writeCharacterAvatar("char_1", file);
		expect(ext).toBe("png");
		const onDisk = await readFile(join(dataRoot, CHARS, "char_1", "avatar.png"));
		expect(onDisk).toEqual(Buffer.from(PNG_BYTES));
	});

	test("writePersonaAvatar writes under personas/", async () => {
		const { dataRoot, service } = await setup();
		const { ext } = await service.writePersonaAvatar("pers_1", new File([WEBP_BYTES], "a.webp", { type: "image/webp" }));
		expect(ext).toBe("webp");
		const onDisk = await readFile(join(dataRoot, PERSONAS, "pers_1", "avatar.webp"));
		expect(onDisk).toEqual(Buffer.from(WEBP_BYTES));
	});

	test("write rejects unsupported mime", async () => {
		const { service } = await setup();
		await expect(
			service.writeCharacterAvatar("char_1", new File([new Uint8Array(1)], "a.bmp", { type: "image/bmp" })),
		).rejects.toThrow(/Unsupported image type/);
	});

	test("serveCharacterAvatar returns the bytes + Content-Type; null when missing", async () => {
		const { service } = await setup();
		await service.writeCharacterAvatar("char_1", new File([PNG_BYTES], "a.png", { type: "image/png" }));

		const res = await service.serveCharacterAvatar("char_1", "png");
		expect(res).not.toBeNull();
		expect(res!.headers.get("Content-Type")).toBe("image/png");
		expect(new Uint8Array(await res!.arrayBuffer())).toEqual(PNG_BYTES);

		// wrong ext → file not found → null (no probing at serve time)
		expect(await service.serveCharacterAvatar("char_1", "webp")).toBeNull();
		// unknown entity → null
		expect(await service.serveCharacterAvatar("char_missing", "png")).toBeNull();
	});

	test("loadCharacterAvatarBuffer round-trips a Buffer (for vision describe)", async () => {
		const { service } = await setup();
		await service.writeCharacterAvatar("char_1", new File([PNG_BYTES], "a.png", { type: "image/png" }));
		const buf = await service.loadCharacterAvatarBuffer("char_1", "png");
		expect(buf).not.toBeNull();
		expect(new Uint8Array(buf!)).toEqual(PNG_BYTES);
		expect(await service.loadCharacterAvatarBuffer("char_1", "gif")).toBeNull();
	});

	test("migrateFlatAvatarToFolder copies the flat asset into {id}/avatar.{ext} and returns ext; leaves the source", async () => {
		const { dataRoot, assetsDir, service } = await setup();
		// Simulate a legacy flat asset uploaded via the old /api/assets path.
		const assetId = "asset_abc123";
		await writeFile(join(assetsDir, `${assetId}.png`), PNG_BYTES);

		const result = await service.migrateFlatAvatarToFolder({ kind: "character", id: "char_1" }, assetId);
		expect(result).toEqual({ ext: "png" });

		// Copied into the folder
		const copied = await readFile(join(dataRoot, CHARS, "char_1", "avatar.png"));
		expect(copied).toEqual(Buffer.from(PNG_BYTES));

		// Flat source preserved (copy-forward)
		const source = await readFile(join(assetsDir, `${assetId}.png`));
		expect(source).toEqual(Buffer.from(PNG_BYTES));
	});

	test("migrateFlatAvatarToFolder returns null when the flat asset is gone (caller leaves avatarAssetId as-is)", async () => {
		const { service } = await setup();
		const result = await service.migrateFlatAvatarToFolder({ kind: "persona", id: "pers_1" }, "asset_nope");
		expect(result).toBeNull();
	});

	test("migrateFlatAvatarToFolder rejects path-traversal assetIds", async () => {
		const { service } = await setup();
		expect(await service.migrateFlatAvatarToFolder({ kind: "character", id: "c1" }, "../escape")).toBeNull();
		expect(await service.migrateFlatAvatarToFolder({ kind: "character", id: "c1" }, "a/b")).toBeNull();
	});

	test("folder methods throw / no-op when contentStore is unset (bare helper)", async () => {
		const { assetsDir } = await setup();
		const bare = new AssetService(assetsDir); // no contentStore
		await expect(
			bare.writeCharacterAvatar("c1", new File([PNG_BYTES], "a.png", { type: "image/png" })),
		).rejects.toThrow(/folder storage/);
		expect(await bare.serveCharacterAvatar("c1", "png")).toBeNull();
		expect(await bare.loadCharacterAvatarBuffer("c1", "png")).toBeNull();
		expect(await bare.migrateFlatAvatarToFolder({ kind: "character", id: "c1" }, "asset_x")).toBeNull();
	});
});

describe("AssetService full-avatar overwrite (Bug #2 characterization)", () => {
	// Repro: the user reports that swapping/updating a character avatar changes
	// the thumbnail (avatar.{ext}) but NOT the full (avatar-full.{ext}) — and the
	// stale full survives a page reload AND a server restart. Restart-resilience
	// rules out in-memory state, so the question is whether the backend actually
	// overwrites {id}/avatar-full.{ext} on the second write. These tests pin the
	// backend write+serve path in isolation (no gallery, no salvage, no UI).
	const FULL_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xaa, 0xaa, 0xaa, 0xaa]);
	const FULL_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xbb, 0xbb, 0xbb, 0xbb, 0xbb, 0xbb]);

	test("writeCharacterAvatarFull overwrites the prior full on a second write", async () => {
		const { dataRoot, service } = await setup();
		await service.writeCharacterAvatarFull("char_1", new File([FULL_A], "a.png", { type: "image/png" }));
		let onDisk = await readFile(join(dataRoot, CHARS, "char_1", "avatar-full.png"));
		expect(onDisk).toEqual(Buffer.from(FULL_A));

		// Second write with different bytes + different length — must overwrite, not append/no-op.
		await service.writeCharacterAvatarFull("char_1", new File([FULL_B], "b.png", { type: "image/png" }));
		onDisk = await readFile(join(dataRoot, CHARS, "char_1", "avatar-full.png"));
		expect(onDisk).toEqual(Buffer.from(FULL_B));
		expect(onDisk.length).toBe(FULL_B.length);
	});

	test("serveCharacterAvatarFull returns the SECOND bytes after overwrite", async () => {
		const { service } = await setup();
		await service.writeCharacterAvatarFull("char_1", new File([FULL_A], "a.png", { type: "image/png" }));
		await service.writeCharacterAvatarFull("char_1", new File([FULL_B], "b.png", { type: "image/png" }));
		const res = await service.serveCharacterAvatarFull("char_1", "png");
		expect(res).not.toBeNull();
		expect(new Uint8Array(await res!.arrayBuffer())).toEqual(FULL_B);
	});

	test("writeCharacterAvatarFull and writeCharacterAvatar are independent leaves", async () => {
		// The crop (avatar.png) and full (avatar-full.png) must not alias each other.
		const { dataRoot, service } = await setup();
		await service.writeCharacterAvatar("char_1", new File([PNG_BYTES], "crop.png", { type: "image/png" }));
		await service.writeCharacterAvatarFull("char_1", new File([FULL_B], "full.png", { type: "image/png" }));
		const crop = await readFile(join(dataRoot, CHARS, "char_1", "avatar.png"));
		const full = await readFile(join(dataRoot, CHARS, "char_1", "avatar-full.png"));
		expect(crop).toEqual(Buffer.from(PNG_BYTES));
		expect(full).toEqual(Buffer.from(FULL_B));
	});
});

describe("AssetService character media gallery (A4)", () => {
	test("writeGalleryImage writes {charId}/gallery/{rowId}.{ext} and returns {ext, mimeType}", async () => {
		const { dataRoot, service } = await setup();
		const result = await service.writeGalleryImage("char_1", "row_7", new File([PNG_BYTES], "p.png", { type: "image/png" }));
		expect(result).toEqual({ ext: "png", mimeType: "image/png" });
		const onDisk = await readFile(join(dataRoot, CHARS, "char_1", "gallery", "row_7.png"));
		expect(onDisk).toEqual(Buffer.from(PNG_BYTES));
	});

	test("writeGalleryImage rejects unsupported mime", async () => {
		const { service } = await setup();
		await expect(
			service.writeGalleryImage("char_1", "row_1", new File([new Uint8Array(1)], "a.bmp", { type: "image/bmp" })),
		).rejects.toThrow(/Unsupported image type/);
	});

	test("serveGalleryImage returns bytes + Content-Type; null when wrong ext / missing", async () => {
		const { service } = await setup();
		await service.writeGalleryImage("char_1", "row_1", new File([WEBP_BYTES], "a.webp", { type: "image/webp" }));

		const res = await service.serveGalleryImage("char_1", "row_1", "webp");
		expect(res).not.toBeNull();
		expect(res!.headers.get("Content-Type")).toBe("image/webp");
		expect(new Uint8Array(await res!.arrayBuffer())).toEqual(WEBP_BYTES);

		// wrong ext → file not found → null (no serve-time probing)
		expect(await service.serveGalleryImage("char_1", "row_1", "png")).toBeNull();
		// unknown row → null
		expect(await service.serveGalleryImage("char_1", "row_missing", "webp")).toBeNull();
	});

	test("loadGalleryImageBuffer round-trips a Buffer (for vision describe)", async () => {
		const { service } = await setup();
		await service.writeGalleryImage("char_1", "row_1", new File([PNG_BYTES], "a.png", { type: "image/png" }));
		const buf = await service.loadGalleryImageBuffer("char_1", "row_1", "png");
		expect(buf).not.toBeNull();
		expect(new Uint8Array(buf!)).toEqual(PNG_BYTES);
		expect(await service.loadGalleryImageBuffer("char_1", "row_1", "gif")).toBeNull();
	});

	test("deleteGalleryImage removes the single leaf and leaves siblings; no-op when missing", async () => {
		const { dataRoot, service } = await setup();
		await service.writeGalleryImage("char_1", "row_1", new File([PNG_BYTES], "a.png", { type: "image/png" }));
		await service.writeGalleryImage("char_1", "row_2", new File([WEBP_BYTES], "b.webp", { type: "image/webp" }));

		await service.deleteGalleryImage("char_1", "row_1", "png");

		// targeted leaf gone
		await expect(readFile(join(dataRoot, CHARS, "char_1", "gallery", "row_1.png"))).rejects.toThrow();
		// sibling untouched
		const sibling = await readFile(join(dataRoot, CHARS, "char_1", "gallery", "row_2.webp"));
		expect(sibling).toEqual(Buffer.from(WEBP_BYTES));

		// no-op when already missing
		await expect(service.deleteGalleryImage("char_1", "row_1", "png")).resolves.toBeUndefined();
		// no-op when wrong ext (file not present at that path)
		await expect(service.deleteGalleryImage("char_1", "row_2", "png")).resolves.toBeUndefined();
	});

	test("gallery methods throw / no-op when contentStore is unset (bare helper)", async () => {
		const { assetsDir } = await setup();
		const bare = new AssetService(assetsDir); // no contentStore
		await expect(
			bare.writeGalleryImage("c1", "row_1", new File([PNG_BYTES], "a.png", { type: "image/png" })),
		).rejects.toThrow(/folder storage/);
		expect(await bare.serveGalleryImage("c1", "row_1", "png")).toBeNull();
		expect(await bare.loadGalleryImageBuffer("c1", "row_1", "png")).toBeNull();
		// delete is a silent no-op (consistent with avatar serve/load)
		await expect(bare.deleteGalleryImage("c1", "row_1", "png")).resolves.toBeUndefined();
	});
});
