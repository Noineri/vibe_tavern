import { describe, expect, test, mock, beforeEach } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, STORAGE_FOLDERS } from "@vibe-tavern/db";
import { AssetService } from "../src/domain/asset/asset-service.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import type { StoredProviderProfileRecord } from "@vibe-tavern/domain";

const CHARS = STORAGE_FOLDERS.characters;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ─── Vision-gate mock: capture calls, return deterministic descriptions ────
// IMPORTANT (Bun): `mock.module` persists for the whole process. The factory
// MUST spread the real module's exports so that other test files (notably
// vision-gate.test.ts, which exercises `resolveMultimodalContent` directly)
// still get the real implementation. We only override `describeAttachments`
// and `resolveVisionDescribePrompt` — everything else passes through. Without
// this spread, resolveMultimodalContent would be `undefined` and vision-gate's
// suite would collapse with a cross-file leak.
//
// The real module is imported BEFORE the mock is registered, so `real` holds
// the genuine function references; the mock factory then spreads them back.
const real = await import("../src/infrastructure/ai/vision-gate.js");

let lastDescribeArgs: { count: number; ids: string[]; visionModel: string | null; prompt: string | null } = {
	count: 0,
	ids: [],
	visionModel: null,
	prompt: null,
};
let describeOverride: ((ids: string[]) => Map<string, string>) | null = null;

await mock.module("../src/infrastructure/ai/vision-gate.js", () => ({
	...real,
	describeAttachments: async (attachments: Array<{ id: string }>) => {
		const ids = attachments.map((a) => a.id);
		lastDescribeArgs = { count: ids.length, ids, visionModel: lastDescribeArgs.visionModel, prompt: lastDescribeArgs.prompt };
		// load buffers via the loader to exercise the preloaded-loader path
		return describeOverride ? describeOverride(ids) : new Map(ids.map((id) => [id, `DESC(${id})`] as const));
	},
	resolveVisionDescribePrompt: async () => "MOCK_VISION_PROMPT",
}));

beforeEach(() => {
	lastDescribeArgs = { count: 0, ids: [], visionModel: null, prompt: null };
	describeOverride = null;
});

// ─── Stub provider profile service ──────────────────────────────────────────
function makeProfileService(opts: { visionModel?: string | null; active?: boolean } = {}): ProviderProfileService {
	const profile = {
		id: "prof_1",
		name: "test",
		providerPreset: "openai",
		endpoint: "https://x.test",
		apiKey: null,
		defaultModel: "gpt-test",
		visionModel: opts.visionModel !== undefined ? opts.visionModel : "vision-test",
	} as unknown as StoredProviderProfileRecord;
	return {
		resolveActiveProviderProfile: async () => (opts.active === false ? null : profile),
	} as unknown as ProviderProfileService;
}

const noopSession = {} as never;

async function setup(opts: { visionModel?: string | null; active?: boolean } = {}) {
	const { CharacterAdapter } = await import("../src/api/adapters/character-adapter.js");
	const { PersonaAdapter } = await import("../src/api/adapters/persona-adapter.js");
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-gallery-desc-"));
	await mkdir(join(dataRoot, "assets"), { recursive: true });
	const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const assetService = new AssetService(join(dataRoot, "assets"), stores.content);
	const providerProfileService = makeProfileService(opts);
	const characters = new CharacterAdapter(noopSession, stores, assetService, providerProfileService);
	const personas = new PersonaAdapter(noopSession, stores, assetService, providerProfileService);
	return { dataRoot, stores, assetService, characters, personas };
}

describe("Vision describe (A6)", () => {
	test("describeCharacterAssets: batch describes all undescribed rows; persists descriptions", async () => {
		const { stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria" });
		await characters.uploadCharacterAsset(char.id, new File([PNG], "a.png", { type: "image/png" }));
		await characters.uploadCharacterAsset(char.id, new File([PNG], "b.png", { type: "image/png" }));

		const result = await characters.describeCharacterAssets(char.id);
		expect(result.updated.length).toBe(2);
		expect(result.failed).toEqual([]);

		// persisted to the rows
		const rows = await stores.characterAssets.listByCharacter(char.id);
		expect(rows.every((r) => r.description?.startsWith("DESC("))).toBe(true);
	});

	test("describeCharacterAssets: only undescribed rows when no ids given (skip already-described)", async () => {
		const { stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria" });
		const a = await characters.uploadCharacterAsset(char.id, new File([PNG], "a.png", { type: "image/png" }));
		await characters.uploadCharacterAsset(char.id, new File([PNG], "b.png", { type: "image/png" }));
		// pre-describe one
		await stores.characterAssets.update(a.id, { description: "already done" });

		const result = await characters.describeCharacterAssets(char.id);
		expect(result.updated.length).toBe(1); // only the undescribed one
		expect(result.failed).toEqual([]);
	});

	test("describeCharacterAssets: explicit assetRowIds filter (ignores foreign ids)", async () => {
		const { stores, characters } = await setup();
		const charA = await stores.characters.create({ name: "Aria" });
		const charB = await stores.characters.create({ name: "Bea" });
		const a = await characters.uploadCharacterAsset(charA.id, new File([PNG], "a.png", { type: "image/png" }));
		const foreign = await characters.uploadCharacterAsset(charB.id, new File([PNG], "b.png", { type: "image/png" }));

		// pass a's id + a foreign id; only a should be described
		const result = await characters.describeCharacterAssets(charA.id, [a.id, foreign.id]);
		expect(result.updated).toEqual([a.id]);
		expect(await characters.serveCharacterAsset(charB.id, foreign.id)).not.toBeNull(); // B untouched
	});

	test("describeCharacterAssets: rows with unreadable file go to `failed` (no throw)", async () => {
		const { stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria" });
		await characters.uploadCharacterAsset(char.id, new File([PNG], "a.png", { type: "image/png" }));
		// inject a phantom row whose file does not exist on disk
		const phantom = await stores.characterAssets.create({
			characterId: char.id,
			ext: "png",
			mimeType: "image/png",
			order: 99,
		});
		const result = await characters.describeCharacterAssets(char.id, [phantom.id]);
		expect(result.updated).toEqual([]);
		expect(result.failed).toEqual([phantom.id]);
	});

	test("describeCharacterAssets: throws when no vision model configured", async () => {
		const { stores, characters } = await setup({ visionModel: null });
		const char = await stores.characters.create({ name: "Aria" });
		await characters.uploadCharacterAsset(char.id, new File([PNG], "a.png", { type: "image/png" }));
		await expect(characters.describeCharacterAssets(char.id)).rejects.toThrow(/No vision model configured/);
	});

	test("describeCharacterAvatar: 400 when character has no avatar", async () => {
		const { stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria" });
		await expect(characters.describeCharacterAvatar(char.id)).rejects.toThrow(/no avatar/i);
		// nothing described
		expect(lastDescribeArgs.count).toBe(0);
	});

	test("describeCharacterAvatar: describes the folder avatar and persists to avatarDescription", async () => {
		const { stores, characters } = await setup();
		const char = await stores.characters.create({ name: "Aria" });
		await characters.uploadCharacterAvatar(char.id, new File([PNG], "a.png", { type: "image/png" }));

		const result = await characters.describeCharacterAvatar(char.id);
		expect(result.description).toBe("DESC(avatar)");
		const row = await stores.characters.getById(char.id);
		expect(row?.avatarDescription).toBe("DESC(avatar)");
	});

	test("describeCharacterAvatar: throws when no vision model configured", async () => {
		const { stores, characters } = await setup({ visionModel: null });
		const char = await stores.characters.create({ name: "Aria" });
		await characters.uploadCharacterAvatar(char.id, new File([PNG], "a.png", { type: "image/png" }));
		await expect(characters.describeCharacterAvatar(char.id)).rejects.toThrow(/No vision model configured/);
	});

	test("describePersonaAvatar: describes the persona folder avatar and persists", async () => {
		const { stores, personas } = await setup();
		const persona = await stores.personas.create({ name: "User" });
		await personas.uploadPersonaAvatar(persona.id, new File([PNG], "a.png", { type: "image/png" }));

		const result = await personas.describePersonaAvatar(persona.id);
		expect(result.description).toBe("DESC(avatar)");
		const row = await stores.personas.getById(persona.id);
		expect(row?.avatarDescription).toBe("DESC(avatar)");
	});

	test("describePersonaAvatar: 400 when no avatar", async () => {
		const { stores, personas } = await setup();
		const persona = await stores.personas.create({ name: "User" });
		await expect(personas.describePersonaAvatar(persona.id)).rejects.toThrow(/no avatar/i);
	});

	test("point-update setMediaFields does NOT rewrite profile.md (avatarDescription only)", async () => {
		const { dataRoot, stores } = await setup();
		const char = await stores.characters.create({ name: "Aria", description: "original" });
		const profilePath = join(dataRoot, CHARS, char.id, "profile.md");
		const { mtimeMsMs } = await import("node:fs/promises").then((fs) => fs.stat(profilePath).then((s) => ({ mtimeMsMs: s.mtimeMs })));
		await new Promise((r) => setTimeout(r, 30));
		await stores.characters.setMediaFields(char.id, { avatarDescription: "x", includeAvatarInPrompt: true });
		const after = await import("node:fs/promises").then((fs) => fs.stat(profilePath).then((s) => s.mtimeMs));
		expect(after).toBe(mtimeMsMs); // profile.md untouched
		// but the DB columns changed
		const row = await stores.characters.getById(char.id);
		expect(row?.avatarDescription).toBe("x");
		expect(row?.includeAvatarInPrompt).toBe(true);
	});
});
