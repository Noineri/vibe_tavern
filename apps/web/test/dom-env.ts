import { beforeAll, afterAll, afterEach, expect } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";

/**
 * Drain the React 19 scheduler's macrotask queue.
 *
 * React's `commitRoot` schedules `flushPassiveEffects()` via
 * `scheduleCallback(NormalPriority)` on a `MessageChannel` macrotask (see
 * react-dom-client.development.js `scheduleCallback$1` in commitRoot).
 * RTL's `cleanup()` flushes microtasks + sync work via `act()`, but does NOT
 * drain that macrotask queue. If `GlobalRegistrator.unregister()` deletes
 * `globalThis.window` while a passive-effect flush is still pending, the
 * deferred callback runs `schedulerEvent = window.event` against a missing
 * global → `TypeError: undefined is not an object (evaluating 'window.event')`,
 * surfacing in CI as "Unhandled error between tests" after all tests pass.
 *
 * Letting a bounded number of macrotask ticks elapse lets those callbacks fire
 * while `window` still exists. We loop rather than tick once because passive
 * effects can schedule further passive effects; five is a safe bounded drain
 * (no public "scheduler idle" signal exists to spin against).
 */
async function flushSchedulerQueue(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}

/**
 * Scoped DOM test environment for bun:test.
 *
 * Call `useDomEnv()` once at the top of any test file that renders React via
 * @testing-library/react. It registers a global happy-dom `window` for the
 * duration of THAT file only (register in beforeAll, unregister in afterAll),
 * extends `expect` with jest-dom matchers, and runs RTL cleanup after each test.
 *
 * WHY THIS IS SCOPED (not a bunfig preload)
 *   The repo has DOM-averse tests (avatar.test.ts, gateway-client, etc.) that
 *   rely on `typeof window === "undefined"` so e.g. getGatewayBaseUrl() returns
 *   its SSR fallback. A global preload that registers happy-dom permanently
 *   breaks those by injecting a window into their environment. Scoping the
 *   registration to the DOM files' own lifecycle keeps both worlds working:
 *   DOM files get a window while they run; pure-logic files never see one.
 *
 * jest-dom matchers are extended at module load (idempotent, global, harmless
 * to files that don't use them); the module is cached so this runs once even
 * when several DOM test files import it.
 */
expect.extend(matchers);

export function useDomEnv(): void {
  beforeAll(() => {
    GlobalRegistrator.register();
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(async () => {
    // Drain React 19's pending passive-effect macrotasks BEFORE destroying
    // `window` — otherwise a deferred `flushPassiveEffects` reads `window.event`
    // after unregister and throws (see flushSchedulerQueue above).
    await flushSchedulerQueue();
    GlobalRegistrator.unregister();
  });
}
