import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { dataComponentPlugin } from "./vite-plugin-data-component.js";

export default defineConfig({
	plugins: [dataComponentPlugin(), react(), tailwindcss()],
	resolve: {
		alias: {
			"@rp-platform/api": fileURLToPath(
				new URL("../../services/api/src/index.ts", import.meta.url),
			),
			"@rp-platform/db": fileURLToPath(
				new URL("../../packages/db/src/index.ts", import.meta.url),
			),
			"@rp-platform/domain": fileURLToPath(
				new URL("../../packages/domain/src/index.ts", import.meta.url),
			),
			"@rp-platform/prompt-pipeline": fileURLToPath(
				new URL("../../packages/prompt-pipeline/src/index.ts", import.meta.url),
			),
			"@rp-platform/api-contracts": fileURLToPath(
				new URL("../../packages/api-contracts/src/index.ts", import.meta.url),
			),
		},
	},
	server: {
		port: 4173,
	},
});
