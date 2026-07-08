import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * Vitest setup — runs once per test file before the tests.
 *
 * Replaces the two jobs `dom-env.ts` did under bun:test:
 *   1. extends `expect` with jest-dom matchers (`.toBeInTheDocument`, …);
 *   2. runs RTL `cleanup()` after each test so the DOM is isolated between
 *      cases (vitest's happy-dom environment already provides the `window` /
 *      `document` globals per file — no `GlobalRegistrator` needed).
 */
afterEach(() => {
  cleanup();
});

// Node 24.6+/25 enables an experimental native Web Storage API by default
// (nodejs/node#57666): `globalThis.localStorage` becomes a native getter that
// reads as `undefined` without `--localstorage-file`, and happy-dom — seeing
// the property already present — skips registering its own
// (vitest-dev/vitest#8757). The result: `localStorage.getItem` throws
// `Cannot read properties of undefined`. Restore the browser-like contract the
// tests rely on with an in-memory shim. No-op when happy-dom already won
// (older Node, or NODE_OPTIONS=--no-webstorage).
const __g = globalThis as { localStorage?: Storage | null };
if (!__g.localStorage || typeof __g.localStorage.getItem !== "function") {
  const __store = new Map<string, string>();
  const __shim: Storage = {
    getItem: (k) => __store.get(String(k)) ?? null,
    setItem: (k, v) => { __store.set(String(k), String(v)); },
    removeItem: (k) => { __store.delete(String(k)); },
    clear: () => { __store.clear(); },
    key: (i) => Array.from(__store.keys())[i] ?? null,
    get length() { return __store.size; },
  };
  try {
    Object.defineProperty(__g, "localStorage", { value: __shim, configurable: true, writable: true });
  } catch {
    // Native getter is non-configurable — run with NODE_OPTIONS=--no-webstorage.
  }
}
