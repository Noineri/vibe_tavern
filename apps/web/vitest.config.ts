import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

/**
 * Vitest config for @vibe-tavern/web.
 *
 * Reuses the Vite config (plugins: react, tailwind, data-component; the
 * `@vibe-tavern/*` path aliases; `__APP_VERSION__` define) so tests transform
 * through the same pipeline as the build — no second source of truth for how
 * `.ts`/`.tsx` + Tailwind + aliases resolve.
 *
 * `environment: "happy-dom"` — vitest owns the DOM global registration per
 * file (no `GlobalRegistrator`/`useDomEnv()` needed). happy-dom over jsdom for
 * speed; Base UI Drawer renders correctly under it (verified). `setupFiles`
 * extends `expect` with jest-dom matchers and runs RTL cleanup after each test
 * (the two jobs `test/dom-env.ts` did for bun:test).
 *
 * Runner scope: this file covers apps/web only. `packages/*` and `services/api`
 * stay on `bun:test` (pure-logic tests where bun:test is faster and sufficient).
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "happy-dom",
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      setupFiles: ["./test/vitest-setup.ts"],
      // Tests import `@vibe-tavern/*` (aliased above) and relative `.js`
      // extensions on `.ts` source — same ESM resolution Vite uses for the app.
      pool: "forks",
    },
  }),
);
