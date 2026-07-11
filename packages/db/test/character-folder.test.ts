import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContentStore } from "../src/content-store.js";
import { createFileStore, STORAGE_FOLDERS } from "../src/file-store.js";
import { CharacterFolder } from "../src/stores/character-folder.js";
import type { VtfCharacterContent } from "../src/vtf/index.js";

const CHARS = STORAGE_FOLDERS.characters;

// A representative content subset covering every codec surface: prose
// (description), instructions (systemPrompt / postHistory), and a manifest
// greeting set (firstMessage + one alternate).
const SAMPLE: VtfCharacterContent = {
	name: "Aria",
	description: "storm mage",
	personalitySummary: null,
	defaultScenario: "A tavern.",
	firstMessage: "The door creaks.",
	mesExample: null,
	mesExampleMode: "always",
	mesExampleDepth: 4,
	alternateGreetings: ["Alt opener."],
	postHistoryInstructions: "Keep it brief.",
	creatorNotes: null,
	depthPrompt: null,
	depthPromptDepth: null,
	depthPromptRole: null,
	systemPrompt: "Be vivid.",
	tags: ["modern"],
	extensions: { creator: "anon" },
};

async function setup(): Promise<{ dataRoot: string; content: ContentStore; folder: CharacterFolder }> {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-charfolder-test-"));
	const content = new ContentStore({ fileStore: createFileStore(dataRoot) });
	const folder = new CharacterFolder(content);
	return { dataRoot, content, folder };
}

describe("CharacterFolder (isolated, no DB)", () => {
	test("writeVtfFolder writes the canonical file set and readEntriesAt reads it back", async () => {
		const { folder } = await setup();
		const id = "char_rt";
		const hash = await folder.writeVtfFolder(id, SAMPLE);
		expect(typeof hash).toBe("string");
		expect(hash.length).toBeGreaterThan(0);

		const entries = await folder.readEntriesAt(id, "");
		const paths = entries.map((e) => e.path).sort();
		expect(paths).toContain("profile.md");
		expect(paths).toContain("instructions.json");
		expect(paths).toContain("extensions.json");
		expect(paths).toContain("greetings/_index.yaml");
		expect(paths).toContain("greetings/g_0000.md");
		expect(paths).toContain("greetings/g_0001.md"); // firstMessage + 1 alternate
	});

	test("readVtfOverride returns the parsed content when profile.md exists", async () => {
		const { folder } = await setup();
		const id = "char_ov";
		await folder.writeVtfFolder(id, SAMPLE);
		const override = await folder.readVtfOverride(id);
		expect(override).not.toBeNull();
		expect(override?.name).toBe("Aria");
		expect(override?.description).toBe("storm mage");
		expect(override?.systemPrompt).toBe("Be vivid.");
		expect(override?.postHistoryInstructions).toBe("Keep it brief.");
		expect(override?.firstMessage).toBe("The door creaks.");
		expect(override?.alternateGreetings).toEqual(["Alt opener."]);
		expect(override?.tags).toEqual(["modern"]);
	});

	test("readVtfOverride returns null when there is no profile.md", async () => {
		const { folder } = await setup();
		expect(await folder.readVtfOverride("char_empty")).toBeNull();
	});

	test("readEntriesAt returns [] for a nonexistent entity folder", async () => {
		const { folder } = await setup();
		expect(await folder.readEntriesAt("char_none", "")).toEqual([]);
	});

	test("hasVtfProfile is a real disk check: false before write, true after", async () => {
		const { folder } = await setup();
		const id = "char_prof";
		expect(await folder.hasVtfProfile(id)).toBe(false);
		await folder.writeVtfFolder(id, SAMPLE);
		expect(await folder.hasVtfProfile(id)).toBe(true);
	});

	test("ensureCardFile writes a fresh card.json from the fallback and returns a stable hash", async () => {
		const { dataRoot, folder } = await setup();
		const id = "char_card";
		const fallback = { spec: "chara_card_v3", data: { name: "Card Hero" } };
		const h1 = await folder.ensureCardFile(id, fallback);
		const h2 = await folder.ensureCardFile(id, fallback);
		expect(typeof h1).toBe("string");
		expect(h1).toBe(h2); // same input → same canonical hash
		const raw = JSON.parse(await readFile(join(dataRoot, CHARS, id, "card.json"), "utf8"));
		expect(raw.data.name).toBe("Card Hero");
	});

	test("migrateAvatar copies a legacy flat asset into {id}/avatar.{ext} and returns the ext; null when missing", async () => {
		const { dataRoot, folder } = await setup();
		await mkdir(join(dataRoot, "assets"), { recursive: true });
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		await Bun.write(join(dataRoot, "assets", "asset_a1.png"), bytes);

		const ext = await folder.migrateAvatar("char_ava", "asset_a1");
		expect(ext).toBe("png");
		const copied = await readFile(join(dataRoot, CHARS, "char_ava", "avatar.png"));
		expect(new Uint8Array(copied)).toEqual(bytes);

		// missing source asset → null, no throw
		expect(await folder.migrateAvatar("char_ava", "asset_gone")).toBeNull();
	});

	test("migrateAvatarFull mirrors migrateAvatar for the uncropped avatar-full slot", async () => {
		const { dataRoot, folder } = await setup();
		await mkdir(join(dataRoot, "assets"), { recursive: true });
		const bytes = new Uint8Array([1, 2, 3, 4]);
		await Bun.write(join(dataRoot, "assets", "asset_full.webp"), bytes);

		const ext = await folder.migrateAvatarFull("char_full", "asset_full");
		expect(ext).toBe("webp");
		const copied = await readFile(join(dataRoot, CHARS, "char_full", "avatar-full.webp"));
		expect(new Uint8Array(copied)).toEqual(bytes);
		expect(await folder.migrateAvatarFull("char_full", "asset_missing")).toBeNull();
	});

	test("copyAvatarFile / copyAvatarFullFile copy bytes to the destination, and are no-ops when the source is absent", async () => {
		const { dataRoot, content, folder } = await setup();
		await content.writeBinary(CHARS, "src", "avatar.png", new Uint8Array([1, 2, 3]));
		await content.writeBinary(CHARS, "src", "avatar-full.webp", new Uint8Array([4, 5, 6]));

		await folder.copyAvatarFile("src", "dst", "png");
		await folder.copyAvatarFullFile("src", "dst", "webp");

		expect(new Uint8Array(await readFile(join(dataRoot, CHARS, "dst", "avatar.png")))).toEqual(new Uint8Array([1, 2, 3]));
		expect(new Uint8Array(await readFile(join(dataRoot, CHARS, "dst", "avatar-full.webp")))).toEqual(new Uint8Array([4, 5, 6]));

		// absent source: no throw, no file
		await folder.copyAvatarFile("nonexistent", "dst2", "png");
		await expect(readFile(join(dataRoot, CHARS, "dst2", "avatar.png"))).rejects.toThrow();
	});

	test("snapshotToVersion → restoreFromVersion round-trips the VTF folder; versionExists / removeVersionFolder track it", async () => {
		const { folder } = await setup();
		const id = "char_ver";
		await folder.writeVtfFolder(id, SAMPLE);

		expect(await folder.versionExists(id, "v1")).toBe(false);
		await folder.snapshotToVersion(id, "v1");
		expect(await folder.versionExists(id, "v1")).toBe(true);

		// Mutate the root, then restore from the snapshot.
		await folder.writeVtfFolder(id, { ...SAMPLE, name: "Changed", description: "edited" });
		expect((await folder.readVtfOverride(id))?.name).toBe("Changed");
		await folder.restoreFromVersion(id, "v1");
		const restored = await folder.readVtfOverride(id);
		expect(restored?.name).toBe("Aria");
		expect(restored?.description).toBe("storm mage");

		// removeVersionFolder removes the snapshot; idempotent on a missing one.
		await folder.removeVersionFolder(id, "v1");
		expect(await folder.versionExists(id, "v1")).toBe(false);
		await folder.removeVersionFolder(id, "v1"); // no throw
	});

	test("removeAll deletes the whole entity folder", async () => {
		const { dataRoot, folder } = await setup();
		const id = "char_rm";
		await folder.writeVtfFolder(id, SAMPLE);
		await folder.removeAll(id);
		await expect(readdir(join(dataRoot, CHARS, id))).rejects.toThrow();
	});
});
