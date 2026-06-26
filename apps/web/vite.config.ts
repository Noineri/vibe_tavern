import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { dataComponentPlugin } from "./vite-plugin-data-component.js";

export default defineConfig({
	plugins: [dataComponentPlugin(), react(), tailwindcss()],
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
});
