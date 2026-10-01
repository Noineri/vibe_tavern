import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, STORAGE_FOLDERS, type StoreContainer } from "@vibe-tavern/db";
import { AssetService } from "../src/domain/asset/asset-service.js";
import {
	runAvatarThumbnailBackfill,
	scheduleAvatarThumbnailBackfill,
	type AvatarBackfillCounts,
} from "../src/domain/asset/avatar-thumbnail-backfill.js";
import { minimalPng } from "./image-bytes.js";

const CHARS = STORAGE_FOLDERS.characters;
const PERSONAS = STORAGE_FOLDERS.personas;

async function setup() {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-avatar-backfill-"));
	await mkdir(join(dataRoot, "assets"), { recursive: true });
	const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
	const assetService = new AssetService(
		join(dataRoot, "assets"),
		stores.content,
		(id) => stores.characters.resolveFolderName(id),
	);
	return { dataRoot, stores, assetService };
}

/** Create a character with a raw avatar.{ext} (+ optional avatar-full.{ext}). */
async function addCharacterAvatar(
	stores: StoreContainer,
	name: string,
	bytes: Uint8Array,
	ext: string,
	full?: { ext: string; bytes: Uint8Array },
) {
	const char = await stores.characters.create({ name, avatarExt: ext, avatarFullExt: full?.ext ?? null });
	const dir = await stores.characters.resolveFolderName(char.id);
	await stores.content.writeBinary(CHARS, dir, `avatar.${ext}`, bytes);
	if (full) {
		await stores.content.writeBinary(CHARS, dir, `avatar-full.${full.ext}`, full.bytes);
	}
	return { id: char.id, dir };
}

/** Persona twin — persona folders stay opaque-id. */
async function addPersonaAvatar(
	stores: StoreContainer,
	name: string,
	bytes: Uint8Array,
	ext: string,
) {
	const persona = await stores.personas.create({ name, avatarExt: ext });
	await stores.content.writeBinary(PERSONAS, persona.id, `avatar.${ext}`, bytes);
	return { id: persona.id, dir: persona.id };
}

async function webpDimensions(bytes: Uint8Array): Promise<{ width: number; height: number; format: string }> {
	return await new Bun.Image(bytes).metadata();
}

describe("avatar thumbnail backfill (LB-1C)", () => {
	test("oversized PNG without full → 512 webp thumb + ORIGINAL preserved + stale leaf gone + updatedAt bumped", async () => {
		const { stores, assetService } = await setup();
		const original = minimalPng(600, 600, [60, 120, 200]);
		const { id, dir } = await addCharacterAvatar(stores, "Big", original, "png");

		const before = (await stores.characters.getById(id))!;
		await Bun.sleep(2); // ISO-ms clock: guarantee a later timestamp

		const counts = await runAvatarThumbnailBackfill(stores, assetService);
		expect(counts.scanned).toBe(1);
		expect(counts.normalized).toBe(1);
		expect(counts.skipped).toBe(0);
		expect(counts.failed).toBe(0);
		expect(counts.bytesBefore).toBe(original.length);
		expect(counts.bytesAfter).toBeLessThan(original.length);

		const after = (await stores.characters.getById(id))!;
		expect(after.avatarExt).toBe("webp");
		expect(after.avatarFullExt).toBe("png");
		// setFolderAvatar bumped updatedAt — the ?v= cache-bust.
		expect(after.updatedAt > before.updatedAt).toBe(true);

		const thumb = await stores.content.readBinary(CHARS, dir, "avatar.webp");
		expect(thumb).not.toBeNull();
		const meta = await webpDimensions(new Uint8Array(thumb!));
		expect(meta.format).toBe("webp");
		expect(meta.width).toBe(512);
		expect(meta.height).toBe(512);

		// The ORIGINAL survives byte-for-byte in the full slot.
		const full = await stores.content.readBinary(CHARS, dir, "avatar-full.png");
		expect(new Uint8Array(full!)).toEqual(original);

		// The stale leaf was deleted (content-store delete API).
		expect(await stores.content.readBinary(CHARS, dir, "avatar.png")).toBeNull();
	});

	test("entity with an existing full → the full is untouched", async () => {
		const { stores, assetService } = await setup();
		const fullBytes = minimalPng(400, 400, [10, 10, 10]);
		const { id, dir } = await addCharacterAvatar(
			stores,
			"HasFull",
			minimalPng(700, 500),
			"png",
			{ ext: "png", bytes: fullBytes },
		);

		const counts = await runAvatarThumbnailBackfill(stores, assetService);
		expect(counts.normalized).toBe(1);

		const row = (await stores.characters.getById(id))!;
		expect(row.avatarExt).toBe("webp");
		expect(row.avatarFullExt).toBe("png");
		expect(new Uint8Array((await stores.content.readBinary(CHARS, dir, "avatar-full.png"))!)).toEqual(fullBytes);
		expect(await stores.content.readBinary(CHARS, dir, "avatar.webp")).not.toBeNull();
	});

	test("already-small webp → untouched, no store writes at all", async () => {
		const { stores, assetService } = await setup();
		const small = new Uint8Array(await new Bun.Image(minimalPng(300, 300)).webp({ quality: 85 }).bytes());
		const { id, dir } = await addCharacterAvatar(stores, "Small", small, "webp");

		const before = (await stores.characters.getById(id))!;
		const counts = await runAvatarThumbnailBackfill(stores, assetService);
		expect(counts.scanned).toBe(1);
		expect(counts.normalized).toBe(0);
		expect(counts.skipped).toBe(1);

		// Idempotent by construction: nothing written, no full invented,
		// updatedAt NOT bumped (no setFolderAvatar call).
		const after = (await stores.characters.getById(id))!;
		expect(after.avatarExt).toBe("webp");
		expect(after.avatarFullExt).toBeNull();
		expect(after.updatedAt).toBe(before.updatedAt);
		expect(new Uint8Array((await stores.content.readBinary(CHARS, dir, "avatar.webp"))!)).toEqual(small);
	});

	test("GIF → untouched (animation must never be flattened)", async () => {
		const { stores, assetService } = await setup();
		const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0]);
		const { id, dir } = await addCharacterAvatar(stores, "Gif", gif, "gif");

		const counts = await runAvatarThumbnailBackfill(stores, assetService);
		expect(counts.normalized).toBe(0);
		expect(counts.skipped).toBe(1);

		expect((await stores.characters.getById(id))!.avatarExt).toBe("gif");
		expect(new Uint8Array((await stores.content.readBinary(CHARS, dir, "avatar.gif"))!)).toEqual(gif);
	});

	test("corrupt file → counted, pass continues with the next entity", async () => {
		const { stores, assetService } = await setup();
		const corrupt = new Uint8Array(32).fill(0xff);
		const { id: badId, dir: badDir } = await addCharacterAvatar(stores, "Corrupt", corrupt, "png");
		const good = minimalPng(600, 600, [200, 200, 30]);
		const { id: goodId, dir: goodDir } = await addCharacterAvatar(stores, "Good", good, "png");

		const counts = await runAvatarThumbnailBackfill(stores, assetService);
		expect(counts.scanned).toBe(2);
		expect(counts.normalized).toBe(1);
		expect(counts.skipped).toBe(1); // the helper's warn+unchanged fallback
		expect(counts.failed).toBe(0);

		// The corrupt entity is untouched; the good one normalized.
		expect(new Uint8Array((await stores.content.readBinary(CHARS, badDir, "avatar.png"))!)).toEqual(corrupt);
		expect((await stores.characters.getById(badId))!.avatarExt).toBe("png");
		expect((await stores.characters.getById(goodId))!.avatarExt).toBe("webp");
		expect(await stores.content.readBinary(CHARS, goodDir, "avatar.webp")).not.toBeNull();
	});

	test("a full-write error fails ONLY that entity — the original stays as-is (full-first ordering)", async () => {
		const { stores, assetService } = await setup();
		// > 20 MB original: the normalizer succeeds, but writeCharacterAvatarFull
		// rejects the size — the full-first ordering leaves avatar.png intact.
		const huge = minimalPng(2900, 2900, [90, 90, 200]);
		const { id, dir } = await addCharacterAvatar(stores, "Huge", huge, "png");
		const good = minimalPng(600, 600, [5, 150, 90]);
		await addCharacterAvatar(stores, "Next", good, "png");

		const counts = await runAvatarThumbnailBackfill(stores, assetService);
		expect(counts.scanned).toBe(2);
		expect(counts.normalized).toBe(1); // the good entity
		expect(counts.failed).toBe(1); // the huge one

		expect(new Uint8Array((await stores.content.readBinary(CHARS, dir, "avatar.png"))!)).toEqual(huge);
		expect((await stores.characters.getById(id))!.avatarExt).toBe("png");
	});

	test("personas are covered the same way", async () => {
		const { stores, assetService } = await setup();
		const original = minimalPng(800, 600, [160, 30, 30]);
		const { id, dir } = await addPersonaAvatar(stores, "BigUser", original, "png");

		const counts = await runAvatarThumbnailBackfill(stores, assetService);
		expect(counts.scanned).toBe(1);
		expect(counts.normalized).toBe(1);

		const row = (await stores.personas.getById(id))!;
		expect(row.avatarExt).toBe("webp");
		expect(row.avatarFullExt).toBe("png");
		const meta = await webpDimensions(new Uint8Array((await stores.content.readBinary(PERSONAS, dir, "avatar.webp"))!));
		expect(meta.format).toBe("webp");
		expect(meta.width).toBe(512);
		expect(meta.height).toBe(384);
		expect(new Uint8Array((await stores.content.readBinary(PERSONAS, dir, "avatar-full.png"))!)).toEqual(original);
		expect(await stores.content.readBinary(PERSONAS, dir, "avatar.png")).toBeNull();
	});

	test("second run is a complete no-op", async () => {
		const { stores, assetService } = await setup();
		const original = minimalPng(600, 600, [30, 30, 30]);
		const { id, dir } = await addCharacterAvatar(stores, "Once", original, "png");
		await runAvatarThumbnailBackfill(stores, assetService);

		const afterFirst = (await stores.characters.getById(id))!;
		const thumb = await stores.content.readBinary(CHARS, dir, "avatar.webp");
		const full = await stores.content.readBinary(CHARS, dir, "avatar-full.png");

		const counts = await runAvatarThumbnailBackfill(stores, assetService);
		expect(counts.scanned).toBe(1);
		expect(counts.normalized).toBe(0);
		expect(counts.skipped).toBe(1);
		expect(counts.failed).toBe(0);

		// Nothing moved: same row timestamp, same bytes on disk.
		expect((await stores.characters.getById(id))!.updatedAt).toBe(afterFirst.updatedAt);
		expect(await stores.content.readBinary(CHARS, dir, "avatar.webp")).toEqual(thumb);
		expect(await stores.content.readBinary(CHARS, dir, "avatar-full.png")).toEqual(full);
	});

	test("avatarExt changed since the scan → entity skipped, nothing written", async () => {
		const { stores, assetService } = await setup();
		const original = minimalPng(600, 600, [99, 1, 99]);
		const { id } = await addPersonaAvatar(stores, "Raced", original, "png");

		// Simulate the user replacing the avatar between listAll and the
		// pre-write re-read (instance-local patch on a test-scoped object).
		const realGet = stores.personas.getById.bind(stores.personas);
		stores.personas.getById = async (pid: string) => {
			const row = await realGet(pid);
			return row ? { ...row, avatarExt: "jpeg" } : null;
		};

		const counts = await runAvatarThumbnailBackfill(stores, assetService);
		expect(counts.scanned).toBe(1);
		expect(counts.normalized).toBe(0);
		expect(counts.skipped).toBe(1);

		// The DB still says png (the patch never wrote), and the file is intact.
		const row = await realGet(id);
		expect(row!.avatarExt).toBe("png");
		expect(new Uint8Array((await stores.content.readBinary(PERSONAS, id, "avatar.png"))!)).toEqual(original);
		expect(await stores.content.readBinary(PERSONAS, id, "avatar.webp")).toBeNull();
		expect(await stores.content.readBinary(PERSONAS, id, "avatar-full.png")).toBeNull();
	});

	test("scheduleAvatarThumbnailBackfill does NOT await the pass (startup wiring contract)", async () => {
		const { stores, assetService } = await setup();
		// Both list calls hang forever: if the scheduler awaited the pass, this
		// test would never complete. Patches are instance-local to the
		// test-scoped container — no process-global state to restore.
		stores.characters.listAll = () => new Promise(() => {});
		stores.personas.listAll = () => new Promise(() => {});

		let passedTheCall = false;
		const returned = scheduleAvatarThumbnailBackfill(stores, assetService);
		passedTheCall = true;

		expect(returned).toBeUndefined();
		expect(passedTheCall).toBe(true);
	});
});
