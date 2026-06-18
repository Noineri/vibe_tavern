import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { toCharacterRecord } from "../src/domain/character/character-runtime.js";
import type { Character } from "@vibe-tavern/domain";
import { brandId } from "@vibe-tavern/domain";

/**
 * Bug #2 regression: the snapshot's active-character DTO (SessionSnapshot.character,
 * a CharacterRecord) MUST carry `updatedAt`. Without it, the frontend's
 * resolveEntityAvatarUrl builds the avatar URL with updatedAt=undefined → no
 * `?v=` cache-bust suffix → the avatar serve path's 1-year immutable Cache-Control
 * pins the stale image forever (survives reload AND server restart, since the
 * cache lives in the browser). This is the original Bug #2.
 *
 * This test pins both the pure-function contract (toCharacterRecord) and the
 * integration composition that builds the wire DTO (stores.characters.getById →
 * toCharacterRecord, which is exactly what resolver.getCharacter does for
 * SessionSnapshot.character).
 */
function minimalCharacter(overrides: Partial<Character> = {}): Character {
	return {
		id: brandId("char_x"),
		slug: "test",
		name: "Test",
		description: "",
		personalitySummary: null,
		defaultScenario: null,
		firstMessage: null,
		mesExample: null,
		mesExampleMode: "always",
		mesExampleDepth: 4,
		alternateGreetings: [],
		postHistoryInstructions: null,
		creatorNotes: null,
		characterBook: null,
		depthPrompt: null,
		depthPromptDepth: 4,
		depthPromptRole: "system",
		extensions: {},
		systemPrompt: null,
		tags: [],
		avatarAssetId: null,
		avatarFullAssetId: null,
		avatarCropJson: null,
		avatarExt: null,
		avatarFullExt: null,
		avatarSourceAssetId: null,
		includeGalleryInPrompt: false,
		includeAvatarInPrompt: false,
		avatarDescription: null,
		status: "active",
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("Bug #2 DTO fix: CharacterRecord carries updatedAt", () => {
	test("toCharacterRecord copies updatedAt from the Character row", () => {
		const c = minimalCharacter({ updatedAt: "2024-06-15T12:30:00.000Z" });
		const record = toCharacterRecord(c, null);
		expect(record.updatedAt).toBe("2024-06-15T12:30:00.000Z");
		// Must be a value Date.parse can read — the frontend derives the cache-bust
		// ms from it via Date.parse(updatedAt).
		expect(Number.isFinite(Date.parse(record.updatedAt))).toBe(true);
	});

	test("toCharacterRecord updatedAt changes when the input changes (bust invariant)", () => {
		const before = toCharacterRecord(minimalCharacter({ updatedAt: "2024-01-01T00:00:00.000Z" }), null);
		const after = toCharacterRecord(minimalCharacter({ updatedAt: "2024-06-01T00:00:00.000Z" }), null);
		expect(before.updatedAt).not.toBe(after.updatedAt);
	});

	test("integration: stores.characters.getById row → toCharacterRecord carries updatedAt", async () => {
		// resolver.getCharacter(id) does:
		//   const character = await stores.characters.getById(id);
		//   return toCharacterRecord({ ...character, id: brandId(character.id) }, null);
		// This pins that the row read from the DB carries updatedAt AND that
		// toCharacterRecord preserves it end-to-end — i.e. the exact composition
		// that builds SessionSnapshot.character on the wire.
		const dataRoot = await mkdtemp(join(tmpdir(), "vt-char-dto-"));
		await mkdir(join(dataRoot, "assets"), { recursive: true });
		const stores: StoreContainer = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
		const created = await stores.characters.create({ name: "DTO Probe" });
		const row = await stores.characters.getById(created.id);
		expect(row).not.toBeNull();
		expect(row!.updatedAt).toBeTruthy();
		const record = toCharacterRecord({ ...row!, id: brandId(row!.id) }, null);
		expect(typeof record.updatedAt).toBe("string");
		expect(record.updatedAt).toBe(row!.updatedAt);
		expect(Number.isFinite(Date.parse(record.updatedAt))).toBe(true);
	});
});
