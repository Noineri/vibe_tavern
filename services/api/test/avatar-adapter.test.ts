import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, STORAGE_FOLDERS, type StoreContainer } from "@vibe-tavern/db";
import { AssetService } from "../src/domain/asset/asset-service.js";
import { CharacterAdapter } from "../src/api/adapters/character-adapter.js";
import { PersonaAdapter } from "../src/api/adapters/persona-adapter.js";
import type { CharacterRuntimeApi, PersonaRuntimeApi } from "../src/api/contract/runtime-api.js";

const CHARS = STORAGE_FOLDERS.characters;
const PERSONAS = STORAGE_FOLDERS.personas;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Minimal sessionRuntime stub — avatar methods don't call into it.
const noopSession = {} as never;

async function setup() {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-c1-adapter-"));
	await mkdir(join(dataRoot, "assets"), { recursive: true });
	const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const assetService = new AssetService(join(dataRoot, "assets"), stores.content);
	const characters = new CharacterAdapter(noopSession, stores, assetService) as CharacterRuntimeApi;
	const personas = new PersonaAdapter(noopSession, stores, assetService) as PersonaRuntimeApi;
	return { dataRoot, stores, assetService, characters, personas };
}

describe("C1 avatar adapter: character", () => {
	test("upload writes {id}/avatar.{ext}, sets avatarExt, clears avatarAssetId", async () => {
		const { dataRoot, stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria", avatarAssetId: "asset_old1" });

	const res = await characters.uploadCharacterAvatar(char.id, new File([PNG], "a.png", { type: "image/png" }));
	expect(res).toEqual({ avatarExt: "png", avatarFullExt: null });

		// file on disk
		const bytes = await readFile(join(dataRoot, CHARS, char.id, "avatar.png"));
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

		const res = await characters.uploadCharacterAvatar(
			char.id,
			new File([PNG], "crop.png", { type: "image/png" }),
			new File([FULL], "full.png", { type: "image/png" }),
		);
		expect(res).toEqual({ avatarExt: "png", avatarFullExt: "png" });

		// thumbnail
		expect(new Uint8Array(await readFile(join(dataRoot, CHARS, char.id, "avatar.png")))).toEqual(PNG);
		// full / uncropped original
		expect(new Uint8Array(await readFile(join(dataRoot, CHARS, char.id, "avatar-full.png")))).toEqual(FULL);

		const row = await stores.characters.getById(char.id);
		expect(row?.avatarExt).toBe("png");
		expect(row?.avatarFullExt).toBe("png");
	});

	test("upload does NOT rewrite {id}/profile.md (point update only)", async () => {
		const { dataRoot, stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria", description: "original" });
		const profilePath = join(dataRoot, CHARS, char.id, "profile.md");
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
		await writeFile(join(dataRoot, "assets", `${assetId}.png`), PNG);
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

		const bytes = await readFile(join(dataRoot, PERSONAS, persona.id, "avatar.png"));
		expect(new Uint8Array(bytes)).toEqual(PNG);

		expect((await stores.personas.getById(persona.id))?.avatarExt).toBe("png");

		const served = await personas.servePersonaAvatar(persona.id);
		expect(served).not.toBeNull();
		expect(new Uint8Array(await served!.arrayBuffer())).toEqual(PNG);
	});

	test("serve returns null when no avatar", async () => {
		const { stores, personas } = await setup();
		const persona = await stores.personas.create({ name: "User" });
		expect(await personas.servePersonaAvatar(persona.id)).toBeNull();
	});
});
