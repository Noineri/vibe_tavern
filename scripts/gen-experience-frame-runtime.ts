/**
 * Generate the realtime experience frame runtime artifact (RM-4).
 *
 * Bundles `apps/web/src/lib/experience-frame-runtime.entry.ts` (kernel port +
 * loop host + boot) into a single minified browser IIFE and writes it as a
 * committed string module: `apps/web/src/generated/experience-frame-runtime.source.ts`.
 * ExperienceFrame embeds that string into the REALTIME frame document; the
 * turn-based document never loads it (lazy dynamic import).
 *
 * The artifact is COMMITTED (not build-time-generated) so neither the prod
 * build (scripts/build-web.ts) nor the dev server changes — and
 * `experience-frame-runtime.test.ts` keeps it honest: it re-runs this script
 * in `--check` mode (subprocess) and byte-compares. Regenerate after touching
 * the port, the loop host, the entry, or any of their imports (domain helpers /
 * contracts schemas), after Bun upgrades (the minifier's output can shift), and
 * after ANY DEPENDENCY CHANGE that touches bun.lock (bun add / bun install
 * re-resolutions): a shifted dependency graph changes the minified bytes even
 * with zero source edits, so the freshness test FAILING right after a package
 * update is EXPECTED — the fix is a regeneration, not a debug:
 *
 *   bun run gen:experience-frame-runtime
 *
 * `--check` mode: build in memory and compare against the committed artifact
 * WITHOUT writing; exit 0 on a byte-match, exit 1 with the regeneration
 * instruction on drift or a build failure. This is the mode CI uses — the
 * freshness check MUST run the bundler through this script (a subprocess, i.e.
 * the RUNTIME module resolver) rather than an in-test `Bun.build` call: the
 * bundler dereferences workspace symlinks and resolves bare imports from the
 * real package path, which cannot see `node_modules/.bun/node_modules` and so
 * fails to resolve `zod`/`@vibe-tavern/domain` from `packages/api-contracts`
 * on fresh CI installs (oven-sh/bun#31957); the runtime resolver handles that
 * layout fine. Running the generator as a subprocess is also the only way to
 * guarantee the freshness check uses EXACTLY the generator's build options —
 * an in-test duplicate of the config can silently drift.
 */
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const WEB_DIR = join(ROOT, "apps", "web");
const ENTRY = join(WEB_DIR, "src", "lib", "experience-frame-runtime.entry.ts");
const OUT_PATH = join(WEB_DIR, "src", "generated", "experience-frame-runtime.source.ts");

const HEADER = [
  "/**",
  " * GENERATED FILE — do not edit by hand (REALTIME_EXPERIENCE_MODE_PLAN, RM-4).",
  " * The realtime frame runtime IIFE (kernel port + loop host + boot), built by",
  " * `bun run gen:experience-frame-runtime` from experience-frame-runtime.entry.ts.",
 " * Guarded by experience-frame-runtime.test.ts: it re-bundles and byte-compares.",
 " * Regenerate after touching the entry's import graph, after a Bun upgrade, or",
 " * after any dependency change (bun.lock) — the freshness test WILL fail on",
 " * package updates until this file is regenerated:",
 " *   bun run gen:experience-frame-runtime",
 " */",
].join("\n");

async function buildRuntimeSource(): Promise<string> {
	const result = await Bun.build({
		entrypoints: [ENTRY],
		target: "browser",
		format: "iife",
		minify: true,
		tsconfig: join(WEB_DIR, "tsconfig.json"),
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		process.exit(1);
	}
	return result.outputs[0].text();
}

async function check(): Promise<void> {
	const { EXPERIENCE_FRAME_RUNTIME_SOURCE } = await import(OUT_PATH);
	let js: string;
	try {
		js = await buildRuntimeSource();
	} catch (error) {
		console.error(`frame runtime generator build failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	if (js !== EXPERIENCE_FRAME_RUNTIME_SOURCE) {
		console.error(
			"experience-frame-runtime.source.ts is STALE: the committed IIFE does not match a fresh build of experience-frame-runtime.entry.ts. " +
				"A dependency change (bun.lock) is the most common cause — the test failing right after a package update is EXPECTED. " +
				"Regenerate with: bun run gen:experience-frame-runtime",
		);
		process.exit(1);
	}
	console.log("✅ Frame runtime artifact is fresh (byte-identical to a fresh generator run).");
}

async function main(): Promise<void> {
	if (process.argv.includes("--check")) {
		await check();
		return;
	}
	const js = await buildRuntimeSource();
	const ts = `${HEADER}\nexport const EXPERIENCE_FRAME_RUNTIME_SOURCE: string = ${JSON.stringify(js)};\n`;
	await Bun.write(OUT_PATH, ts);
	console.log(`✅ Frame runtime artifact: ${OUT_PATH} (${js.length} bytes of JS)`);
}

await main();
