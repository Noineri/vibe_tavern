import type { StoreContainer } from "@vibe-tavern/db";

import { AssetService, extToMime } from "./asset-service.js";
import { normalizeAvatarThumbnail } from "./avatar-thumbnail.js";

/**
 * LB-1C — startup backfill for avatar thumbnails.
 *
 * Every avatar written since LB-1B lands normalized (≤ 512 px webp) with the
 * original in `avatar-full`. This pass brings PRE-EXISTING avatars (and any
 * byte-identical copies that the lazy flat→folder migrations produce later)
 * to the same state, idempotently — no marker row: a second pass finds every
 * avatar already-normalized and changes nothing.
 *
 * Per entity, ordered so a crash at ANY point never loses the original:
 *  1. if `avatarFullExt` is null → write the ORIGINAL bytes to
 *     `avatar-full.{ext}` + `setFolderAvatarFull` FIRST;
 *  2. write the normalized `avatar.webp`;
 *  3. `setFolderAvatar(id, ext)` (bumps `updatedAt` — the `?v=` cache-bust);
 *  4. delete the stale `avatar.{oldExt}` LAST through the shared
 *     AssetService leaf-delete (never throws — the one implementation the
 *     upload adapters use too; a crash before step 3 with the stale leaf
 *     already gone would leave a permanently 404-ing avatar, after step 3 a
 *     missed delete only leaves a harmless orphan leaf).
 *
 * The entity record is re-read right before writing: if `avatarExt` changed
 * since the scan started (the user uploaded meanwhile), the entity is skipped.
 */

export interface AvatarBackfillCounts {
	scanned: number;
	normalized: number;
	skipped: number;
	failed: number;
	bytesBefore: number;
	bytesAfter: number;
}

/** One avatar-bearing entity flattened across the two stores. */
interface AvatarEntity {
	kind: "character" | "persona";
	id: string;
	avatarExt: string;
	avatarFullExt: string | null;
}

interface EntityIo {
	list(): Promise<AvatarEntity[]>;
	get(id: string): Promise<AvatarEntity | null>;
	load(id: string, ext: string): Promise<Buffer | null>;
	writeFull(id: string, file: File): Promise<{ ext: string }>;
	writeThumb(id: string, file: File): Promise<{ ext: string; changed: boolean; originalExt: string }>;
	setAvatar(id: string, ext: string): Promise<void>;
	setAvatarFull(id: string, ext: string): Promise<void>;
	/** Delete the stale leaf LAST via the shared AssetService delete. */
	deleteLeaf(id: string, ext: string): Promise<void>;
}

function characterIo(stores: StoreContainer, assetService: AssetService): EntityIo {
	return {
		list: async () =>
			(await stores.characters.listAll())
				.filter((c) => c.avatarExt)
				.map((c) => ({
					kind: "character" as const,
					id: c.id,
					avatarExt: c.avatarExt!,
					avatarFullExt: c.avatarFullExt,
				})),
		get: async (id) => {
			const c = await stores.characters.getById(id);
			return c && c.avatarExt
				? { kind: "character" as const, id: c.id, avatarExt: c.avatarExt, avatarFullExt: c.avatarFullExt }
				: null;
		},
		load: (id, ext) => assetService.loadCharacterAvatarBuffer(id, ext),
		writeFull: (id, file) => assetService.writeCharacterAvatarFull(id, file),
		writeThumb: (id, file) => assetService.writeCharacterAvatar(id, file),
		setAvatar: (id, ext) => stores.characters.setFolderAvatar(id, ext),
		setAvatarFull: (id, ext) => stores.characters.setFolderAvatarFull(id, ext),
		deleteLeaf: (id, ext) => assetService.deleteCharacterAvatarLeaf(id, ext),
	};
}

function personaIo(stores: StoreContainer, assetService: AssetService): EntityIo {
	return {
		list: async () =>
			(await stores.personas.listAll())
				.filter((p) => p.avatarExt)
				.map((p) => ({
					kind: "persona" as const,
					id: p.id,
					avatarExt: p.avatarExt!,
					avatarFullExt: p.avatarFullExt,
				})),
		get: async (id) => {
			const p = await stores.personas.getById(id);
			return p && p.avatarExt
				? { kind: "persona" as const, id: p.id, avatarExt: p.avatarExt, avatarFullExt: p.avatarFullExt }
				: null;
		},
		load: (id, ext) => assetService.loadPersonaAvatarBuffer(id, ext),
		writeFull: (id, file) => assetService.writePersonaAvatarFull(id, file),
		writeThumb: (id, file) => assetService.writePersonaAvatar(id, file),
		setAvatar: (id, ext) => stores.personas.setFolderAvatar(id, ext),
		setAvatarFull: (id, ext) => stores.personas.setFolderAvatarFull(id, ext),
		deleteLeaf: (id, ext) => assetService.deletePersonaAvatarLeaf(id, ext),
	};
}

async function backfillEntity(io: EntityIo, entity: AvatarEntity, counts: AvatarBackfillCounts): Promise<void> {
	const original = await io.load(entity.id, entity.avatarExt);
	if (!original) {
		counts.skipped++;
		console.debug(`[avatar-backfill] ${entity.kind} ${entity.id}: avatar.${entity.avatarExt} missing on disk, skipped`);
		return;
	}
	// Fresh copy: the helper's unchanged path may return the input by
	// reference, and the loaded Buffer must never be aliased into a write.
	const originalBytes = new Uint8Array(original);
	const plan = await normalizeAvatarThumbnail(originalBytes, entity.avatarExt);
	if (!plan.changed) {
		counts.skipped++;
		console.debug(`[avatar-backfill] ${entity.kind} ${entity.id}: already normalized or passthrough (${entity.avatarExt})`);
		return;
	}
	// Re-read right before writing: if the user replaced the avatar while the
	// pass was scanning, our bytes are stale — skip rather than overwrite.
	const record = await io.get(entity.id);
	if (!record || record.avatarExt !== entity.avatarExt) {
		counts.skipped++;
		console.debug(`[avatar-backfill] ${entity.kind} ${entity.id}: avatarExt changed mid-scan, skipped`);
		return;
	}
	if (record.avatarFullExt === null) {
		const fullFile = new File([new Uint8Array(originalBytes)], `avatar-full.${entity.avatarExt}`, {
			type: extToMime(entity.avatarExt),
		});
		await io.writeFull(entity.id, fullFile);
		await io.setAvatarFull(entity.id, entity.avatarExt);
	}
	await io.writeThumb(entity.id, new File([new Uint8Array(plan.bytes)], "avatar.webp", { type: "image/webp" }));
	await io.setAvatar(entity.id, plan.ext);
	if (plan.ext !== entity.avatarExt) {
		await io.deleteLeaf(entity.id, entity.avatarExt);
	}
	counts.normalized++;
	counts.bytesBefore += originalBytes.length;
	counts.bytesAfter += plan.bytes.length;
}

/**
 * Run one full backfill pass over characters then personas, sequentially
 * (one entity at a time — low memory; each pass awaits the previous). Errors
 * are counted and logged per entity and never stop the pass.
 */
export async function runAvatarThumbnailBackfill(
	stores: StoreContainer,
	assetService: AssetService,
): Promise<AvatarBackfillCounts> {
	const counts: AvatarBackfillCounts = { scanned: 0, normalized: 0, skipped: 0, failed: 0, bytesBefore: 0, bytesAfter: 0 };
	for (const io of [characterIo(stores, assetService), personaIo(stores, assetService)]) {
		let entities: AvatarEntity[];
		try {
			entities = await io.list();
		} catch (error) {
			console.error("[avatar-backfill] listing failed:", error);
			continue;
		}
		for (const entity of entities) {
			counts.scanned++;
			try {
				await backfillEntity(io, entity, counts);
			} catch (error) {
				counts.failed++;
				console.warn(`[avatar-backfill] ${entity.kind} ${entity.id} failed, keeping the current bytes:`, error);
			}
		}
	}
	const kb = (n: number) => `${Math.round(n / 1024)} KB`;
	console.log(
		`[avatar-backfill] ${counts.scanned} scanned, ${counts.normalized} normalized, ` +
			`${counts.skipped} skipped, ${counts.failed} failed ` +
			`(${kb(counts.bytesBefore)} → ${kb(counts.bytesAfter)})`,
	);
	return counts;
}

/**
 * Fire-and-forget wrapper for server startup (server-runtime.ts): schedules
 * the pass WITHOUT awaiting it — the server reports ready immediately and the
 * backfill proceeds in the background. Unlike the awaited one-time
 * migrations next to it, this pass must never delay or fail startup; a crash
 * of the whole pass is caught and logged here.
 */
export function scheduleAvatarThumbnailBackfill(stores: StoreContainer, assetService: AssetService): void {
	void runAvatarThumbnailBackfill(stores, assetService).catch((error) => {
		console.error("[avatar-backfill] pass crashed:", error);
	});
}
