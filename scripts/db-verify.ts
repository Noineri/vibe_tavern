/**
 * DB verification harness — read-only row-count + content-checksum per table.
 *
 * Safety gate for migration squashing / rebasing on a real user DB. The rule is
 * simple: a schema-only squash must move ZERO user rows. This tool snapshots the
 * full data shape to JSON, so a before/after diff proves (or disproves) that.
 *
 * WAL note: open the DB only while the server is STOPPED. The harness opens
 * read-only via PRAGMA query_only, but a live writer can still change what we
 * read mid-scan. Stop the server, snapshot, mutate, snapshot, compare.
 *
 * Usage:
 *   bun run scripts/db-verify.ts dump  <dbPath>                 # → stdout: JSON
 *   bun run scripts/db-verify.ts dump  <dbPath> > state.json    # save snapshot
 *   bun run scripts/db-verify.ts compare <before.json> <after.json>
 *
 * Checksum design: for each table, rows are read ORDER BY rowid (stable for
 * rowid tables, which all VT tables are), each row is canonicalised to
 * `col=value|...` with sorted column names, and the concatenation is sha256'd.
 * A table with the same count AND same checksum after a migration lost nothing
 * and changed nothing. count-differ → rows lost/gained (the danger);
 * checksum-differ with same count → in-place content mutation (should not happen
 * in a pure schema squash; if it does, drill in with --rows).
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

interface TableSnap {
  count: number;
  checksum: string;
  columns: string[];
}
interface Snapshot {
  dbPath: string;
  takenAt: string;
  tables: Record<string, TableSnap>;
}

function userTables(db: Database): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '__drizzle%' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function hashStr(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}

function snapshotTable(db: Database, table: string): TableSnap {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as {
    name: string;
  }[];
  const colNames = cols.map((c) => c.name).sort();
  const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Record<
    string,
    unknown
  >[];
  // Canonical row: sorted col=value pairs, joined by |. Null → "\0null".
  const canonicalRows = rows.map((row) =>
    colNames
      .map((c) => `${c}=${row[c] === null ? "\0null" : String(row[c])}`)
      .join("|"),
  );
  const checksum = hashStr(canonicalRows.join("\n"));
  return { count: rows.length, checksum, columns: colNames };
}

function dump(dbPath: string): void {
  const db = new Database(dbPath, { readonly: true });
  db.exec("PRAGMA query_only = ON");
  const tables = userTables(db);
  const snap: Snapshot = {
    dbPath,
    takenAt: new Date().toISOString(),
    tables: {},
  };
  let totalRows = 0;
  for (const t of tables) {
    snap.tables[t] = snapshotTable(db, t);
    totalRows += snap.tables[t].count;
  }
  db.close();
  console.log(JSON.stringify(snap, null, 2));
  process.stderr.write(
    `[db-verify] snapshotted ${tables.length} tables, ${totalRows} rows from ${dbPath}\n`,
  );
}

function compare(beforePath: string, afterPath: string): void {
  const before = JSON.parse(readFileSync(beforePath, "utf8")) as Snapshot;
  const after = JSON.parse(readFileSync(afterPath, "utf8")) as Snapshot;

  const allTables = new Set([...Object.keys(before.tables), ...Object.keys(after.tables)]);
  const report: string[] = [];
  let lost = false;
  let changed = false;

  for (const t of [...allTables].sort()) {
    const b = before.tables[t];
    const a = after.tables[t];
    if (!b) {
      report.push(`  + ${t}: NEW table (${a!.count} rows)`);
      changed = true;
      continue;
    }
    if (!a) {
      report.push(`  - ${t}: TABLE GONE (was ${b.count} rows)`);
      lost = true;
      continue;
    }
    const countDelta = a.count - b.count;
    const checksumMatch = a.checksum === b.checksum;
    if (countDelta === 0 && checksumMatch) {
      report.push(`  = ${t}: ${a.count} rows, unchanged`);
    } else {
      const tag = countDelta < 0 ? "ROWS LOST" : countDelta > 0 ? "rows gained" : "content changed";
      report.push(
        `  ! ${t}: ${b.count}→${a.count} (Δ${countDelta > 0 ? "+" : ""}${countDelta}), ${tag}` +
          (checksumMatch ? "" : ", checksum differs"),
      );
      if (countDelta < 0) lost = true;
      else changed = true;
    }
  }

  console.log(report.join("\n"));
  if (lost) {
    console.log("\n RESULT: DATA LOSS — restore from backup. Do not ship.");
    process.exit(1);
  } else if (changed) {
    console.log("\n RESULT: tables changed but no rows lost — inspect by hand.");
    process.exit(2);
  } else {
    console.log("\n RESULT: identical — zero data movement. Safe.");
    process.exit(0);
  }
}

const [mode, ...args] = process.argv.slice(2);
if (import.meta.main) {
  if (mode === "dump" && args[0]) {
    dump(args[0]);
  } else if (mode === "compare" && args[0] && args[1]) {
    compare(args[0], args[1]);
  } else {
    console.error(
      "Usage:\n  bun run scripts/db-verify.ts dump <dbPath>\n  bun run scripts/db-verify.ts compare <before.json> <after.json>",
    );
    process.exit(64);
  }
}

// Exported for programmatic use / testing.
export { dump, compare, snapshotTable, userTables };
export type { Snapshot, TableSnap };
