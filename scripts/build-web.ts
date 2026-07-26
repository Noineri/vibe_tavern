import { cp, mkdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import tailwindPlugin from "bun-plugin-tailwind";
import rootPackage from "../package.json" with { type: "json" };
import { buildConfigPlugin } from "../apps/web/bun-plugin-build-config.js";
import { webAssetsPlugin } from "../apps/web/bun-plugin-web-assets.js";

const ROOT = resolve(import.meta.dir, "..");
const WEB_DIR = join(ROOT, "apps", "web");
const PUBLIC_DIR = join(WEB_DIR, "public");
const OUT_DIR = join(ROOT, "out", "apps", "web");
const APP_VERSION = process.env.VERSION ?? rootPackage.version ?? "0.0.0-dev";
const UPDATE_API_BASE = (
	process.env.VT_UPDATE_API_BASE ??
	"https://api.github.com/repos/Noineri/vibe_tavern"
).replace(/\/+$/, "");

async function main(): Promise<void> {
	console.log("📦 Building frontend with Bun.build...\n");

	await rm(OUT_DIR, { recursive: true, force: true });
	await mkdir(OUT_DIR, { recursive: true });

	const result = await Bun.build({
		entrypoints: [join(WEB_DIR, "index.html")],
		outdir: OUT_DIR,
		target: "browser",
		tsconfig: join(WEB_DIR, "tsconfig.json"),
		minify: true,
		// Without this define the React CJS entry folds its NODE_ENV check to the
		// development branch at bundle time (dev warnings, larger bundle).
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
		sourcemap: "external",
		splitting: true,
		naming: {
			chunk: "assets/index-[hash].[ext]",
			asset: "assets/[name]-[hash].[ext]",
		},
		plugins: [
			tailwindPlugin,
			buildConfigPlugin({
				appVersion: APP_VERSION,
				updateApiBase: UPDATE_API_BASE,
				mode: "production",
				apiUrl: process.env.RP_WEB_API_URL ?? "",
				defaultProviderLabel:
					process.env.RP_WEB_DEFAULT_PROVIDER_LABEL ?? "",
				defaultBaseUrl: process.env.RP_WEB_DEFAULT_BASE_URL ?? "",
				defaultModel: process.env.RP_WEB_DEFAULT_MODEL ?? "",
				forceFirstRun: process.env.RP_WEB_FORCE_FIRST_RUN === "true",
			}),
			webAssetsPlugin(),
		],
		throw: false,
	});

	if (!result.success) {
		for (const log of result.logs) {
			console.error(log);
		}
		process.exitCode = 1;
		return;
	}

	await cp(PUBLIC_DIR, OUT_DIR, { recursive: true });

	for (const output of result.outputs) {
		console.log(`  ✅ ${relative(ROOT, output.path)}`);
	}
	console.log("\n✅ Frontend built to out/apps/web/");
}

await main();
