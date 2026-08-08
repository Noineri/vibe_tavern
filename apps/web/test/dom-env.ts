import { afterAll, afterEach, expect } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

let registeredByDomEnv = false;

/** Longest `outerHTML` snippet an inspected node prints before it is elided. */
const INSPECT_HTML_LIMIT = 2000;

/**
 * Teach Bun how to print a happy-dom node.
 *
 * Bun's `expect` builds its failure message by inspecting `received`. happy-dom
 * nodes are plain objects whose own properties include the listener maps, the
 * mutation-observer registry, the selector caches and a `[Symbol(ownerDocument)]`
 * back-reference to the whole document — so the default inspector walks the
 * entire tree and emits hundreds of kilobytes per failed assertion.
 *
 * That is slow enough to be a correctness problem, not just noise: one failed
 * `expect(element).toBeNull()` measured ~270ms on an idle 16-core box. Inside a
 * `waitFor` retry loop — where the assertion fails on every poll until the DOM
 * catches up — those blocking serializations starve the timers and animation
 * frames that would have produced the awaited change, so the wait cannot win the
 * race it is waiting on. On CI this blew past both the `waitFor` budget and the
 * test timeout (a 15s test observed taking 22.4s) and turned two accordion
 * collapse tests red on Linux and Windows.
 *
 * `Symbol.for("nodejs.util.inspect.custom")` is the supported hook for this, and
 * Bun honours it. Printing `outerHTML` drops the same assertion to ~0.6ms and
 * makes the message readable (`Received: <div data-testid="body">…`) instead of
 * a screenful of symbol soup.
 */
function installNodeInspector(): void {
  const inspect = Symbol.for("nodejs.util.inspect.custom");
  if (Object.getOwnPropertyDescriptor(Node.prototype, inspect)) return;

  Object.defineProperty(Node.prototype, inspect, {
    value: function inspectNode(this: Node): string {
      const html = this instanceof Element ? this.outerHTML : this.nodeValue;
      if (html === null) return `[${this.nodeName}]`;
      return html.length > INSPECT_HTML_LIMIT
        ? `${html.slice(0, INSPECT_HTML_LIMIT)}… (${html.length} chars)`
        : html;
    },
    configurable: true,
    writable: true,
  });
}

function ensureDomEnvRegistration(): void {
  if (typeof globalThis.window === "undefined") {
    GlobalRegistrator.register();
    registeredByDomEnv = true;
  }
  installNodeInspector();
}

ensureDomEnvRegistration();

/**
 * EVERY `@testing-library/*` import in this file must be dynamic and sit below
 * this line. That is load-bearing, not style.
 *
 * `@testing-library/dom` binds its `screen` export to `document.body` while its
 * own module evaluates. Evaluate it with no global `document` and every `screen`
 * query becomes a throwing stub — permanently, for the rest of the process, no
 * matter what registers a `window` afterwards. Only `await import(...)` placed
 * after `ensureDomEnvRegistration()` is ordered against that: Bun does NOT
 * evaluate a module's static imports in source order (a bare specifier can win
 * over a relative one), so a static import cannot be made safe by moving it up.
 *
 * This bit for real: `@testing-library/jest-dom` 6.10 started importing
 * `@testing-library/dom` (for its new `toContainAnyBy*` / `toContainOneBy*`
 * matchers), which turned the previously inert `import * as matchers` at the top
 * of this file into a poisoned `screen` in every DOM test file at once.
 *
 * The `default` strip below is not cosmetic either: `matchers-standalone.d.ts`
 * declares `export =`, so TypeScript models the dynamic namespace as having a
 * `default` that the ESM build does not actually emit. `expect.extend()` rejects
 * the extra key, and it would be `undefined` at runtime anyway.
 */
const { default: _cjsInteropDefault, ...matchers } = await import("@testing-library/jest-dom/matchers");
const { cleanup } = await import("@testing-library/react");

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
 * duration of THAT file only (register at module load, unregister in afterAll),
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
  ensureDomEnvRegistration();

  afterEach(() => {
    cleanup();
  });

  afterAll(async () => {
    // Drain React 19's pending passive-effect macrotasks BEFORE destroying
    // `window` — otherwise a deferred `flushPassiveEffects` reads `window.event`
    // after unregister and throws (see flushSchedulerQueue above).
    await flushSchedulerQueue();
    if (registeredByDomEnv) GlobalRegistrator.unregister();
  });
}
