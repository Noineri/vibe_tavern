import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";
import { dataComponentPlugin } from "./vite-plugin-data-component.js";

// Mirrors scripts/_version.ts: VERSION env (set by release workflow) wins,
// falling back to root package.json for local dev.
const rootPkg = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as { version?: string };
const APP_VERSION = process.env.VERSION ?? rootPkg.version ?? "0.0.0-dev";
const UPDATE_API_BASE = (process.env.VT_UPDATE_API_BASE ?? "https://api.github.com/repos/Noineri/vibe_tavern").replace(/\/+$/, "");

export default defineConfig(({ command }) => ({
	plugins: [dataComponentPlugin(), react(), tailwindcss()],
	define: {
		"process.env.RP_WEB_APP_VERSION": JSON.stringify(APP_VERSION),
		"process.env.RP_WEB_UPDATE_API_BASE": JSON.stringify(UPDATE_API_BASE),
		"process.env.RP_WEB_MODE": JSON.stringify(command === "serve" ? "development" : "production"),
		"process.env.RP_WEB_API_URL": JSON.stringify(process.env.RP_WEB_API_URL ?? ""),
		"process.env.RP_WEB_DEFAULT_PROVIDER_LABEL": JSON.stringify(process.env.RP_WEB_DEFAULT_PROVIDER_LABEL ?? ""),
		"process.env.RP_WEB_DEFAULT_BASE_URL": JSON.stringify(process.env.RP_WEB_DEFAULT_BASE_URL ?? ""),
		"process.env.RP_WEB_DEFAULT_MODEL": JSON.stringify(process.env.RP_WEB_DEFAULT_MODEL ?? ""),
		"process.env.RP_WEB_FORCE_FIRST_RUN": JSON.stringify(process.env.RP_WEB_FORCE_FIRST_RUN ?? ""),
	},
	resolve: {
		alias: [
			// Browser-safe codec sub-path. MUST precede the generic "@vibe-tavern/db"
			// entry: alias rules apply first-match, and the generic string would
			// otherwise prefix-match "@vibe-tavern/db/codecs" into index.ts/codecs.
			{ find: "@vibe-tavern/db/codecs", replacement: fileURLToPath(new URL("../../packages/db/src/codecs.ts", import.meta.url)) },
			{ find: "@vibe-tavern/api", replacement: fileURLToPath(new URL("../../services/api/src/index.ts", import.meta.url)) },
			{ find: "@vibe-tavern/db", replacement: fileURLToPath(new URL("../../packages/db/src/index.ts", import.meta.url)) },
			{ find: "@vibe-tavern/domain", replacement: fileURLToPath(new URL("../../packages/domain/src/index.ts", import.meta.url)) },
			{ find: "@vibe-tavern/prompt-pipeline", replacement: fileURLToPath(new URL("../../packages/prompt-pipeline/src/index.ts", import.meta.url)) },
			{ find: "@vibe-tavern/api-contracts", replacement: fileURLToPath(new URL("../../packages/api-contracts/src/index.ts", import.meta.url)) },
			{ find: "@vibe-tavern/import-export", replacement: fileURLToPath(new URL("../../packages/import-export/src/index.ts", import.meta.url)) },
		],
	},
	build: {
		outDir: "../../out/apps/web",
		emptyOutDir: true,
		chunkSizeWarningLimit: 8000,
	},
	server: {
		port: 4173,
	},
}));
