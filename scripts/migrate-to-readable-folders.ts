/**
 * HUMAN_READABLE_FOLDERS — HRF-5 one-shot migration CLI.
 *
 * Converts the pre-HRF-4 on-disk layout (opaque character-id directories +
 * profile.md documents that may predate the `vt.storage_id` identity stamp) to
 * the readable, identity-stamped layout the live registry expects, then
 * (optionally) moves root-level legacy flat cards into a timestamped backup.
 *
 * The heavy lifting lives in the testable {@link migrateToReadableFolders}
 * function (packages/db/src/migration/readable-folders.ts); this script is the
 * thin CLI wrapper + final audit.
 *
 * Usage:
 *   bun run scripts/migrate-to-readable-folders.ts               # migrate
 *   bun run scripts/migrate-to-readable-folders.ts --dry-run      # report only
 *   bun run scripts/migrate-to-readable-folders.ts --no-archive   # skip flat-file archival
 *   bun run scripts/migrate-to-readable-folders.ts path/to.db     # custom DB path
 *
 * ⚠ BACK UP data/vibe-tavern.db AND data/characters/ BEFORE running for real
 * (the user's standing instruction for any data write). The migration is
 * idempotent and never deletes (flat files are MOVED to a backup), but a
 * pre-run snapshot is still required.
 */
import { resolve, dirname } from "node:path";
import { parseArgs } from "node:util";
import { createStoreContainer, migrateToReadableFolders } from "../packages/db/src/index.js";

const rawArgs = process.argv.slice(2);
const options = {
  "dry-run": { type: "boolean" },
  "no-archive": { type: "boolean" },
} as const;
const initial = parseArgs({
  args: rawArgs,
  options,
  strict: false,
  allowPositionals: true,
  tokens: true,
});
const args = [...new Set(initial.tokens.flatMap((token) =>
  token.kind === "option-terminator" ? [] : [token.index]
))].flatMap((index) => {
  const arg = rawArgs[index];
  return arg === undefined ? [] : [arg];
});
const { values, positionals } = parseArgs({
  args,
  options,
  strict: false,
  allowPositionals: true,
});
const dryRun = values["dry-run"] === true;
const noArchive = values["no-archive"] === true;
const dbPath = resolve(positionals[0] ?? "data/vibe-tavern.db");
const dataDir = dirname(dbPath);

console.log(dryRun ? "=== Readable-folder migration [DRY RUN] (no writes) ===" : "=== Readable-folder migration ===");
console.log(`DB:      ${dbPath}`);
console.log(`dataDir: ${dataDir}`);
console.log(`Archive: ${noArchive ? "disabled" : "enabled (root-level flat cards → data/backups/legacy-flat-<ts>/)"}`);
if (!dryRun) {
	console.log("⚠ Ensure you backed up the DB + data/characters/ before proceeding.");
}

const stores = await createStoreContainer(dbPath, dataDir);
const report = await migrateToReadableFolders(stores, { dryRun, archiveLegacyFlat: !noArchive });

const renamed = report.steps.filter((s) => s.action === "renamed").length;
const stamped = report.steps.filter((s) => s.stamped).length;
const already = report.steps.filter((s) => s.action === "already-migrated").length;
const degenerate = report.steps.filter((s) => s.action === "degenerate-name" || s.action === "storage-id-stamped" || s.action === "vtf-created").length;
const missing = report.steps.filter((s) => s.action === "missing").length;

for (const step of report.steps) {
	const label = `${step.characterId} (${step.name})`;
	const tag = dryRun ? "WOULD  " : "OK     ";
	if (step.action === "already-migrated") {
		console.log(`  SKIP   ${label} — already readable + stamped`);
	} else if (step.action === "missing") {
		console.error(`  WARN   ${label} — row exists but no directory on disk`);
	} else if (step.action === "renamed") {
		console.log(`  ${tag} ${label} — ${step.from} → ${step.to}${step.stamped ? " (+stamped storage_id)" : ""}`);
	} else {
		console.log(`  ${tag} ${label} — ${step.action} (dir ${step.from}${step.from !== step.to ? ` → ${step.to}` : ""})`);
	}
}

console.log("");
console.log(dryRun ? "Dry-run summary:" : "Migration summary:");
console.log(`  ${report.scanned} scanned`);
console.log(`  ${renamed} ${dryRun ? "would rename" : "renamed"} to readable`);
console.log(`  ${stamped} ${dryRun ? "would stamp/created" : "stamped/created"} storage_id`);
console.log(`  ${degenerate} degenerate-name (kept opaque id${dryRun ? "" : ", stamped"})`);
console.log(`  ${already} already migrated (no-op)`);
if (missing > 0) console.log(`  ${missing} MISSING directory`);
if (report.archived.length > 0) console.log(`  ${report.archived.length} flat card(s) archived`);
if (report.failures.length > 0) console.log(`  ${report.failures.length} FAILED`);
console.log("");

// Final audit: every active character resolves + reads back. Skipped in dry-run
// (no migration occurred) and when failures happened (state may be partial).
if (!dryRun && report.failures.length === 0) {
	let audited = 0;
	let auditFailed = 0;
	const all = await stores.characters.listAll();
	for (const char of all) {
		try {
			const dir = await stores.characterDirectory.resolve(char.id);
			if (dir === null) throw new Error("no directory");
			const readBack = await stores.characters.getById(char.id);
			if (!readBack) throw new Error("getById returned null");
			audited++;
		} catch (err) {
			auditFailed++;
			console.error(`  AUDIT FAIL ${char.id} — ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	console.log(`Audit: ${audited}/${all.length} characters resolve + read back${auditFailed === 0 ? "" : ` (${auditFailed} FAILED)`}`);
}

if (report.failures.length > 0) {
	for (const f of report.failures) console.error(`  FAILURE ${f.characterId} (${f.phase}): ${f.error}`);
}

console.log(dryRun ? "" : report.failures.length > 0 ? "Completed with failures — see above." : "Done.");
process.exit(report.failures.length > 0 ? 1 : 0);
