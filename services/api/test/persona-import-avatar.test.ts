import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, STORAGE_FOLDERS, type StoreContainer } from "@vibe-tavern/db";
import { AssetService } from "../src/domain/asset/asset-service.js";
import { PersonaAdapter } from "../src/api/adapters/persona-adapter.js";
import type { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import type { PersonaRuntimeApi } from "../src/api/contract/runtime-api.js";
import { minimalPng } from "./image-bytes.js";

const PERSONAS = STORAGE_FOLDERS.personas;

// Minimal sessionRuntime stub — the import path doesn't call into it. Typed
// two-step cast instead of the banned pattern: the hygiene ratchet budgets it.
const noopSession = {} as unknown as SessionRuntime;

async function setup() {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-persona-import-"));
	await mkdir(join(dataRoot, "assets"), { recursive: true });
	const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const assetService = new AssetService(
		join(dataRoot, "assets"),
		stores.content,
		(id) => stores.characters.resolveFolderName(id),
	);
	const personas = new PersonaAdapter(noopSession, stores, assetService) as PersonaRuntimeApi;
	return { dataRoot, stores, assetService, personas };
}

function vtPersonaPayload(overrides: {
	avatarThumb?: { ext: string; bytesBase64: string } | null;
	avatarFull?: { ext: string; bytesBase64: string } | null;
}): Record<string, unknown> {
	return {
		version: 1,
		name: "Imported User",
		description: "desc",
		pronouns: null,
		pronounForms: null,
		avatarDescription: null,
		includeAvatarInPrompt: false,
		defaultForNewChats: false,
		avatarThumb: overrides.avatarThumb ?? null,
		avatarFull: overrides.avatarFull ?? null,
	};
}

describe("persona VT import — avatar normalization (LB-1B)", () => {
	test("a large real PNG thumb (no full) lands as avatar.webp with the ORIGINAL preserved in avatar-full", async () => {
		const { dataRoot, stores, personas } = await setup();
		const original = minimalPng(600, 600, [20, 160, 220]);

		const result = await personas.importPersonas([
			vtPersonaPayload({
				avatarThumb: { ext: "png", bytesBase64: Buffer.from(original).toString("base64") },
			}),
		]);

		// Pre-fix characterization note: the legacy code built the thumb File
		// with type "application/octet-stream", which writePersonaAvatar
		// rejects — the import completed with "Unsupported image type" in
		// errors and NO avatar (verified against the pre-change adapter;
		// fixed in LB-1B by deriving the type from the stored ext).
		expect(result.errors).toEqual([]);
		expect(result.created).toBe(1);

		const list = await stores.personas.listAll();
		const persona = list.find((p) => p.name === "Imported User");
		expect(persona).toBeTruthy();
		expect(persona!.avatarExt).toBe("webp");
		expect(persona!.avatarFullExt).toBe("png");

		const thumbBytes = new Uint8Array(
			await Bun.file(join(dataRoot, PERSONAS, persona!.id, "avatar.webp")).arrayBuffer(),
		);
		const meta = await new Bun.Image(thumbBytes).metadata();
		expect(meta.format).toBe("webp");
		expect(meta.width).toBe(512);

		const fullBytes = new Uint8Array(
			await Bun.file(join(dataRoot, PERSONAS, persona!.id, "avatar-full.png")).arrayBuffer(),
		);
		expect(fullBytes).toEqual(original);
	});

	test("an already-small webp thumb passes through untouched — no avatar-full is invented", async () => {
		const { dataRoot, stores, personas } = await setup();
		const smallWebp = await new Bun.Image(minimalPng(300, 300)).webp({ quality: 85 }).bytes();

		const result = await personas.importPersonas([
			vtPersonaPayload({
				avatarThumb: { ext: "webp", bytesBase64: Buffer.from(smallWebp).toString("base64") },
			}),
		]);
		expect(result.errors).toEqual([]);

		const list = await stores.personas.listAll();
		const persona = list.find((p) => p.name === "Imported User");
		expect(persona!.avatarExt).toBe("webp");
		// Unchanged ⇒ the thumbnail IS the original ⇒ no full written.
		expect(persona!.avatarFullExt).toBeNull();
		const onDisk = new Uint8Array(
			await Bun.file(join(dataRoot, PERSONAS, persona!.id, "avatar.webp")).arrayBuffer(),
		);
		expect(onDisk).toEqual(new Uint8Array(smallWebp));
		expect(await Bun.file(join(dataRoot, PERSONAS, persona!.id, "avatar-full.webp")).exists()).toBe(false);
	});

	test("an explicit avatarFull wins over thumb-derived preservation", async () => {
		const { dataRoot, stores, personas } = await setup();
		const thumbOriginal = minimalPng(600, 600, [90, 90, 20]);
		const exportedFull = minimalPng(400, 400, [140, 20, 200]);

		const result = await personas.importPersonas([
			vtPersonaPayload({
				avatarThumb: { ext: "png", bytesBase64: Buffer.from(thumbOriginal).toString("base64") },
				avatarFull: { ext: "png", bytesBase64: Buffer.from(exportedFull).toString("base64") },
			}),
		]);
		expect(result.errors).toEqual([]);

		const list = await stores.personas.listAll();
		const persona = list.find((p) => p.name === "Imported User");
		expect(persona!.avatarExt).toBe("webp");
		expect(persona!.avatarFullExt).toBe("png");
		// The full slot carries the EXPORT's full bytes — the thumb-derived
		// preservation never fires when a dedicated full arrives.
		const fullBytes = new Uint8Array(
			await Bun.file(join(dataRoot, PERSONAS, persona!.id, "avatar-full.png")).arrayBuffer(),
		);
		expect(fullBytes).toEqual(exportedFull);
	});

	test("characterization: writePersonaAvatar still rejects octet-stream Files (the pre-fix import shape)", async () => {
		const { assetService } = await setup();
		await expect(
			assetService.writePersonaAvatar("pers_1", new File([minimalPng(4, 4)], "a.png", { type: "application/octet-stream" })),
		).rejects.toThrow(/Unsupported image type/);
	});
});
