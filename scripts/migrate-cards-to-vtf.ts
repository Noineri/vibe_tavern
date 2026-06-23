/**
 * One-shot migration: convert every character's on-disk storage to the VTF
 * folder format (profile.md + instructions.json + extensions.json + greetings/).
 *
 * Reuses `CharacterStore.migrateToVtf` (reads the full content via getById,
 * writes the VTF folder, stamps content_hash + has_file_on_disk). Idempotent:
 * characters that already have a profile.md are skipped. Legacy `card.json` /
 * flat files are left in place (copy-forward); `getById` prefers `profile.md`.
 *
 * Usage:
 *   bun run scripts/migrate-cards-to-vtf.ts               # migrate (default DB)
 *   bun run scripts/migrate-cards-to-vtf.ts --dry-run      # report only, no writes
 *   bun run scripts/migrate-cards-to-vtf.ts path/to.db     # custom DB path
 *
 * ⚠ BACK UP data/vibe-tavern.db AND data/characters/ BEFORE running (the user's
 * standing instruction for any data write). The migration is idempotent and
 * leaves card.json as a backup, but a pre-run snapshot is still required.
 */
import { resolve, dirname } from "node:path";
import { createStoreContainer, STORAGE_FOLDERS } from "../packages/db/src/index.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbPath = resolve(args.find((a) => !a.startsWith("-")) ?? "data/vibe-tavern.db");
const dataDir = dirname(dbPath);

console.log(dryRun ? "=== VTF migration [DRY RUN] (no writes) ===" : "=== VTF migration ===");
console.log(`DB:      ${dbPath}`);
console.log(`dataDir: ${dataDir}`);
if (!dryRun) {
  console.log("⚠ Ensure you backed up the DB + data/characters/ before proceeding.");
}

const stores = await createStoreContainer(dbPath, dataDir);
const all = await stores.characters.listAll();
console.log(`Found ${all.length} character(s).`);

let migrated = 0;
let skipped = 0;
let failed = 0;

for (const char of all) {
  const label = `${char.id} (${char.name})`;
  try {
    if (dryRun) {
      const exists = await stores.content.entityLeafExists(STORAGE_FOLDERS.characters, char.id, "profile.md");
      if (exists) {
        skipped++;
        console.log(`  SKIP   ${label} — already VTF-native`);
      } else {
        migrated++;
        console.log(`  WOULD  ${label}`);
      }
      continue;
    }

    const hash = await stores.characters.migrateToVtf(char.id);
    if (hash === null) {
      skipped++;
      console.log(`  SKIP   ${label} — already VTF-native`);
    } else {
      migrated++;
      console.log(`  OK     ${label} — hash ${hash.slice(0, 12)}`);
    }
  } catch (err) {
    failed++;
    console.error(`  FAIL   ${label} — ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log("");
console.log(dryRun ? "Dry-run summary:" : "Migration summary:");
console.log(`  ${migrated} ${dryRun ? "would migrate" : "migrated"}`);
console.log(`  ${skipped} skipped (already VTF-native)`);
if (failed > 0) console.log(`  ${failed} FAILED`);
console.log(dryRun ? "" : "Done. getById now reads the VTF folder for migrated characters.");

process.exit(failed > 0 ? 1 : 0);
