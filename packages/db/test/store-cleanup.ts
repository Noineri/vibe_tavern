// bunfig.toml `[test] preload` entry for the packages/db suite.
//
// Same purpose as services/api/test/store-cleanup.ts: bun:test runs every file
// here in one process, each opening a real SQLite DB (or a temp dir for a file
// store) without closing/removing it. The preload's process-global afterAll
// closes every handle and sweeps the temp dirs created during the run
// (closeAllDbs with sweepSince). No-op when empty; never throws.

import { afterAll } from "bun:test";
import { closeAllDbs } from "../src/db-connection.js";
import { enableTestDbTemplate } from "../src/db-template.js";

// TS-1 (TEST_SUITE_SPEED_REPORT): serve eligible fresh test databases from a
// once-migrated template instead of replaying 122 migrations per test
// (~264 ms → <1 ms per build; this suite was ~260–315 s of almost pure
// migration replay). The template is built from the CURRENT migrations on
// every run by the first eligible createDb, and migration-dependent tests
// stay on the real path via override folders, pre-existing files, or the
// { realMigrations: true } per-call opt-out — see src/db-template.ts.
// Test preloads are the ONLY callers of this switch.
enableTestDbTemplate();

// Captured at preload import — before any test creates a temp dir — so the
// sweep only removes dirs created during THIS run.
const startedAt = Date.now();

// The explicit { timeout } is LOAD-BEARING for direct `bun test` runs (no
// --timeout flag, so bun's 5s hook default applies): the close + WAL temp-dir
// sweep can exceed 5s under load and bun then reports a PHANTOM `(unnamed)
// a beforeEach/afterEach hook timed out` failure attributed to the last file
// (see services/api/test/store-cleanup.ts for the full mechanism — same
// wiring here). Object-form hook options work on bun >= 1.3.13 (#24039).
afterAll(() => closeAllDbs({ sweepSince: startedAt }), { timeout: 60_000 });
