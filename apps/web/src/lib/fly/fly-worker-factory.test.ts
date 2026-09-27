/**
 * Fly worker-URL resolution pins (FLY_TRIBUNAL_PLAN FT-6): same contract as
 * the Kokoro factory — the production factory must point at the fixed
 * `assets/fly-worker.js` entrypoint that FT-7 adds to `scripts/build-web.ts`;
 * the dev factory loads the raw future `.ts` source. If production regresses
 * to the `new URL(...)` form, the worker 404s and brain loading stalls.
 *
 * L1 checklist:
 * 1. Paths: no filesystem paths.
 * 2. Restores: no process-global state changes.
 * 3. Determinism: pure URL assertions; no waits.
 * 4. Platform: URL shape only, no OS separators.
 * 5. Shared worker pool: no mocks or registries.
 * 6. Stable state: deterministic pure-function output.
 */

import { describe, expect, test } from "bun:test";

import { flyWorkerUrl } from "./fly-worker-factory.js";

describe("flyWorkerUrl", () => {
  test("dev: resolves the raw worker source next to this module", () => {
    const url = flyWorkerUrl(false);
    expect(url).toContain("fly-worker.ts");
  });

  test("prod: the fixed worker asset + app-version cache-bust", () => {
    const url = flyWorkerUrl(true);
    expect(url.startsWith("/assets/fly-worker.js?v=")).toBe(true);
    expect(url.length > "/assets/fly-worker.js?v=".length).toBe(true);
  });

  test("prod URL never leaks the dev .ts form", () => {
    expect(flyWorkerUrl(true)).not.toContain("fly-worker.ts");
  });
});
