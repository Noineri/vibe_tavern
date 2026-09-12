import { cp, mkdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import tailwindPlugin from "bun-plugin-tailwind";
import { buildConfigPlugin, resolveWebBuildEnv } from "../apps/web/bun-plugin-build-config.js";
import { webAssetsPlugin } from "../apps/web/bun-plugin-web-assets.js";

const ROOT = resolve(import.meta.dir, "..");
const WEB_DIR = join(ROOT, "apps", "web");
const PUBLIC_DIR = join(WEB_DIR, "public");
const OUT_DIR = join(ROOT, "out", "apps", "web");

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
			buildConfigPlugin(resolveWebBuildEnv("production")),
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

	// The Kokoro + Whisper workers are SEPARATE entrypoints: Bun.build does
	// not emit `new Worker(new URL(...))` chunks (a Vite feature), so the main
	// HTML graph loses the worker entirely — the prod app would 404 on it and
	// the model download would stall forever. Compiled here to the fixed
	// asset names `assets/kokoro-worker.js` / `assets/whisper-worker.js` that
	// the worker factories point at in production (cache-busted with
	// `?v=APP_VERSION`). Both workers in ONE build call so the shared
	// transformers.js chunks dedupe between them.
	const workerResult = await Bun.build({
		entrypoints: [
			join(WEB_DIR, "src/lib/tts/kokoro/kokoro-worker.ts"),
			join(WEB_DIR, "src/lib/stt/whisper/whisper-worker.ts"),
		],
		outdir: join(OUT_DIR, "assets"),
		naming: { entry: "[name].[ext]", chunk: "index-[hash].[ext]", asset: "[name]-[hash].[ext]" },
		target: "browser",
		tsconfig: join(WEB_DIR, "tsconfig.json"),
		minify: true,
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
		sourcemap: "external",
		splitting: true,
		throw: false,
	});
	if (!workerResult.success) {
		for (const log of workerResult.logs) {
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
