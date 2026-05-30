import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { dataComponentPlugin } from "./vite-plugin-data-component.js";

export default defineConfig({
	plugins: [dataComponentPlugin(), react(), tailwindcss()],
	resolve: {
		alias: {
			"@vibe-tavern/api": fileURLToPath(
				new URL("../../services/api/src/index.ts", import.meta.url),
			),
			"@vibe-tavern/db": fileURLToPath(
				new URL("../../packages/db/src/index.ts", import.meta.url),
			),
			"@vibe-tavern/domain": fileURLToPath(
				new URL("../../packages/domain/src/index.ts", import.meta.url),
			),
			"@vibe-tavern/prompt-pipeline": fileURLToPath(
				new URL("../../packages/prompt-pipeline/src/index.ts", import.meta.url),
			),
			"@vibe-tavern/api-contracts": fileURLToPath(
				new URL("../../packages/api-contracts/src/index.ts", import.meta.url),
			),
		},
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
