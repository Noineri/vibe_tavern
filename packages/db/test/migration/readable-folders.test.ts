import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { createStoreContainer, STORAGE_FOLDERS } from "../../src/index.js";
import { migrateToReadableFolders } from "../../src/migration/readable-folders.js";
import { parseProfileMd, serializeProfileMd, type VtfProfile } from "../../src/vtf/profile-md.js";

const CHARS = STORAGE_FOLDERS.characters;

/** A minimal valid profile so serializeProfileMd produces real text. */
function profileNamed(name: string): VtfProfile {
	return {
		name,
		tags: [],
		creator: null,
		characterVersion: null,
		creatorNotes: null,
		mesExampleMode: "always",
		mesExampleDepth: 4,
		description: "desc",
		scenario: null,
		mesExample: null,
	};
}

/**
 * Build legacy state directly (bypassing the modern create() path which would
 * already stamp storage_id + a readable name): an opaque-id directory whose
 * profile.md PREDATES the identity stamp, plus a root-level flat card file.
 */
async function setupLegacyChar(
	dataRoot: string,
	db: { run: (q: ReturnType<typeof sql>) => Promise<unknown> },
	id: string,
	name: string,
	opts: { withFlat?: boolean; noProfile?: boolean } = {},
): Promise<void> {
	const dir = join(dataRoot, CHARS, id);
	await mkdir(dir, { recursive: true });
	if (!opts.noProfile) {
		// profile.md WITHOUT vt.storage_id (pre-stamp state).
		const text = serializeProfileMd({ profile: profileNamed(name) });
		await writeFile(join(dir, "profile.md"), text);
	}
	if (opts.withFlat) {
		// Root-level legacy flat card (pre-folder-layout).
		await writeFile(join(dataRoot, CHARS, `${id}.json`), JSON.stringify({ name, description: "legacy flat" }));
	}
	await db.run(sql`INSERT INTO characters (id, name, description, personality_summary, alternate_greetings_json, extensions_json, tags_json, mes_example_mode, mes_example_depth, status, has_file_on_disk, created_at, updated_at)
		 VALUES (${id}, ${name}, 'desc', NULL, '[]', '{}', '[]', 'always', 4, 'active', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
}

async function setup() {
	const dataRoot = await mkdtemp(join(tmpdir(), "vt-hrf5-migration-"));
	const dbPath = join(dataRoot, "test.db");
	const stores = await createStoreContainer(dbPath, dataRoot);
	return { dataRoot, dbPath, stores };
}

describe("HRF-5 migrateToReadableFolders", () => {
	test("stamps storage_id, renames an opaque-id directory to the readable display name, and archives the flat file", async () => {
		const { dataRoot, stores } = await setup();
		await setupLegacyChar(dataRoot, stores.db, "char_alpha", "Alpha Hero", { withFlat: true });

		const report = await migrateToReadableFolders(stores, { backupDir: join(dataRoot, "backups", "legacy") });

		expect(report.scanned).toBe(1);
		expect(report.failures).toEqual([]);
		expect(report.steps[0]).toMatchObject({ characterId: "char_alpha", from: "char_alpha", to: "alpha-hero", action: "renamed", stamped: true });
		expect(report.archived).toHaveLength(1);
		expect(report.archived[0]!.characterId).toBe("char_alpha");

		// The directory is now readable and profile.md carries the identity stamp.
		expect(await stores.characterDirectory.resolve("char_alpha")).toBe("alpha-hero");
		const profileText = await stores.content.readEntityTextFile(CHARS, "alpha-hero", "profile.md");
		expect(parseProfileMd(profileText!).storageId).toBe("char_alpha");

		// The legacy flat file is gone from data/characters/ and lives in the backup.
		const remaining = await readdir(join(dataRoot, CHARS));
		expect(remaining.some((n) => n.endsWith(".json"))).toBe(false);
		const backed = await readFile(join(dataRoot, "backups", "legacy", "char_alpha.json"), "utf8");
		expect(JSON.parse(backed).name).toBe("Alpha Hero");
	});

	test("is idempotent: a second run is a full no-op (no stamps, no renames, no archives)", async () => {
		const { dataRoot, stores } = await setup();
		await setupLegacyChar(dataRoot, stores.db, "char_oliver", "Oliver", { withFlat: true });
		const backupDir = join(dataRoot, "backups", "legacy");

		await migrateToReadableFolders(stores, { backupDir });
		const second = await migrateToReadableFolders(stores, { backupDir });

		expect(second.scanned).toBe(1);
		expect(second.failures).toEqual([]);
		expect(second.steps[0]!.action).toBe("already-migrated");
		expect(second.steps[0]!.stamped).toBe(false);
		expect(second.archived).toEqual([]);
		expect(await stores.characterDirectory.resolve("char_oliver")).toBe("oliver");
	});

	test("dry-run reports the planned stamp + rename but performs NO writes", async () => {
		const { dataRoot, stores } = await setup();
		await setupLegacyChar(dataRoot, stores.db, "char_dry", "Dry Run", { withFlat: true });

		const report = await migrateToReadableFolders(stores, { dryRun: true, backupDir: join(dataRoot, "backups", "legacy") });

		expect(report.steps[0]).toMatchObject({ characterId: "char_dry", from: "char_dry", to: "dry-run", action: "renamed", stamped: true });
		// Nothing actually changed: dir still opaque, profile still unstamped, flat still present.
		expect(await stores.characterDirectory.resolve("char_dry")).toBe("char_dry");
		const profileText = await stores.content.readEntityTextFile(CHARS, "char_dry", "profile.md");
		expect(parseProfileMd(profileText!).storageId).toBeNull();
		// The flat file was NOT moved (dry-run performs no writes): still on disk.
		const flatStillPresent = await stores.content.findLegacyFlatFile(CHARS, "char_dry");
		expect(flatStillPresent).not.toBeNull();
		expect(report.archived).toEqual([]); // dry-run never archives
	});

	test("a degenerate (non-ASCII) display name keeps the opaque-id directory but still stamps storage_id", async () => {
		const { dataRoot, stores } = await setup();
		await setupLegacyChar(dataRoot, stores.db, "char_andrea", "Андреа");

		const report = await migrateToReadableFolders(stores);

		expect(report.steps[0]).toMatchObject({ characterId: "char_andrea", from: "char_andrea", to: "char_andrea", action: "storage-id-stamped", stamped: true });
		expect(await stores.characterDirectory.resolve("char_andrea")).toBe("char_andrea");
		const profileText = await stores.content.readEntityTextFile(CHARS, "char_andrea", "profile.md");
		expect(parseProfileMd(profileText!).storageId).toBe("char_andrea");
	});

	test("two same-name legacy characters suffix deterministically (stable id order)", async () => {
		const { dataRoot, stores } = await setup();
		await setupLegacyChar(dataRoot, stores.db, "char_o1", "Oliver");
		await setupLegacyChar(dataRoot, stores.db, "char_o2", "Oliver");

		const report = await migrateToReadableFolders(stores);

		expect(report.steps.map((s) => s.to)).toEqual(["oliver", "oliver-2"]);
		expect(await stores.characterDirectory.resolve("char_o1")).toBe("oliver");
		expect(await stores.characterDirectory.resolve("char_o2")).toBe("oliver-2");
	});

	test("a character whose profile.md is missing is bootstrapped via migrateToVtf (with storage_id)", async () => {
		const { dataRoot, stores } = await setup();
		await setupLegacyChar(dataRoot, stores.db, "char_novtf", "NoVtf", { noProfile: true });

		const report = await migrateToReadableFolders(stores);

		expect(report.steps[0]!.action).toBe("renamed");
		expect(report.steps[0]!.stamped).toBe(true);
		expect(await stores.characterDirectory.resolve("char_novtf")).toBe("novtf");
		const profileText = await stores.content.readEntityTextFile(CHARS, "novtf", "profile.md");
		expect(parseProfileMd(profileText!).storageId).toBe("char_novtf");
	});

	test("a missing profile under a degenerate name reports vtf-created without renaming", async () => {
		const { dataRoot, stores } = await setup();
		await setupLegacyChar(dataRoot, stores.db, "char_novtfdeg", "Андреа", { noProfile: true });

		const report = await migrateToReadableFolders(stores);

		expect(report.steps[0]).toMatchObject({ characterId: "char_novtfdeg", from: "char_novtfdeg", to: "char_novtfdeg", action: "vtf-created", stamped: true });
		const profileText = await stores.content.readEntityTextFile(CHARS, "char_novtfdeg", "profile.md");
		expect(parseProfileMd(profileText!).storageId).toBe("char_novtfdeg");
	});

	test("an already-migrated character (stamped + readable) is a no-op", async () => {
		const { stores } = await setup();
		// The modern create() path already stamps storage_id + a readable name.
		const char = await stores.characters.create({ name: "Modern", description: "x" });

		const report = await migrateToReadableFolders(stores);

		const step = report.steps.find((s) => s.characterId === char.id)!;
		expect(step.action).toBe("already-migrated");
		expect(step.from).toBe(step.to);
	});

	test("after migration, a fresh registry (simulated restart) resolves every character by storage_id", async () => {
		const { dataRoot, dbPath } = await setup();
		// First container builds + migrates legacy state.
		const stores1 = await createStoreContainer(dbPath, dataRoot);
		await setupLegacyChar(dataRoot, stores1.db, "char_restart", "Restart Hero");
		await migrateToReadableFolders(stores1);
		expect(await stores1.characterDirectory.resolve("char_restart")).toBe("restart-hero");

		// A brand-new container over the SAME db + dataDir simulates a restart:
		// it scans profile.md storage_id and resolves at the readable name without
		// any migration call.
		const stores2 = await createStoreContainer(dbPath, dataRoot);
		expect(await stores2.characterDirectory.resolve("char_restart")).toBe("restart-hero");
		expect((await stores2.characters.getById("char_restart"))?.name).toBe("Restart Hero");
	});

	test("a profile.md with unknown frontmatter/sections is preserved losslessly by the surgical stamp", async () => {
		const { dataRoot, stores } = await setup();
		const dir = join(dataRoot, CHARS, "char_custom");
		await mkdir(dir, { recursive: true });
		// Hand-authored profile with an unknown frontmatter key + a custom body
		// section, and NO storage_id.
		const authored = [
			"---",
			"name: Custom",
			"vt:",
			"  mes_example_mode: always",
			"  mes_example_depth: 4",
			"  custom_vt_key: keeps its value",
			"custom_top_key: preserved",
			"---",
			"",
			"# PERSONALITY",
			"",
			"body text",
			"",
			"# CUSTOM SECTION",
			"",
			"custom body",
			"",
		].join("\n");
		await writeFile(join(dir, "profile.md"), authored);
		await stores.db.run(sql`INSERT INTO characters (id, name, description, personality_summary, alternate_greetings_json, extensions_json, tags_json, mes_example_mode, mes_example_depth, status, has_file_on_disk, created_at, updated_at)
			 VALUES (${"char_custom"}, ${"Custom"}, 'desc', NULL, '[]', '{}', '[]', 'always', 4, 'active', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);

		await migrateToReadableFolders(stores);

		const restamped = await stores.content.readEntityTextFile(CHARS, "custom", "profile.md");
		const parsed = parseProfileMd(restamped!);
		expect(parsed.storageId).toBe("char_custom"); // stamped
		expect(parsed.unknownVt?.some((u) => u.key === "custom_vt_key")).toBe(true); // preserved
		expect(parsed.unknownFrontmatter?.some((u) => u.key === "custom_top_key")).toBe(true); // preserved
		expect(parsed.unknownSections?.some((s) => s.heading === "CUSTOM SECTION")).toBe(true); // preserved
	});
});
