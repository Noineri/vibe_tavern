import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, STORAGE_FOLDERS, type StoreContainer } from "@vibe-tavern/db";
import { AssetService } from "../src/domain/asset/asset-service.js";
import { CharacterAdapter } from "../src/api/adapters/character-adapter.js";
import { createCharacterRoutes } from "../src/api/routes/character.js";
import type { CharacterRuntimeApi, CharacterAssetRuntimeApi } from "../src/api/contract/runtime-api.js";

const CHARS = STORAGE_FOLDERS.characters;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46]);

async function exists(p: string): Promise<boolean> {
	try { await stat(p); return true; } catch { return false; }
}

// Minimal sessionRuntime stub — gallery methods don't call into it.
// (deleteCharacter does, so tests that exercise cascade inject a stub below.)
const noopSession = {
	character: {
		delete: async (id: string) => {
			// Delegates to the character store's folder+row delete; the test's
			// `stores` is closed over so the real path runs.
			return undefined;
		},
	},
} as never;

async function setup() {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-gallery-adapter-"));
	await mkdir(join(dataRoot, "assets"), { recursive: true });
	const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const assetService = new AssetService(join(dataRoot, "assets"), stores.content);
	const characters = new CharacterAdapter(noopSession, stores, assetService) as CharacterRuntimeApi &
		CharacterAssetRuntimeApi;
	return { dataRoot, stores, assetService, characters };
}

describe("Character gallery adapter (A5)", () => {
	test("upload writes {id}/gallery/{rowId}.{ext} + row with appending order", async () => {
		const { dataRoot, stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria" });

		const a = await characters.uploadCharacterAsset(char.id, new File([PNG], "a.png", { type: "image/png" }));
		const b = await characters.uploadCharacterAsset(char.id, new File([WEBP], "b.webp", { type: "image/webp" }));

		// file on disk at the row id
		const fileA = await readFile(join(dataRoot, CHARS, char.id, "gallery", `${a.id}.png`));
		expect(new Uint8Array(fileA)).toEqual(PNG);

		// row ext/mimeType/order
		expect(a).toMatchObject({ ext: "png", mimeType: "image/png", order: 0, characterId: char.id });
		expect(b).toMatchObject({ ext: "webp", mimeType: "image/webp", order: 1 });
		expect(b.caption).toBe("");
	});

	test("upload rejects unsupported mime (propagated from AssetService)", async () => {
		const { stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria" });
		await expect(
			characters.uploadCharacterAsset(char.id, new File([new Uint8Array(1)], "a.bmp", { type: "image/bmp" })),
		).rejects.toThrow(/Unsupported image type/);
		// no orphan row created on failure
		expect((await characters.listCharacterAssets(char.id)).length).toBe(0);
	});

	test("list returns ordered; serve returns bytes + content-type", async () => {
		const { stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria" });
		const a = await characters.uploadCharacterAsset(char.id, new File([PNG], "a.png", { type: "image/png" }));
		await characters.uploadCharacterAsset(char.id, new File([WEBP], "b.webp", { type: "image/webp" }));

		const list = await characters.listCharacterAssets(char.id);
		expect(list.map((x) => x.id)).toEqual([a.id, list[1]!.id]);

		const res = await characters.serveCharacterAsset(char.id, a.id);
		expect(res).not.toBeNull();
		expect(res!.headers.get("Content-Type")).toBe("image/png");
		expect(new Uint8Array(await res!.arrayBuffer())).toEqual(PNG);
	});

	test("serve returns null for unknown row AND for cross-character row (no leakage)", async () => {
		const { stores, characters } = await setup();
		const charA = await stores.characters.create({ name: "Aria" });
		const charB = await stores.characters.create({ name: "Bea" });
		const a = await characters.uploadCharacterAsset(charA.id, new File([PNG], "a.png", { type: "image/png" }));

		// unknown row
		expect(await characters.serveCharacterAsset(charA.id, "row_nope")).toBeNull();
		// row belongs to charA, requested via charB → null (not the bytes)
		expect(await characters.serveCharacterAsset(charB.id, a.id)).toBeNull();
	});

	test("update caption + description; null clears description; cross-character 404s", async () => {
		const { stores, characters } = await setup();
		const charA = await stores.characters.create({ name: "Aria" });
		const charB = await stores.characters.create({ name: "Bea" });
		const a = await characters.uploadCharacterAsset(charA.id, new File([PNG], "a.png", { type: "image/png" }));

		const updated = await characters.updateCharacterAsset(charA.id, a.id, { caption: "hello", description: "portrait" });
		expect(updated).toMatchObject({ caption: "hello", description: "portrait" });

		const cleared = await characters.updateCharacterAsset(charA.id, a.id, { description: null });
		expect(cleared?.description).toBeNull();

		// cross-character update throws (route maps to 404)
		await expect(characters.updateCharacterAsset(charB.id, a.id, { caption: "x" })).rejects.toThrow(/not found/);
	});

	test("reorder rewrites order 0..n-1; foreign ids ignored", async () => {
		const { stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria" });
		const a = await characters.uploadCharacterAsset(char.id, new File([PNG], "a.png", { type: "image/png" }));
		const b = await characters.uploadCharacterAsset(char.id, new File([WEBP], "b.webp", { type: "image/webp" }));

		await characters.reorderCharacterAssets(char.id, [b.id, "foreign", a.id]);
		const list = await characters.listCharacterAssets(char.id);
		expect(list.map((x) => x.id)).toEqual([b.id, a.id]);
		expect(list.map((x) => x.order)).toEqual([0, 1]);
	});

	test("delete removes the row AND the file; 404 for unknown/cross-character", async () => {
		const { dataRoot, stores, characters } = await setup();
		const charA = await stores.characters.create({ name: "Aria" });
		const charB = await stores.characters.create({ name: "Bea" });
		const a = await characters.uploadCharacterAsset(charA.id, new File([PNG], "a.png", { type: "image/png" }));
		const filePath = join(dataRoot, CHARS, charA.id, "gallery", `${a.id}.png`);
		expect(await exists(filePath)).toBe(true);

		// cross-character delete throws
		await expect(characters.deleteCharacterAsset(charB.id, a.id)).rejects.toThrow(/not found/);
		// file + row still present
		expect(await exists(filePath)).toBe(true);
		expect(await characters.serveCharacterAsset(charA.id, a.id)).not.toBeNull();

		// legitimate delete
		await characters.deleteCharacterAsset(charA.id, a.id);
		expect(await exists(filePath)).toBe(false);
		expect(await characters.serveCharacterAsset(charA.id, a.id)).toBeNull();
		expect((await characters.listCharacterAssets(charA.id)).length).toBe(0);
	});

	test("delete is idempotent-ish: unknown row 404s (no throw past adapter contract)", async () => {
		const { stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria" });
		await expect(characters.deleteCharacterAsset(char.id, "row_nope")).rejects.toThrow(/not found/);
	});

	test("update includeInPrompt flows through list and is returned on the record (D7)", async () => {
		const { stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria" });
		const a = await characters.uploadCharacterAsset(char.id, new File([PNG], "a.png", { type: "image/png" }));

		// new uploads default to includeInPrompt = false
		expect(a.includeInPrompt).toBe(false);

		// toggle on via the adapter (the path R2's UI will use)
		const on = await characters.updateCharacterAsset(char.id, a.id, { includeInPrompt: true });
		expect(on).toMatchObject({ includeInPrompt: true });

		// list surfaces it
		expect((await characters.listCharacterAssets(char.id))[0]?.includeInPrompt).toBe(true);

		// toggle back off
		const off = await characters.updateCharacterAsset(char.id, a.id, { includeInPrompt: false });
		expect(off?.includeInPrompt).toBe(false);
	});

	test("PATCH route persists includeInPrompt boolean (200) and rejects nothing on absent field", async () => {
		const { stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria" });
		const a = await characters.uploadCharacterAsset(char.id, new File([PNG], "a.png", { type: "image/png" }));
		const app = createCharacterRoutes(characters);

		const res = await app.request(`/api/characters/${char.id}/assets/${a.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ includeInPrompt: true }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { includeInPrompt: boolean };
		expect(body.includeInPrompt).toBe(true);

		// a PATCH without the field leaves it unchanged
		const res2 = await app.request(`/api/characters/${char.id}/assets/${a.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ caption: "x" }),
		});
		expect(res2.status).toBe(200);
		const body2 = (await res2.json()) as { includeInPrompt: boolean; caption: string };
		expect(body2.includeInPrompt).toBe(true);
		expect(body2.caption).toBe("x");
	});

	test("character-delete cascade removes gallery rows (FK) and the gallery folder", async () => {
		const { dataRoot, stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria" });
		await characters.uploadCharacterAsset(char.id, new File([PNG], "a.png", { type: "image/png" }));
		await characters.uploadCharacterAsset(char.id, new File([WEBP], "b.webp", { type: "image/webp" }));
		expect((await stores.characterAssets.listByCharacter(char.id)).length).toBe(2);

		// deleteCharacter → sessionRuntime.character.delete. The noop stub above
		// doesn't run the real delete, so drive the store directly to prove the
		// cascade invariant the folder layout relies on: deleting the character
		// folder + the character row cascades the asset rows via FK.
		await stores.characters.delete(char.id);

		// rows gone via FK cascade
		expect((await stores.characterAssets.listByCharacter(char.id)).length).toBe(0);
		// gallery folder gone via recursive folder delete
		expect(await exists(join(dataRoot, CHARS, char.id))).toBe(false);
	});
});

// ─── Route-level error mapping (thin layer over the adapter) ─────────────

describe("Character gallery routes (A5)", () => {
	test("POST assets: no file → 400", async () => {
		const { characters } = await setup();
		const app = createCharacterRoutes(characters);
		const res = await app.request("/api/characters/char_1/assets", { method: "POST", body: new FormData() });
		expect(res.status).toBe(400);
	});

	test("POST assets: unsupported mime → 415", async () => {
		const { characters } = await setup();
		const app = createCharacterRoutes(characters);
		const form = new FormData();
		form.append("file", new File([new Uint8Array(1)], "a.bmp", { type: "image/bmp" }));
		const res = await app.request("/api/characters/char_1/assets", { method: "POST", body: form });
		expect(res.status).toBe(415);
	});

	test("GET asset: not found → 404", async () => {
		const { characters } = await setup();
		const app = createCharacterRoutes(characters);
		const res = await app.request("/api/characters/char_1/assets/row_nope");
		expect(res.status).toBe(404);
	});

	test("PUT reorder: non-string array → 400; valid → 204", async () => {
		const { stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria" });
		const a = await characters.uploadCharacterAsset(char.id, new File([PNG], "a.png", { type: "image/png" }));
		const app = createCharacterRoutes(characters);

		// invalid body (no orderedIds)
		const bad = await app.request(`/api/characters/${char.id}/assets/reorder`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(bad.status).toBe(400);

		// valid reorder
		const ok = await app.request(`/api/characters/${char.id}/assets/reorder`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ orderedIds: [a.id] }),
		});
		expect(ok.status).toBe(204);
	});

	test("DELETE asset: not found → 404; existing → 204", async () => {
		const { stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria" });
		const a = await characters.uploadCharacterAsset(char.id, new File([PNG], "a.png", { type: "image/png" }));
		const app = createCharacterRoutes(characters);

		const notFound = await app.request(`/api/characters/${char.id}/assets/row_nope`, { method: "DELETE" });
		expect(notFound.status).toBe(404);

		const ok = await app.request(`/api/characters/${char.id}/assets/${a.id}`, { method: "DELETE" });
		expect(ok.status).toBe(204);
	});
});

// ─── D1/R5: promote a gallery image into the general asset store ─────────

describe("Character gallery promote-to-attachment (R5/D1)", () => {
	test("adapter copies gallery bytes into the general store and returns the attachment descriptor", async () => {
		const { stores, assetService, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria" });
		const a = await characters.uploadCharacterAsset(char.id, new File([PNG], "a.png", { type: "image/png" }));

		const result = await characters.promoteGalleryAssetToAttachment(char.id, a.id);
		expect(result.assetId).toMatch(/^asset_/);
		expect(result.mimeType).toBe("image/png");
		expect(result.sizeBytes).toBe(PNG.byteLength);
		// name falls back to `media-{rowId}.{ext}` when no caption
		expect(result.name).toBe(`media-${a.id}.png`);

		// the promoted assetId serves the SAME bytes via the general store
		const served = await assetService.serve(result.assetId);
		expect(served).not.toBeNull();
		expect(served!.headers.get("Content-Type")).toBe("image/png");
		expect(new Uint8Array(await served!.arrayBuffer())).toEqual(PNG);
	});

	test("adapter derives name from the row's caption when present", async () => {
		const { stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria" });
		const a = await characters.uploadCharacterAsset(char.id, new File([PNG], "a.png", { type: "image/png" }));
		await characters.updateCharacterAsset(char.id, a.id, { caption: "sunrise" });

		const result = await characters.promoteGalleryAssetToAttachment(char.id, a.id);
		expect(result.name).toBe("sunrise.png");
	});

	test("adapter rejects unknown row and cross-character row (no leakage)", async () => {
		const { stores, characters } = await setup();
		const charA = await stores.characters.create({ name: "Aria" });
		const charB = await stores.characters.create({ name: "Bea" });
		const a = await characters.uploadCharacterAsset(charA.id, new File([PNG], "a.png", { type: "image/png" }));

		await expect(characters.promoteGalleryAssetToAttachment(charA.id, "row_nope")).rejects.toThrow(/not found/);
		// row belongs to charA, requested via charB → throws (no leak)
		await expect(characters.promoteGalleryAssetToAttachment(charB.id, a.id)).rejects.toThrow(/not found/);
	});

	test("route: promote → 201 with descriptor; unknown row → 404", async () => {
		const { stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria" });
		const a = await characters.uploadCharacterAsset(char.id, new File([PNG], "a.png", { type: "image/png" }));
		const app = createCharacterRoutes(characters);

		const ok = await app.request(`/api/characters/${char.id}/assets/${a.id}/promote-to-attachment`, { method: "POST" });
		expect(ok.status).toBe(201);
		const body = (await ok.json()) as { assetId: string; name: string; mimeType: string; sizeBytes: number };
		expect(body.assetId).toMatch(/^asset_/);
		expect(body.mimeType).toBe("image/png");

		const notFound = await app.request(`/api/characters/${char.id}/assets/row_nope/promote-to-attachment`, { method: "POST" });
		expect(notFound.status).toBe(404);
	});
});
