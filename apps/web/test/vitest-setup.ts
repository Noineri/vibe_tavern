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
