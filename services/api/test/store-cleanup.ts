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

afterAll(() => closeAllDbs({ sweepSince: startedAt }));
