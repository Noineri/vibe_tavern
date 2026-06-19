import { beforeAll, afterAll, afterEach, expect } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";

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

  afterAll(() => {
    GlobalRegistrator.unregister();
  });
}
