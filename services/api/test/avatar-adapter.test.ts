import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, STORAGE_FOLDERS, type StoreContainer } from "@vibe-tavern/db";
import { AssetService } from "../src/domain/asset/asset-service.js";
import { CharacterAdapter } from "../src/api/adapters/character-adapter.js";
import { PersonaAdapter } from "../src/api/adapters/persona-adapter.js";
import type { CharacterRuntimeApi, PersonaRuntimeApi } from "../src/api/contract/runtime-api.js";
import { minimalPng } from "./image-bytes.js";

const CHARS = STORAGE_FOLDERS.characters;
const PERSONAS = STORAGE_FOLDERS.personas;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Minimal sessionRuntime stub — avatar methods don't call into it.
const noopSession = {} as never;

async function setup() {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-c1-adapter-"));
	await mkdir(join(dataRoot, "assets"), { recursive: true });
	const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const assetService = new AssetService(
		join(dataRoot, "assets"),
		stores.content,
		(id) => stores.characters.resolveFolderName(id),
	);
	const characters = new CharacterAdapter(noopSession, stores, assetService) as CharacterRuntimeApi;
	const personas = new PersonaAdapter(noopSession, stores, assetService) as PersonaRuntimeApi;
	return { dataRoot, stores, assetService, characters, personas };
}

describe("C1 avatar adapter: character", () => {
	test("upload writes {id}/avatar.{ext}, sets avatarExt, clears avatarAssetId", async () => {
		const { dataRoot, stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria", avatarAssetId: "asset_old1" });
		const dir = await stores.characters.resolveFolderName(char.id);

	const res = await characters.uploadCharacterAvatar(char.id, new File([PNG], "a.png", { type: "image/png" }));
	expect(res).toEqual({ avatarExt: "png", avatarFullExt: null });

		// file on disk
		const bytes = Buffer.from(await Bun.file(join(dataRoot, CHARS, dir, "avatar.png")).arrayBuffer());
		expect(new Uint8Array(bytes)).toEqual(PNG);

		// DB columns flipped
		const row = await stores.characters.getById(char.id);
		expect(row?.avatarExt).toBe("png");
		expect(row?.avatarFullExt).toBeNull();
		expect(row?.avatarAssetId).toBeNull();
	});

	test("upload with full writes {id}/avatar-full.{ext} alongside the thumbnail", async () => {
		const { dataRoot, stores, characters } = await setup();
		const FULL = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]);
		const char = await stores.characters.create({ name: "Aria" });
		const dir = await stores.characters.resolveFolderName(char.id);

		const res = await characters.uploadCharacterAvatar(
			char.id,
			new File([PNG], "crop.png", { type: "image/png" }),
			new File([FULL], "full.png", { type: "image/png" }),
		);
		expect(res).toEqual({ avatarExt: "png", avatarFullExt: "png" });

		// thumbnail
		expect(new Uint8Array(Buffer.from(await Bun.file(join(dataRoot, CHARS, dir, "avatar.png")).arrayBuffer()))).toEqual(PNG);
		// full / uncropped original
		expect(new Uint8Array(Buffer.from(await Bun.file(join(dataRoot, CHARS, dir, "avatar-full.png")).arrayBuffer()))).toEqual(FULL);

		const row = await stores.characters.getById(char.id);
		expect(row?.avatarExt).toBe("png");
		expect(row?.avatarFullExt).toBe("png");
	});

	test("LB-1B: uploading a large real PNG without full keeps the ORIGINAL in avatar-full and stores a 512 webp thumbnail", async () => {
		const { dataRoot, stores, characters } = await setup();
		const original = minimalPng(600, 600, [10, 200, 120]);
		const char = await stores.characters.create({ name: "Big" });
		const dir = await stores.characters.resolveFolderName(char.id);

		const res = await characters.uploadCharacterAvatar(char.id, new File([original], "crop.png", { type: "image/png" }));
		expect(res).toEqual({ avatarExt: "webp", avatarFullExt: "png" });

		// Thumbnail slot: normalized ≤ 512 webp.
		const thumbBytes = new Uint8Array(await Bun.file(join(dataRoot, CHARS, dir, "avatar.webp")).arrayBuffer());
		const meta = await new Bun.Image(thumbBytes).metadata();
		expect(meta.format).toBe("webp");
		expect(meta.width).toBe(512);
		expect(meta.height).toBe(512);

		// Full slot: the ORIGINAL bytes, byte-for-byte — the card PNG export
		// reads this slot (preferFull → /avatar/full), so exports keep full
		// resolution even though the thumbnail was shrunk.
		const fullBytes = new Uint8Array(await Bun.file(join(dataRoot, CHARS, dir, "avatar-full.png")).arrayBuffer());
		expect(fullBytes).toEqual(original);

		const row = await stores.characters.getById(char.id);
		expect(row?.avatarExt).toBe("webp");
		expect(row?.avatarFullExt).toBe("png");

		// Serve contract: the full slot answers with the original PNG, the
		// thumbnail slot with the shrunk webp (both content-types correct).
		const fullRes = await characters.serveCharacterAvatarFull(char.id);
		expect(fullRes!.headers.get("Content-Type")).toBe("image/png");
		expect(new Uint8Array(await fullRes!.arrayBuffer())).toEqual(original);
		const thumbRes = await characters.serveCharacterAvatar(char.id);
		expect(thumbRes!.headers.get("Content-Type")).toBe("image/webp");
		const servedMeta = await new Bun.Image(new Uint8Array(await thumbRes!.arrayBuffer())).metadata();
		expect(servedMeta.width).toBe(512);
	});

	test("LB-1B: a re-upload that renames the leaf removes the stale avatar.{oldExt} file", async () => {
		const { dataRoot, stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Swap" });
		const dir = await stores.characters.resolveFolderName(char.id);

		// Corrupt PNG → normalizer fallback → avatar.png.
		await characters.uploadCharacterAvatar(char.id, new File([PNG], "a.png", { type: "image/png" }));
		expect(await Bun.file(join(dataRoot, CHARS, dir, "avatar.png")).exists()).toBe(true);

		// Real PNG → avatar.webp; the stale avatar.png is gone.
		const res = await characters.uploadCharacterAvatar(char.id, new File([minimalPng(700, 500)], "b.png", { type: "image/png" }));
		expect(res.avatarExt).toBe("webp");
		expect(await Bun.file(join(dataRoot, CHARS, dir, "avatar.png")).exists()).toBe(false);
		expect(await Bun.file(join(dataRoot, CHARS, dir, "avatar.webp")).exists()).toBe(true);
	});

	test("LB-1B follow-up: character upload deletes the stale avatar.png AFTER the store points at the new ext", async () => {
		const { dataRoot, stores, characters } = await setup();
		const prior = minimalPng(500, 500, [3, 7, 11]);
		const char = await stores.characters.create({ name: "Order", avatarExt: "png" });
		const dir = await stores.characters.resolveFolderName(char.id);
		await stores.content.writeBinary(CHARS, dir, "avatar.png", prior);

		// Instance-local patch (test-scoped container, nothing global): capture
		// the DB avatarExt at the moment the stale avatar.png delete fires.
		const avatarExtAtDelete: string[] = [];
		const realDelete = stores.content.deleteBinary.bind(stores.content);
		const realGet = stores.characters.getById.bind(stores.characters);
		stores.content.deleteBinary = async (folder, entity, leaf) => {
			if (leaf === "avatar.png") {
				const row = await realGet(char.id);
				avatarExtAtDelete.push(row?.avatarExt ?? "<null>");
			}
			return realDelete(folder, entity, leaf);
		};

		const res = await characters.uploadCharacterAvatar(char.id, new File([minimalPng(600, 600)], "c.png", { type: "image/png" }));
		expect(res.avatarExt).toBe("webp");
		// The store was updated BEFORE the file delete — a crash between the two
		// can no longer leave a 404-ing avatar.
		expect(avatarExtAtDelete).toEqual(["webp"]);
		expect(await Bun.file(join(dataRoot, CHARS, dir, "avatar.png")).exists()).toBe(false);
		expect(await Bun.file(join(dataRoot, CHARS, dir, "avatar.webp")).exists()).toBe(true);
	});

	test("LB-1B follow-up: gallery re-crop deletes the stale leaf AFTER the store update too", async () => {
		const { dataRoot, stores, assetService, characters } = await setup();
		const prior = minimalPng(500, 500, [13, 17, 19]);
		const char = await stores.characters.create({ name: "Reorder", avatarExt: "png" });
		const dir = await stores.characters.resolveFolderName(char.id);
		await stores.content.writeBinary(CHARS, dir, "avatar.png", prior);
		// Gallery source row carrying a big real PNG.
		const rowId = stores.characterAssets.nextId();
		const source = minimalPng(700, 700, [23, 29, 31]);
		await assetService.writeGalleryImage(char.id, rowId, new File([source], "g.png", { type: "image/png" }));
		await stores.characterAssets.create({ id: rowId, characterId: char.id, ext: "png", mimeType: "image/png", order: 0 });

		const avatarExtAtDelete: string[] = [];
		const realDelete = stores.content.deleteBinary.bind(stores.content);
		const realGet = stores.characters.getById.bind(stores.characters);
		stores.content.deleteBinary = async (folder, entity, leaf) => {
			if (leaf === "avatar.png") {
				const row = await realGet(char.id);
				avatarExtAtDelete.push(row?.avatarExt ?? "<null>");
			}
			return realDelete(folder, entity, leaf);
		};

		await characters.setAvatarFromGallery(char.id, rowId, new File([minimalPng(600, 600)], "crop.png", { type: "image/png" }), "{}");
		expect(avatarExtAtDelete).toEqual(["webp"]);
		expect(await Bun.file(join(dataRoot, CHARS, dir, "avatar.png")).exists()).toBe(false);
		expect(await Bun.file(join(dataRoot, CHARS, dir, "avatar.webp")).exists()).toBe(true);
	});

	test("LB-1B follow-up: a stale-delete failure is logged and never fails the upload", async () => {
		const { dataRoot, stores, characters } = await setup();
		const prior = minimalPng(400, 400, [37, 41, 43]);
		const char = await stores.characters.create({ name: "Orphan", avatarExt: "png" });
		const dir = await stores.characters.resolveFolderName(char.id);
		await stores.content.writeBinary(CHARS, dir, "avatar.png", prior);

		const realDelete = stores.content.deleteBinary.bind(stores.content);
		stores.content.deleteBinary = async (folder, entity, leaf) => {
			if (leaf === "avatar.png") throw new Error("disk on fire");
			return realDelete(folder, entity, leaf);
		};

		const res = await characters.uploadCharacterAvatar(char.id, new File([minimalPng(600, 600)], "c.png", { type: "image/png" }));
		// Upload succeeded, DB updated — the orphan avatar.png survives.
		expect(res.avatarExt).toBe("webp");
		expect((await stores.characters.getById(char.id))?.avatarExt).toBe("webp");
		expect(await Bun.file(join(dataRoot, CHARS, dir, "avatar.png")).exists()).toBe(true);
	});

	test("upload does NOT rewrite {id}/profile.md (point update only)", async () => {
		const { dataRoot, stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria", description: "original" });
		const dir = await stores.characters.resolveFolderName(char.id);
		const profilePath = join(dataRoot, CHARS, dir, "profile.md");
		const profileMtimeBefore = (await stat(profilePath)).mtimeMs;

		// small delay so mtime resolution can't mask a rewrite
		await new Promise((r) => setTimeout(r, 30));
		await characters.uploadCharacterAvatar(char.id, new File([PNG], "a.png", { type: "image/png" }));

		const profileMtimeAfter = (await stat(profilePath)).mtimeMs;
		expect(profileMtimeAfter).toBe(profileMtimeBefore); // untouched
	});

	test("serve returns folder avatar bytes + content-type", async () => {
		const { characters, stores } = await setup();
		const char = await stores.characters.create({ name: "Aria" });
		await characters.uploadCharacterAvatar(char.id, new File([PNG], "a.png", { type: "image/png" }));

		const res = await characters.serveCharacterAvatar(char.id);
		expect(res).not.toBeNull();
		expect(res!.headers.get("Content-Type")).toBe("image/png");
		expect(new Uint8Array(await res!.arrayBuffer())).toEqual(PNG);
	});

	test("serve works after B4 lazy-migrates a legacy flat avatar into the folder", async () => {
		const { dataRoot, stores, characters } = await setup();
		// seed a legacy flat asset and create a character pointing at it
		const assetId = "asset_legacy_1";
		await Bun.write(join(dataRoot, "assets", `${assetId}.png`), PNG);
		const char = await stores.characters.create({ name: "Aria", avatarAssetId: assetId });

		// serveCharacterAvatar → getById → B4 copies the flat asset into
		// {id}/avatar.png and flips avatarExt; the adapter then serves the
		// folder-resident bytes. Either way the caller gets the bytes back.
		const res = await characters.serveCharacterAvatar(char.id);
		expect(res).not.toBeNull();
		expect(res!.headers.get("Content-Type")).toBe("image/png");
		expect(new Uint8Array(await res!.arrayBuffer())).toEqual(PNG);
	});

	test("serve returns null when no avatar at all", async () => {
		const { stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria" });
		expect(await characters.serveCharacterAvatar(char.id)).toBeNull();
	});

	test("serve returns null when character missing", async () => {
		const { characters } = await setup();
		expect(await characters.serveCharacterAvatar("char_nope")).toBeNull();
	});
});

describe("C1 avatar adapter: persona", () => {
	test("upload + serve round-trip", async () => {
		const { dataRoot, stores, personas } = await setup();
		const persona = await stores.personas.create({ name: "User" });

		const res = await personas.uploadPersonaAvatar(persona.id, new File([PNG], "a.png", { type: "image/png" }));
		expect(res).toEqual({ avatarExt: "png", avatarFullExt: null });

		const bytes = Buffer.from(await Bun.file(join(dataRoot, PERSONAS, persona.id, "avatar.png")).arrayBuffer());
		expect(new Uint8Array(bytes)).toEqual(PNG);

		expect((await stores.personas.getById(persona.id))?.avatarExt).toBe("png");

		const served = await personas.servePersonaAvatar(persona.id);
		expect(served).not.toBeNull();
		expect(new Uint8Array(await served!.arrayBuffer())).toEqual(PNG);
	});

	test("LB-1B: persona upload of a large real PNG without full preserves the original + a webp thumb", async () => {
		const { dataRoot, stores, personas } = await setup();
		const original = minimalPng(600, 600, [190, 40, 90]);
		const persona = await stores.personas.create({ name: "BigUser" });

		const res = await personas.uploadPersonaAvatar(persona.id, new File([original], "crop.png", { type: "image/png" }));
		expect(res).toEqual({ avatarExt: "webp", avatarFullExt: "png" });

		const thumbBytes = new Uint8Array(await Bun.file(join(dataRoot, PERSONAS, persona.id, "avatar.webp")).arrayBuffer());
		expect((await new Bun.Image(thumbBytes).metadata()).width).toBe(512);
		const fullBytes = new Uint8Array(await Bun.file(join(dataRoot, PERSONAS, persona.id, "avatar-full.png")).arrayBuffer());
		expect(fullBytes).toEqual(original);

		const row = await stores.personas.getById(persona.id);
		expect(row?.avatarExt).toBe("webp");
		expect(row?.avatarFullExt).toBe("png");
	});

	test("LB-1B follow-up: persona upload deletes the stale avatar.png AFTER the store update", async () => {
		const { dataRoot, stores, personas } = await setup();
		const prior = minimalPng(500, 500, [47, 53, 59]);
		const persona = await stores.personas.create({ name: "OrderUser", avatarExt: "png" });
		await stores.content.writeBinary(PERSONAS, persona.id, "avatar.png", prior);

		const avatarExtAtDelete: string[] = [];
		const realDelete = stores.content.deleteBinary.bind(stores.content);
		const realGet = stores.personas.getById.bind(stores.personas);
		stores.content.deleteBinary = async (folder, entity, leaf) => {
			if (leaf === "avatar.png") {
				const row = await realGet(persona.id);
				avatarExtAtDelete.push(row?.avatarExt ?? "<null>");
			}
			return realDelete(folder, entity, leaf);
		};

		const res = await personas.uploadPersonaAvatar(persona.id, new File([minimalPng(600, 600)], "c.png", { type: "image/png" }));
		expect(res.avatarExt).toBe("webp");
		expect(avatarExtAtDelete).toEqual(["webp"]);
		expect(await Bun.file(join(dataRoot, PERSONAS, persona.id, "avatar.png")).exists()).toBe(false);
		expect(await Bun.file(join(dataRoot, PERSONAS, persona.id, "avatar.webp")).exists()).toBe(true);
	});

	test("serve returns null when no avatar", async () => {
		const { stores, personas } = await setup();
		const persona = await stores.personas.create({ name: "User" });
		expect(await personas.servePersonaAvatar(persona.id)).toBeNull();
	});
});
