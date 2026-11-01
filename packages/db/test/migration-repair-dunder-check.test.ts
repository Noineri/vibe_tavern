import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

import { createDb } from "../src/db-connection.js";

/**
 * D4-REMAINING regression (PR65_CI_FAILURES_REPORT, fix step 2): the
 * gap-repair path — repairSkippedRebuilds — re-applies a skipped
 * table-rebuild migration by executing the OFFICIAL migration file's SQL,
 * and must run it through the same dunder-CHECK normalization as the
 * staged migrate() folder (D4d). Without it a rebuild whose CHECK
 * references `"__new_x"."col"` either fails the rename outright (old
 * SQLite — the macOS smoke failure) or survives with the qualification
 * rewritten to the FINAL table name (`"x"."col"` on SQLite ≥ 3.46), a
 * state the weaker "no `__new_` in sqlite_master" assertion cannot see.
 *
 * The scenario is the 0059 heal-gap (migration-null-backfill.test.ts): a
 * pre-existing legacy DB whose watermark was stamped PAST an eligible
 * rebuild (the rebuild tightens an existing nullable column to
 * `DEFAULT … NOT NULL` — what legacyShape detection keys on) without the
 * rebuild's own stamp, so migrate() never retries it and only the
 * gap-repair can apply it. The CHECK mirrors 0030's
 * provider_profiles_proxy_policy_check (real drizzle-kit emission shape).
 */

const W0 = 1_700_000_000_000;
const W1 = W0 + 1_000;
const W2 = W1 + 1_000;
const INIT_TAG = "0000_init";
const REBUILD_TAG = "0001_rebuild_proxy_check";
const MARKER_TAG = "0002_synthetic_marker";

// Legacy shape: `proxy_mode` nullable with no default — the pre-rebuild
// state whose tableNotNullFlags=0 makes the rebuild gap-repair ELIGIBLE.
const INIT_SQL = `CREATE TABLE \`provider_profiles\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`proxy_mode\` text,
	\`proxy_id\` text
);
`;

// The exact drizzle-kit rebuild shape (0030's provider_profiles rebuild):
// backticked declarations, the CHECK qualified with the temporary table
// name. The tightening column (`proxy_mode` DEFAULT 'inherit' NOT NULL)
// is what the repair's eligibility detection keys on; the qualified CHECK
// is the compatibility defect under test.
const REBUILD_SQL = `PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE \`__new_provider_profiles\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`proxy_mode\` text DEFAULT 'inherit' NOT NULL,
	\`proxy_id\` text,
	CONSTRAINT "provider_profiles_proxy_policy_check" CHECK(("__new_provider_profiles"."proxy_mode" = 'proxy' AND "__new_provider_profiles"."proxy_id" IS NOT NULL) OR ("__new_provider_profiles"."proxy_mode" IN ('inherit', 'direct') AND "__new_provider_profiles"."proxy_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO \`__new_provider_profiles\`("id", "proxy_mode", "proxy_id") SELECT "id", "proxy_mode", "proxy_id" FROM \`provider_profiles\`;--> statement-breakpoint
DROP TABLE \`provider_profiles\`;--> statement-breakpoint
ALTER TABLE \`__new_provider_profiles\` RENAME TO \`provider_profiles\`;--> statement-breakpoint
PRAGMA foreign_keys=ON;`;

// A trivial later migration playing 0060's role — the simple migration
// whose heal-stamp strands the rebuild behind the watermark.
const MARKER_SQL = "CREATE INDEX `idx_synthetic_marker` ON `provider_profiles` (`proxy_id`);";

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

function journalEntry(idx: number, when: number, tag: string): JournalEntry {
  return { idx, version: "6", when, tag, breakpoints: true };
}

async function writeFolder(folder: string, includeRebuild: boolean): Promise<void> {
  await mkdir(resolve(folder, "meta"), { recursive: true });
  await Bun.write(resolve(folder, `${INIT_TAG}.sql`), INIT_SQL);
  const entries = [journalEntry(0, W0, INIT_TAG)];
  if (includeRebuild) {
    await Bun.write(resolve(folder, `${REBUILD_TAG}.sql`), REBUILD_SQL);
    await Bun.write(resolve(folder, `${MARKER_TAG}.sql`), MARKER_SQL);
    entries.push(journalEntry(1, W1, REBUILD_TAG), journalEntry(2, W2, MARKER_TAG));
  }
  await Bun.write(resolve(folder, "meta", "_journal.json"), JSON.stringify({
    version: "7",
    dialect: "sqlite",
    entries,
  }));
}

describe("repairSkippedRebuilds executes rename-safe (dunder-CHECK) SQL", () => {
  test("gap-repair re-applies a skipped dunder-CHECK rebuild with unqualified CHECK refs", async () => {
    // Scratch dir lives under the spot-run wrapper's private swept TEMP
    // root (migration-null-backfill.test.ts precedent — no manual rm:
    // closing the WAL handles and removing the tree race on Windows).
    const work = await mkdtemp(join(tmpdir(), "vt-repair-dunder-"));
    const dbPath = join(work, "test.db");
    const folderBase = join(work, "base", "drizzle");
    const folderFull = join(work, "full", "drizzle");
    await writeFolder(folderBase, false);
    await writeFolder(folderFull, true);

    // A pre-existing legacy DB: baseline applied, `proxy_mode` still
    // nullable, one row holding a legacy NULL in the tightening column.
    const legacy = await createDb(dbPath, folderBase);
    legacy.$client.close();
    const raw = new Database(dbPath);
    raw.run("INSERT INTO provider_profiles (id, proxy_mode, proxy_id) VALUES ('pp1', NULL, NULL)");
    // The gap state: the LATER migration got stamped (watermark = W2 >
    // W1) while the rebuild stayed unstamped — migrate() alone never
    // retries it, so only the gap-repair can apply the rebuild.
    const markerHash = new Bun.CryptoHasher("sha256").update(MARKER_SQL).digest("hex");
    raw.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [markerHash, W2]);
    raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    raw.close();

    // The boot under test. migrate() has nothing pending (the watermark
    // covers every journal entry), so this createDb reaches the gap in
    // repairSkippedRebuilds — which executes the OFFICIAL file's SQL and
    // must normalize the dunder-qualified CHECK on that path too.
    const db = await createDb(dbPath, folderFull);
    db.$client.close();

    // (a) After reopen, the rebuilt table's CHECK is UNQUALIFIED — the
    // exact form normalized execution produces, not merely absence of
    // `__new_`: SQLite ≥ 3.46 silently rewrites the qualification to the
    // FINAL table name at RENAME, hiding the defect from weaker
    // assertions (old SQLite fails the boot outright instead).
    const probe = new Database(dbPath, { readonly: true });
    const schemaSql = (probe
      .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'provider_profiles'")
      .get() as { sql: string }).sql;
    probe.close();
    expect(schemaSql).toContain(`CHECK(("proxy_mode" = 'proxy'`);
    expect(schemaSql).not.toContain(`"provider_profiles".`);
    expect(schemaSql).not.toContain(`__new_`);

    // (b) The CHECK is live: an invalid row is rejected on the reopened DB.
    const live = new Database(dbPath);
    expect(() =>
      live.exec("INSERT INTO provider_profiles (id, proxy_mode, proxy_id) VALUES ('reject-me', 'proxy', NULL)")
    ).toThrow();

    // (c) Pre-existing valid data survived the repair — the legacy NULL
    // was backfilled to the tightening DEFAULT, everything else intact.
    const kept = live
      .query("SELECT proxy_mode, proxy_id FROM provider_profiles WHERE id = 'pp1'")
      .get() as { proxy_mode: string | null; proxy_id: string | null };
    expect(kept.proxy_mode).toBe("inherit");
    expect(kept.proxy_id).toBeNull();
    expect((live.query("SELECT COUNT(*) AS n FROM provider_profiles").get() as { n: number }).n).toBe(1);
    live.close();

    // (d) Exactly ONE stamp carrying the OFFICIAL (raw) file hash — the
    // ledger notion every other path reads — stamped at the journal
    // `when` (W1), with no double stamps anywhere in the ledger.
    const rebuildHash = new Bun.CryptoHasher("sha256").update(REBUILD_SQL).digest("hex");
    const ledger = new Database(dbPath, { readonly: true });
    const stamps = ledger
      .query("SELECT hash, created_at FROM __drizzle_migrations")
      .all() as { hash: string; created_at: number }[];
    ledger.close();
    expect(stamps.filter((s) => s.hash === rebuildHash)).toHaveLength(1);
    expect(stamps.find((s) => s.hash === rebuildHash)?.created_at).toBe(W1);
    expect(stamps).toHaveLength(3);
  });
});
