import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, STORAGE_FOLDERS, type StoreContainer } from "@vibe-tavern/db";
import { AssetService } from "../src/domain/asset/asset-service.js";
import { CharacterAdapter } from "../src/api/adapters/character-adapter.js";
import type { CharacterRuntimeApi } from "../src/api/contract/runtime-api.js";

const CHARS = STORAGE_FOLDERS.characters;
const noopSession = {} as never;

// Distinct, recognizable image-byte signatures so we can tell which image is
// on disk / served at a glance. Each is a valid-ish PNG header + a payload tag.
const TAG = (b: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, b, b, b, b]);
const IMG_A = TAG(0xaa); // gallery image A
const IMG_B = TAG(0xbb); // gallery image B
const IMG_C = TAG(0xcc); // gallery image C
const CROP_A = TAG(0xa1); // crop of A (thumbnail bytes)
const CROP_B = TAG(0xb2); // crop of B
const DIRECT_X = TAG(0xdd); // direct-upload crop
const DIRECT_X_FULL = TAG(0xde); // direct-upload full
const DIRECT_Y = TAG(0xee); // second direct-upload crop
const DIRECT_Y_FULL = TAG(0xef); // second direct-upload full

async function setup() {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-avatar-repro-"));
	await mkdir(join(dataRoot, "assets"), { recursive: true });
	const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const assetService = new AssetService(join(dataRoot, "assets"), stores.content);
	const characters = new CharacterAdapter(noopSession, stores, assetService) as CharacterRuntimeApi;
	return { dataRoot, stores, assetService, characters };
}

/** Add a gallery row + write its image bytes. Returns the asset row id. */
async function addGalleryImage(
	stores: StoreContainer,
	assetService: AssetService,
	characterId: string,
	bytes: Uint8Array,
	order: number,
): Promise<string> {
	const rowId = stores.characterAssets.nextId();
	await assetService.writeGalleryImage(characterId, rowId, new File([bytes], `g.${order}.png`, { type: "image/png" }));
	await stores.characterAssets.create({
		id: rowId,
		characterId,
		ext: "png",
		mimeType: "image/png",
		order,
	});
	return rowId;
}

const diskFull = async (dataRoot: string, charId: string) => readFile(join(dataRoot, CHARS, charId, "avatar-full.png"));
const diskThumb = async (dataRoot: string, charId: string) => readFile(join(dataRoot, CHARS, charId, "avatar.png"));

describe("Bug #2/#3 adapter-level repro: gallery avatar swap + direct upload", () => {
	test("gallery A→B: each swap writes the NEW full to disk, bumps updatedAt, serves new bytes", async () => {
		const { dataRoot, stores, assetService, characters } = await setup();
		const char = await stores.characters.create({ name: "Kiran" });
		const cid = char.id;

		// 3 gallery images, like the user uploaded.
		const idA = await addGalleryImage(stores, assetService, cid, IMG_A, 0);
		await addGalleryImage(stores, assetService, cid, IMG_B, 1);
		await addGalleryImage(stores, assetService, cid, IMG_C, 2);
		const galleryCountBefore = (await stores.characterAssets.listByCharacter(cid)).length;
		expect(galleryCountBefore).toBe(3);

		// ── Swap 1: set avatar from gallery image A.
		const r1 = await characters.setAvatarFromGallery(cid, idA, new File([CROP_A], "crop.png", { type: "image/png" }), "{}");
		expect(r1.avatarFullExt).toBe("png");
		const row1 = await stores.characters.getById(cid as never);
		const t1 = row1!.updatedAt;

		// disk full must be image A's bytes (the source gallery image is copied as the full).
		expect(new Uint8Array(await diskFull(dataRoot, cid))).toEqual(IMG_A);
		// thumbnail is the crop.
		expect(new Uint8Array(await diskThumb(dataRoot, cid))).toEqual(CROP_A);
		// serve-full returns image A.
		const s1 = await characters.serveCharacterAvatarFull(cid);
		expect(new Uint8Array(await s1!.arrayBuffer())).toEqual(IMG_A);

		// ── Swap 2: swap to gallery image B. THE BUG: user reports nothing updates.
		const idB = (await stores.characterAssets.listByCharacter(cid)).find((r) => r.order === 1)!.id;
		await new Promise((r) => setTimeout(r, 20)); // ensure updatedAt ticks forward
		const r2 = await characters.setAvatarFromGallery(cid, idB, new File([CROP_B], "crop.png", { type: "image/png" }), "{}");
		const row2 = await stores.characters.getById(cid as never);
		const t2 = row2!.updatedAt;

		// updatedAt MUST advance (the frontend cache-bust depends on this).
		expect(Date.parse(t2)).toBeGreaterThan(Date.parse(t1));

		// disk full MUST now be image B (overwrite), NOT image A.
		expect(new Uint8Array(await diskFull(dataRoot, cid))).toEqual(IMG_B);
		// thumbnail is crop B.
		expect(new Uint8Array(await diskThumb(dataRoot, cid))).toEqual(CROP_B);
		// serve MUST return image B's bytes — the browser would fetch this after the cache-bust.
		const s2 = await characters.serveCharacterAvatarFull(cid);
		expect(new Uint8Array(await s2!.arrayBuffer())).toEqual(IMG_B);
	});

	test("Bug #3 FIXED: gallery A→B does NOT duplicate A (salvage skipped, prior is gallery-derived)", async () => {
		// The current avatar (A) was set from the gallery, so its bytes already
		// live in the gallery under row idA. Salvaging it on the A→B swap would
		// create a duplicate of A. With the avatarSourceAssetId gate, salvage is
		// skipped and the gallery count stays at 2 (A + B), not 3.
		const { dataRoot, stores, assetService, characters } = await setup();
		const char = await stores.characters.create({ name: "Kiran" });
		const cid = char.id;
		const idA = await addGalleryImage(stores, assetService, cid, IMG_A, 0);
		const idB = await addGalleryImage(stores, assetService, cid, IMG_B, 1);

		const r1 = await characters.setAvatarFromGallery(cid, idA, new File([CROP_A], "c.png", { type: "image/png" }), "{}");
		expect((await stores.characterAssets.listByCharacter(cid)).length).toBe(2); // salvage skipped: no prior avatar yet
		expect(r1.salvagedAssetId).toBeNull();
		// The character now records that its avatar came from idA.
		expect((await stores.characters.getById(cid))?.avatarSourceAssetId).toBe(idA);

		const r2 = await characters.setAvatarFromGallery(cid, idB, new File([CROP_B], "c.png", { type: "image/png" }), "{}");
		// FIXED: salvage is skipped because the prior avatar (A) is gallery-derived
		// (avatarSourceAssetId === idA !== null). No duplicate of A is created.
		expect((await stores.characterAssets.listByCharacter(cid)).length).toBe(2);
		expect(r2.salvagedAssetId).toBeNull();
		// avatarSourceAssetId now points at the new source row idB.
		expect((await stores.characters.getById(cid))?.avatarSourceAssetId).toBe(idB);
		expect(new Uint8Array(await diskFull(dataRoot, cid))).toEqual(IMG_B);
	});

	test("Bug #3 salvage still fires for a DIRECT-upload avatar (gating preserves this path)", async () => {
		// The gate must NOT disable salvage entirely: a direct-upload avatar's
		// bytes are NOT in the gallery, so the first gallery swap MUST salvage it
		// (otherwise the user loses their uploaded avatar with no recovery).
		const { dataRoot, stores, assetService, characters } = await setup();
		const char = await stores.characters.create({ name: "Kiran" });
		const cid = char.id;
		const idB = await addGalleryImage(stores, assetService, cid, IMG_B, 0);

		// Direct upload first: avatarSourceAssetId cleared to null.
		await characters.uploadCharacterAvatar(
			cid,
			new File([DIRECT_X], "crop.png", { type: "image/png" }),
			new File([DIRECT_X_FULL], "full.png", { type: "image/png" }),
		);
		expect((await stores.characters.getById(cid))?.avatarSourceAssetId).toBeNull();
		expect((await stores.characterAssets.listByCharacter(cid)).length).toBe(1); // only gallery B

		// Swap to gallery B: the direct-upload avatar (DIRECT_X_FULL) MUST be
		// salvaged into the gallery because it's not there yet.
		const r = await characters.setAvatarFromGallery(cid, idB, new File([CROP_B], "c.png", { type: "image/png" }), "{}");
		expect(r.salvagedAssetId).not.toBeNull();
		const rows = await stores.characterAssets.listByCharacter(cid);
		expect(rows.length).toBe(2); // gallery B + salvaged direct-upload
		// The salvaged row carries the direct-upload full bytes.
		const salvagedRow = rows.find((row) => row.id === r.salvagedAssetId)!;
		const salvagedBytes = await assetService.loadGalleryImageBuffer(cid, salvagedRow.id, salvagedRow.ext);
		expect(new Uint8Array(salvagedBytes!)).toEqual(DIRECT_X_FULL);
		// avatarSourceAssetId now points at idB.
		expect((await stores.characters.getById(cid))?.avatarSourceAssetId).toBe(idB);
		expect(new Uint8Array(await diskFull(dataRoot, cid))).toEqual(IMG_B);
	});

	test("direct upload twice: second upload overwrites full on disk + serve returns new bytes", async () => {
		// Repro B from the report: direct upload changes crop but not full, survives reload.
		const { dataRoot, stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Kiran" });
		const cid = char.id;

		// First direct upload (crop + full).
		await characters.uploadCharacterAvatar(
			cid,
			new File([DIRECT_X], "crop.png", { type: "image/png" }),
			new File([DIRECT_X_FULL], "full.png", { type: "image/png" }),
		);
		expect(new Uint8Array(await diskThumb(dataRoot, cid))).toEqual(DIRECT_X);
		expect(new Uint8Array(await diskFull(dataRoot, cid))).toEqual(DIRECT_X_FULL);
		const t1 = (await stores.characters.getById(cid as never))!.updatedAt;

		await new Promise((r) => setTimeout(r, 20));
		// Second direct upload — must overwrite BOTH thumb and full.
		await characters.uploadCharacterAvatar(
			cid,
			new File([DIRECT_Y], "crop.png", { type: "image/png" }),
			new File([DIRECT_Y_FULL], "full.png", { type: "image/png" }),
		);
		expect(new Uint8Array(await diskThumb(dataRoot, cid))).toEqual(DIRECT_Y);
		expect(new Uint8Array(await diskFull(dataRoot, cid))).toEqual(DIRECT_Y_FULL);
		const t2 = (await stores.characters.getById(cid as never))!.updatedAt;
		expect(Date.parse(t2)).toBeGreaterThan(Date.parse(t1));

		// Serve returns the SECOND full.
		const s = await characters.serveCharacterAvatarFull(cid);
		expect(new Uint8Array(await s!.arrayBuffer())).toEqual(DIRECT_Y_FULL);
	});
});
