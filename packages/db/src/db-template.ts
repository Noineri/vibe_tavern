// Test-only migrated-template fast path for createDb (TS-1).
//
// Measured 2026-10-23 (vibe_tavern_plan/reports/TEST_SUITE_SPEED_REPORT.md):
// one createDb() replays all 122 drizzle migrations — ~264 ms per call, ~82 %
// of it raw SQL execution — and both heavy suites build a fresh DB per test,
// so migration replay was essentially the whole db-suite time (~260–315 s)
// and ~60–70 % of the api suite (~250–300 s). A bun:sqlite serialize()/
// deserialize() clone of a once-migrated template costs <1 ms and is provably
// identical to a fresh migration (sqlite_master, __drizzle_migrations,
// user_version, integrity — proven in test/db-template.test.ts; the only
// pragma that does not survive deserialization is foreign_keys, which the
// clone path re-executes explicitly).
//
// SAFETY BOUNDS (fixed by the TS-1 fix step):
//  - enableTestDbTemplate() is called ONLY from the two test preloads
//    (packages/db/test/store-cleanup.ts, services/api/test/store-cleanup.ts);
//    nothing in src/ calls it. With the switch off, createDb behaves exactly
//    as today — production and every other workspace are untouched.
//  - The template is built from the CURRENT migrations on every run (the
//    first eligible createDb runs the full real path into :memory:), never
//    from a committed snapshot — it cannot go stale.
//  - Eligibility: no migrationsFolderOverride, no { realMigrations: true }
//    opt-out, and either :memory: or a file path that does not exist yet.
//    Override folders and pre-existing files run today's full real path
//    unchanged — which is what keeps every migration-dependent test real.

import type { Database } from 'bun:sqlite';

/** Per-call opt-out for tests whose subject IS the real migration path
 *  (drizzle journal replay, healing, repair passes). Passed to createDb as
 *  `createDb(path, undefined, { realMigrations: true })`. */
export interface CreateDbOptions {
  realMigrations?: boolean;
}

let enabled = false;
let building = false;
let templateBytes: Promise<Uint8Array> | null = null;

/** Enable the template fast path. Test preloads only — see the file header. */
export function enableTestDbTemplate(): void {
  enabled = true;
}

/** Whether createDb should serve this call from the template. */
export async function shouldCloneFromTemplate(
  dbPath: string,
  migrationsFolderOverride: string | undefined,
  options: CreateDbOptions | undefined,
): Promise<boolean> {
  // `building`: the template build itself goes through createDb(':memory:')
  // and must run the real path, not re-enter the clone branch.
  if (!enabled || building) return false;
  if (migrationsFolderOverride !== undefined) return false;
  if (options?.realMigrations === true) return false;
  if (dbPath === ':memory:') return true;
  return !(await Bun.file(dbPath).exists());
}

/**
 * The template image, built on first use by running the REAL createDb path
 * into :memory: and serializing the result. `buildReal` must be that real
 * path; the `building` flag keeps its own createDb(':memory:') call out of
 * the clone branch. The serialized handle is closed right after — the
 * template is pristine schema (a fresh migration inserts no data rows), and
 * an open handle would leak into the test-cleanup registry's sweep.
 *
 * A failed build resets the memo (the awaiting caller still sees the error),
 * so the next eligible call retries the real path from scratch instead of
 * every later call failing with the same cached rejection.
 */
export async function getDbTemplateBytes(buildReal: () => Promise<Database>): Promise<Uint8Array> {
  if (templateBytes === null) {
    building = true;
    const build = (async () => {
      try {
        const sqlite = await buildReal();
        const bytes = sqlite.serialize();
        sqlite.close();
        return bytes;
      } finally {
        building = false;
      }
    })();
    build.catch(() => {
      templateBytes = null;
    });
    templateBytes = build;
  }
  return templateBytes;
}
