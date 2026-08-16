// bunfig.toml `[test] preload` entry for the packages/db suite.
//
// Same purpose as services/api/test/store-cleanup.ts: bun:test runs every file
// here in one process, each opening a real SQLite DB (or a temp dir for a file
// store) without closing/removing it. The preload's process-global afterAll
// closes every handle and sweeps the temp dirs created during the run
// (closeAllDbs with sweepSince). No-op when empty; never throws.

import { afterAll } from "bun:test";
import { closeAllDbs } from "../src/db-connection.js";

// Captured at preload import — before any test creates a temp dir — so the
// sweep only removes dirs created during THIS run.
const startedAt = Date.now();

afterAll(() => closeAllDbs({ sweepSince: startedAt }));
