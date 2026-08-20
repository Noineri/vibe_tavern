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
 * `experience-frame-runtime.test.ts` keeps it honest: it re-runs this exact
 * bundle and byte-compares. Regenerate after touching the port, the loop host,
 * the entry, or any of their imports (domain helpers / contracts schemas), and
 * after Bun upgrades (the minifier's output can shift):
 *
 *   bun run gen:experience-frame-runtime
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
 " * Regenerate after touching the entry's import graph or after a Bun upgrade.",
 " */",
].join("\n");

async function main(): Promise<void> {
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
		process.exitCode = 1;
		return;
	}
	const js = await result.outputs[0].text();
	const ts = `${HEADER}\nexport const EXPERIENCE_FRAME_RUNTIME_SOURCE: string = ${JSON.stringify(js)};\n`;
	await Bun.write(OUT_PATH, ts);
	console.log(`✅ Frame runtime artifact: ${OUT_PATH} (${js.length} bytes of JS)`);
}

await main();
