/**
 * HUMAN_READABLE_FOLDERS — HRF-5 one-shot migration.
 *
 * Converts the pre-HRF-4 on-disk layout (opaque character-id directories +
 * profile.md documents that may predate the `vt.storage_id` identity stamp) to
 * the readable, identity-stamped layout the live registry expects:
 *
 *   1. Ensure every character has a `profile.md` (run `migrateToVtf` when the
 *      folder is empty/pre-VTF). The canonical writer stamps `vt.storage_id`.
 *   2. Surgically re-stamp `vt.storage_id` into a profile.md that exists but
 *      predates the identity stamp — WITHOUT regenerating the document, so
 *      hand-edited / unknown frontmatter and body sections are preserved.
 *   3. Rename the directory from the opaque id to the collision-resolved
 *      display name via the SAME registry rules the live lifecycle uses.
 *
 * Ordering is load-bearing: storage_id is stamped BEFORE the directory is
 * renamed. The registry identifies a character by `vt.storage_id` in
 * `profile.md`, not by the directory basename; renaming an unstamped opaque-id
 * directory would leave the character unresolvable (a fresh scan would treat
 * the readable basename as a new legacy identity).
 *
 * The flat-file archival (root-level `{id}.json` / `{id}.{slug}.json` left by
 * the pre-folder layout) is a separable cleanliness step; it MOVES those files
 * into a timestamped backup (never deletes) and is gated by
 * {@link ReadableFolderMigrationOptions.archiveLegacyFlat}.
 *
 * Idempotent: an already-stamped profile and an already-readable directory are
 * skipped, and an absent flat file archives nothing. Safe to re-run; a
 * completed tree is a no-op. Per the project's data-write rule, the CALLER (the
 * CLI script) MUST back up the DB + `data/characters/` before running this for
 * real; this module performs no backup itself so it stays pure and testable.
 */
import { join } from "node:path";

import { STORAGE_FOLDERS } from "../file-store.js";
import type { StoreContainer } from "../persistence.js";
import { parseProfileMd, serializeProfileMd } from "../vtf/profile-md.js";

const CHARS = STORAGE_FOLDERS.characters;

/** The per-character outcome of one migration pass. */
export interface MigrationStep {
	characterId: string;
	/** The character display name used to derive the readable directory. */
	name: string;
	/** Directory before this step (null when the character had no directory at all). */
	from: string | null;
	/** Directory after this step. */
	to: string;
	/** What happened to the DIRECTORY. `from`→`to` shows the rename when one occurred. */
	action:
		| "renamed" // directory moved to the readable display name (the HRF-5 headline)
		| "vtf-created" // profile.md was absent; migrateToVtf created it (degenerate name, no rename)
		| "storage-id-stamped" // identity stamp added but no rename (degenerate name)
		| "degenerate-name" // display name has no alphanumerics; nothing changed this pass
		| "already-migrated" // stamped + readable; no-op
		| "missing"; // character row exists but has no directory on disk
	/** True when vt.storage_id was added this pass (profile created or re-stamped). */
	stamped: boolean;
}

/** A legacy flat file moved into the backup directory. */
export interface ArchivedFlatFile {
	characterId: string;
	from: string;
	to: string;
}

export interface ReadableFolderMigrationReport {
	scanned: number;
	steps: MigrationStep[];
	archived: ArchivedFlatFile[];
	failures: { characterId: string; phase: string; error: string }[];
}

export interface ReadableFolderMigrationOptions {
	/** Report only; perform no writes. */
	dryRun?: boolean;
	/** Move root-level `{id}.json` / `{id}.{slug}.json` into a backup dir. Default: true. */
	archiveLegacyFlat?: boolean;
	/** Override the timestamped backup directory (testing). Defaults to `<dataRoot>/backups/legacy-flat-<iso>/`. */
	backupDir?: string;
}

/**
 * Run the HRF-5 migration over every active character in stable id order.
 * Returns a detailed report; never throws on a per-character failure (recorded
 * in `failures`), so a single broken character does not abort the pass.
 */
export async function migrateToReadableFolders(
	stores: StoreContainer,
	options: ReadableFolderMigrationOptions = {},
): Promise<ReadableFolderMigrationReport> {
	const dryRun = options.dryRun ?? false;
	const archiveLegacyFlat = options.archiveLegacyFlat ?? true;
	const registry = stores.characterDirectory;
	const backupDir =
		options.backupDir ?? join(stores.content.fileStore.dataRoot, "backups", `legacy-flat-${new Date().toISOString().replace(/[:.]/g, "-")}`);

	const all = (await stores.characters.listAll()).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const steps: MigrationStep[] = [];
	const archived: ArchivedFlatFile[] = [];
	const failures: { characterId: string; phase: string; error: string }[] = [];

	for (const char of all) {
		try {
			const step = await migrateOne(stores, registry, char.id, char.name, dryRun);
			steps.push(step);
			if (archiveLegacyFlat && !dryRun) {
				// A legacy character may have BOTH `{id}.json` and `{id}.{slug}.json`
				// flat files; archive every match in one pass (idempotent: a re-run
				// finds nothing left and archives nothing).
				let moved: string | null;
				while ((moved = await stores.content.archiveLegacyFlatFile(CHARS, char.id, backupDir)) !== null) {
					archived.push({ characterId: char.id, from: moved, to: join(backupDir, basename(moved)) });
				}
			}
		} catch (error) {
			failures.push({
				characterId: char.id,
				phase: "migrate",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return { scanned: all.length, steps, archived, failures };
}

/** Migrate a single character: ensure profile.md → stamp storage_id → rename. */
async function migrateOne(
	stores: StoreContainer,
	registry: StoreContainer["characterDirectory"],
	characterId: string,
	displayName: string,
	dryRun: boolean,
): Promise<MigrationStep> {
	const current = await registry.resolve(characterId);
	if (current === null) {
		return { characterId, name: displayName, from: null, to: "", action: "missing", stamped: false };
	}

	// Collect what changed, then report the highest-priority outcome. Priority
	// reflects data significance: a created/stamped profile outweighs a cosmetic
	// rename; a degenerate name is reported when nothing else renamed the dir.
	let createdProfile = false;
	let stampedId = false;

	// 1. Ensure profile.md exists (migrateToVtf stamps storage_id on creation).
	const profileText = await stores.content.readEntityTextFile(CHARS, current, "profile.md");
	if (profileText === null) {
		if (!dryRun) await stores.characters.migrateToVtf(characterId);
		createdProfile = true;
	} else {
		// 2. Surgically re-stamp storage_id when a pre-stamp profile lacks it.
		const parsed = parseProfileMd(profileText);
		if (parsed.storageId !== characterId) {
			if (!dryRun) {
				const restamped = serializeProfileMd({ ...parsed, storageId: characterId });
				await stores.content.writeEntityTextFile(CHARS, current, "profile.md", restamped);
			}
			stampedId = true;
		}
	}

	// 3. Rename the directory to the readable display name (registry rules).
	const preview = await registry.previewDirectoryTarget(characterId, displayName);
	let renamedTo = current;
	let didRename = false;
	if (!preview.degenerate && preview.wouldRename) {
		if (!dryRun) renamedTo = await registry.renameForDisplayName(characterId, displayName);
		else renamedTo = preview.target;
		didRename = true;
	}

	const action = pickAction(createdProfile, stampedId, didRename, preview.degenerate);
	return { characterId, name: displayName, from: current, to: renamedTo, action, stamped: createdProfile || stampedId };
}

/** Directory-action priority: rename (HRF-5 headline) > create > stamp > degenerate > no-op. */
function pickAction(created: boolean, stamped: boolean, renamed: boolean, degenerate: boolean): MigrationStep["action"] {
	if (renamed) return "renamed";
	if (created) return "vtf-created";
	if (stamped) return "storage-id-stamped";
	if (degenerate) return "degenerate-name";
	return "already-migrated";
}

function basename(p: string): string {
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i === -1 ? p : p.slice(i + 1);
}
