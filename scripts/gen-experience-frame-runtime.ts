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
 * contracts schemas), after a Bun upgrade (the minifier's output can shift),
 * and after a version bump of a package the entry actually pulls in (`zod` is
 * the big one — the artifact carried the whole Zod runtime until a bump made
 * it tree-shake, which is how it ended up 347 674 bytes against a 149 793-byte
 * fresh build on the v1.2.2 tag). Lockfile churn on its own does NOT shift the
 * bytes: five commits that rewrote bun.lock (overrides, entry pruning, a
 * workspace-local dependency move) left the artifact byte-identical. So a
 * freshness failure right after `bun install` is plausible but not automatic —
 * read the byte counts the `--check` failure prints before assuming it is
 * noise. The fix either way:
 *
 *   bun run gen:experience-frame-runtime
 *
 * `--check` mode: build in memory and compare against the committed artifact
 * WITHOUT writing; exit 0 on a byte-match, exit 1 with the sizes and the
 * regeneration instruction on drift or a build failure. This is the mode CI
 * uses. The check MUST run the bundler through this script so that it can
 * never drift from the generator's build options — there is exactly one copy
 * of the bundle config, and an in-test duplicate would silently rot. That is
 * the whole reason for the subprocess today. It used to have a second one:
 * on earlier Bun versions `Bun.build` dereferenced workspace symlinks and
 * resolved bare imports from the real package path, so `zod` /
 * `@vibe-tavern/domain` went missing on fresh isolated installs
 * (oven-sh/bun#31957) — that no longer reproduces on 1.4.2. Measured on a
 * clean `bun install --frozen-lockfile` worktree (isolated layout:
 * `node_modules/.bun` plus per-package symlinks, no hoisted `zod`): an
 * in-process `Bun.build` with these options produced bytes identical to the
 * committed artifact.
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
	" * after a version bump of a package the entry pulls in (zod, workspace ones).",
	" * Plain lockfile churn does not shift these bytes; the --check failure prints",
	" * both sizes so you can tell a graph change from minifier renaming:",
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
		let divergesAt = 0;
		while (
			divergesAt < js.length &&
			divergesAt < EXPERIENCE_FRAME_RUNTIME_SOURCE.length &&
			js[divergesAt] === EXPERIENCE_FRAME_RUNTIME_SOURCE[divergesAt]
		)
			divergesAt++;
		console.error(
			"experience-frame-runtime.source.ts is STALE: the committed IIFE does not match a fresh build of experience-frame-runtime.entry.ts.\n" +
				`  committed: ${EXPERIENCE_FRAME_RUNTIME_SOURCE.length} bytes, fresh build: ${js.length} bytes, first divergence at byte ${divergesAt}.\n` +
				"  A size delta of more than a few hundred bytes means the entry's import graph changed (source edit, or a version bump of zod / a workspace package it pulls in); a same-size or near-size delta is usually minifier renaming after a Bun upgrade. Either way the fix is a regeneration, not a debug:\n" +
				"  bun run gen:experience-frame-runtime",
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
