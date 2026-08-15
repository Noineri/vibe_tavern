import { afterAll, afterEach, expect } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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
 * drain that macrotask queue. Draining a bounded number of macrotask ticks
 * between files lets those callbacks fire while the file's tree is still
 * mounted, so no stale effect fires into the NEXT file's DOM.
 *
 * Letting a bounded number of macrotask ticks elapse lets those callbacks fire
 * while the file's effects are still relevant. We loop rather than tick once
 * because passive effects can schedule further passive effects; five is a safe
 * bounded drain (no public "scheduler idle" signal exists to spin against).
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
 * PROCESS lifetime, extends `expect` with jest-dom matchers, and runs RTL
 * cleanup after each test.
 *
 * WHY REGISTER-ONCE-AND-NEVER-UNREGISTER (not a per-file unregister)
 *   This module's own top-level `await import("@testing-library/react")`
 *   evaluates React and RTL exactly ONCE per process — against whichever
 *   window the FIRST file's registration created. `GlobalRegistrator
 *   .unregister()` closes that window (`happyDOM.close()`); once closed, React
 *   updates stop flushing — a `setState` in a resolved promise callback never
 *   re-renders (reproduced with a minimal two-file probe pair: file A registers
 *   + unregisters, file B's fetch→setState→rerender chain hangs forever) — so
 *   EVERY DOM test file after the first fails in a shared-process run. Keeping
 *   the window alive for the process is the only shape that survives multiple
 *   DOM files in one `bun test` process.
 *
 * WHY THIS IS STILL SCOPED (not a bunfig preload)
 *   The repo has DOM-averse tests (avatar.test.ts, gateway-client, etc.) that
 *   rely on `typeof window === "undefined"` so e.g. getGatewayBaseUrl()
 *   returns its SSR fallback. A global preload that registers happy-dom for
 *   EVERY file breaks those. Registering only when a DOM file imports this
 *   helper keeps pure-logic files windowless in the supported gate — the
 *   per-file process runner (`scripts/test-web.ts`) gives each file its own
 *   process, so a window registered by one file can never leak into another.
 *   (Hand-rolled combined runs that mix DOM files with DOM-averse files in one
 *   process are not supported: the window stays up once any DOM file ran.)
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
    // Settle this file's pending passive-effect macrotasks before the next
    // file mounts its own tree (see flushSchedulerQueue above). The window
    // itself is NEVER unregistered — see the header comment.
    await flushSchedulerQueue();
  });
}
