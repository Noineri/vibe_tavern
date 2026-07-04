/**
 * Debug Vite config — an unminified dev server that proxies /api + /assets to a
 * running API, so React/component errors come back with readable stacks instead
 * of minified codes (e.g. `React #185` → full "Maximum update depth" + component
 * tree). Use this when chasing a frontend crash; use plain `dev:web` otherwise.
 *
 * Run:  bun run dev:web:debug     (root script → @vibe-tavern/web dev:debug)
 * Then: open http://localhost:4173 (the API it proxies to must already be up
 *        on the agent test port — :8787 — e.g. `RP_PLATFORM_PORT=8787 bun run dev`).
 *
 * Why a separate file (not folded into vite.config.ts): the production `dev:web`
 * intentionally has NO proxy — VT's frontend and API are served from the same
 * origin in dev (the API serves the built web bundle), so a proxy would be dead
 * weight on the normal path. This file is the opt-in escape hatch for live
 * browser debugging only. Vite loads `vite.config.ts` by default, so a
 * differently-named config never interferes with normal dev/build unless
 * `--config` points at it.
 */
import { defineConfig } from "vite";
import base from "./vite.config.js";

export default defineConfig({
	...base,
	server: {
		port: 4173,
		proxy: {
			"/api": { target: "http://localhost:8787", changeOrigin: true },
			"/assets": { target: "http://localhost:8787", changeOrigin: true },
			"/socket": { target: "ws://localhost:8787", ws: true },
		},
	},
});
