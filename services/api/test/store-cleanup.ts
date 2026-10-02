// bunfig.toml `[test] preload` entry for the services/api suite.
//
// bun:test runs every file in this workspace in ONE process, and each test
// opens a real SQLite DB (or spins up a temp dir for a file store) without
// closing/removing it. That leaks file handles, and on Windows the open
// WAL/SHM handles make `rm` of the temp dir fail with EBUSY — so the dirs
// accumulate (12k+ observed at peak).
//
// Registering afterAll at the top level of a preloaded module makes bun treat
// it as a process-global hook that fires ONCE after every test file has run
// (verified). closeAllDbs() then closes every opened handle and sweeps the
// os.tmpdir() entries created during this run (prefix + mtime guarded, so it
// never touches unrelated files). No-op when nothing was opened; never throws.

import { afterAll } from "bun:test";
import { closeAllDbs } from "@vibe-tavern/db";

// Captured at preload import — before any test creates a temp dir — so the
// sweep only removes dirs created during THIS run.
const startedAt = Date.now();

// The explicit { timeout } is LOAD-BEARING for direct `bun test` runs (no
// --timeout flag, so bun's 5s hook default applies): closing hundreds of
// SQLite handles + sweeping their WAL temp dirs is cleanup work whose wall
// time scales with suite size and machine contention. Measured worst cases:
// ~26s (2026-09, suite ≈ 3.3k tests), 66.9s under full `bun run check` load
// with 7 suites on the pool (2026-09-12, suite 3456 tests) — that run burst
// the then-60s budget and bun reported a PHANTOM `(unnamed) — a
// beforeEach/afterEach hook timed out` failure attributed to whichever file
// ran LAST (observed pinned on vision-gate.test.ts, then lore-parity-diff.
// test.ts; it moves with discovery order). The object-form options work on
// bun >= 1.3.13 (oven-sh/bun#24039); the old numeric form `afterAll(fn, ms)`
// never did — scripts/test.ts documents that older finding. 180s = >2.5x the
// worst measured sweep; it bounds a real hang without costing anything in the
// green path (a timeout only fires when exceeded — it never adds delay).
afterAll(() => closeAllDbs({ sweepSince: startedAt }), { timeout: 180_000 });
