/**
 * npm distribution build for Vibe Tavern.
 *
 * Produces out/npm-dist/ — a publishable package that the user's own bun runs:
 *   - vibe-tavern.js        (bundled server, executable, `#!/usr/bin/env bun`)
 *   - web/                  (pre-built frontend SPA)
 *   - tokenizers/           (runtime tokenizer JSON files)
 *   - drizzle/              (SQLite DB migrations)
 *   - *.md, coauthor/       (AI assistant prompt assets)
 *   - package.json          (GENERATED — see below)
 *
 * Usage:
 *   bun run build:npm-dist
 *   npm publish out/npm-dist/
 *
 * Why no `--compile`: whoever runs `bun install -g` already has bun, so there
 * is nothing to gain from shipping a 100 MB platform binary. A plain bundle is
 * one artifact for every OS — including macOS, which has no binary channel.
 *
 * The layout is not arbitrary. Each runtime asset resolver already probes
 * `import.meta.dir` for its directory (drizzle: db-connection.ts,
 * tokenizers: tokenizer-service.ts, prompts: prompt-asset-loader.ts), so
 * placing everything as siblings of the bundle makes them resolve with no
 * per-channel special-casing. Prompts are FLAT, not under prompts/ — that is
 * what prompt-asset-loader's `resolve(import.meta.dir, filename)` candidate
 * expects, and it is the same layout scripts/build.ts already produces.
 *
 * The manifest is generated rather than checked in, so bump-version.ts has no
 * ninth file to keep in sync — the version comes from _version.ts, which reads
 * the root package.json (or CI's VERSION).
 */

import { chmod, cp, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathExists } from "./_fs.js";
import { VERSION } from "./_version.js";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "out", "npm-dist");
const WEB_SOURCE = join(ROOT, "out", "apps", "web");
const API_ASSETS = join(ROOT, "services", "api", "assets");

const PACKAGE_NAME = "vibe-tavern";
const BIN_NAME = "vibe-tavern.js";

async function step(label: string, fn: () => Promise<void>) {
	console.log(`\n🔨 ${label}`);
	try {
		await fn();
	} catch (e) {
		console.error(`❌ ${label} failed:`, e);
		process.exit(1);
	}
}

async function run(command: string[], cwd = ROOT) {
	const proc = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`${command.join(" ")} exited with code ${exitCode}`);
	}
}

async function copyRequiredDir(source: string, target: string, label: string) {
	if (!(await pathExists(source))) {
		throw new Error(`${label} source not found: ${source}`);
	}
	await cp(source, target, { recursive: true });
	console.log(`   → ${target}`);
}

/**
 * The published manifest.
 *
 * `dependencies` is empty on purpose: Bun.build inlines every npm dependency
 * into the bundle, so installing this package is one tarball download and no
 * resolution at all.
 *
 * `repository.url` must match the GitHub repo exactly — npm trusted publishing
 * validates it against the OIDC claim, and a mismatch fails the publish.
 *
 * TWO SHAPES HERE ARE LOAD-BEARING AND BOTH FAIL SILENTLY IF CHANGED:
 *
 * 1. The `bin` path carries NO `./` prefix. npm's manifest normalizer rejects a
 *    bin value starting with `./` and DELETES the entry — publishing a package
 *    with no launcher at all, while `npm publish` exits 0 with only a warning.
 *    `npm pack` does not normalize, so a tarball installed straight from disk
 *    still works and hides the bug. Verified on npm 12.0.2: `vibe-tavern.js`
 *    and `bin/vibe-tavern.js` are accepted, `./vibe-tavern.js` is dropped.
 *
 * 2. There is no `publishConfig.provenance`. Provenance is a property of the
 *    PUBLISHING ENVIRONMENT, not of the package: with it set, every publish
 *    outside GitHub Actions dies with "Automatic provenance generation not
 *    supported for provider: null" — which breaks the local-registry test and
 *    any manual publish. release-npm.yml passes `--provenance` instead.
 */
export function manifest(version: string = VERSION) {
	return {
		name: PACKAGE_NAME,
		version,
		description: "A lightweight, self-hosted AI roleplay platform",
		license: "AGPL-3.0",
		type: "module",
		bin: { [PACKAGE_NAME]: BIN_NAME },
		repository: { type: "git", url: "git+https://github.com/Noineri/vibe_tavern.git" },
		homepage: "https://github.com/Noineri/vibe_tavern",
		bugs: { url: "https://github.com/Noineri/vibe_tavern/issues" },
		keywords: ["ai", "roleplay", "llm", "self-hosted", "sillytavern", "chat"],
		engines: { bun: ">=1.3.0" },
		publishConfig: { access: "public" },
	};
}

async function main() {
	console.log("📦 Vibe Tavern — npm Distribution Build\n");
	console.log(`   Version: ${VERSION}`);
	console.log(`   Output:  ${DIST}`);

	await step("Cleaning previous build", async () => {
		await rm(DIST, { recursive: true, force: true });
		await mkdir(DIST, { recursive: true });
	});

	// --skip-frontend reuses whatever is already in out/apps/web. It exists for
	// the self-update smoke test, which packs two versions back to back and
	// would otherwise rebuild an identical frontend twice. NEVER pass it for a
	// release: the guard below catches a missing frontend but cannot catch a
	// stale one.
	const skipFrontend = process.argv.includes("--skip-frontend");
	if (skipFrontend) {
		console.log("\n⏭  --skip-frontend: reusing the existing out/apps/web build.");
		if (!(await Bun.file(join(WEB_SOURCE, "index.html")).exists())) {
			throw new Error(`--skip-frontend passed but no frontend at ${WEB_SOURCE}. Build it first.`);
		}
	} else {
		await step("Building frontend (Bun build)", async () => {
			await run(["bun", "run", "--filter", "@vibe-tavern/web", "build"]);
		});
	}

	await step("Copying frontend", async () => {
		if (!(await Bun.file(join(WEB_SOURCE, "index.html")).exists())) {
			throw new Error(`Frontend not found at ${WEB_SOURCE}. Build may have failed.`);
		}
		await cp(WEB_SOURCE, join(DIST, "web"), { recursive: true });
		// Sourcemaps are half the frontend's weight (18 MB of 36 MB) and are
		// dead payload in a published package — nobody debugs minified SPA
		// internals from a global install. The browser 404s on
		// sourceMappingURL, which costs nothing.
		const maps = new Bun.Glob("**/*.map");
		let stripped = 0;
		for await (const rel of maps.scan({ cwd: join(DIST, "web") })) {
			await rm(join(DIST, "web", rel));
			stripped++;
		}
		console.log(`   → ${join(DIST, "web")} (${stripped} sourcemap(s) stripped)`);
	});

	await step("Copying tokenizer files", async () => {
		await copyRequiredDir(join(API_ASSETS, "tokenizers"), join(DIST, "tokenizers"), "Tokenizer");
	});

	await step("Copying DB migrations", async () => {
		await copyRequiredDir(join(ROOT, "packages", "db", "drizzle"), join(DIST, "drizzle"), "DB migrations");
	});

	await step("Copying AI assistant prompt files", async () => {
		// Flat *.md + every nested prompt tree (coauthor/, experience-copilot/)
		// via the shared copier — see _prompt-assets.ts history. Prompts stay
		// FLAT in the dist root (not under prompts/) — that is what the loader's
		// `resolve(import.meta.dir, filename)` candidate resolves against.
		const targets = await copyPromptAssets(API_ASSETS, DIST);
		console.log(`   → ${targets.length} prompt file(s)/tree(s)`);
	});

	await step("Bundling server", async () => {
		const entrypoint = join(ROOT, "services", "api", "src", "server", "npm-server.ts");
		if (!(await Bun.file(entrypoint).exists())) {
			throw new Error(`Entrypoint not found: ${entrypoint}`);
		}

		const result = await Bun.build({
			entrypoints: [entrypoint],
			outdir: DIST,
			naming: BIN_NAME,
			target: "bun",
			minify: true,
			banner: "#!/usr/bin/env bun",
			define: {
				VIBE_TAVERN_VERSION: `"${VERSION}"`,
				// Not inferable at runtime — see classifyInstallKind. Without
				// this the npm build looks like a compiled standalone install
				// and the binary-swap updater would target ~/.bun/bin.
				VIBE_TAVERN_INSTALL_KIND: `"npm"`,
			},
		});

		if (!result.success) {
			for (const msg of result.logs) console.error(msg);
			throw new Error("Bun.build failed");
		}

		const outfile = join(DIST, BIN_NAME);
		if (!(await Bun.file(outfile).exists())) {
			throw new Error(`Expected output not found: ${outfile}`);
		}
		// npm preserves the executable bit from the tarball; bun's global link
		// relies on it on POSIX.
		await chmod(outfile, 0o755);
		console.log(`   → ${outfile}`);
	});

	await step("Writing package.json", async () => {
		await Bun.write(join(DIST, "package.json"), `${JSON.stringify(manifest(), null, 2)}\n`);
		console.log(`   → ${join(DIST, "package.json")}`);
	});

	await step("Copying README and LICENSE", async () => {
		for (const file of ["README.md", "LICENSE"]) {
			const source = join(ROOT, file);
			if (!(await pathExists(source))) {
				throw new Error(`${file} not found at ${source}`);
			}
			await cp(source, join(DIST, file));
			console.log(`   → ${join(DIST, file)}`);
		}
	});

	console.log("\n✅ npm distribution build complete!");
	console.log(`   Package: ${DIST}`);
	console.log("\n   To test locally:");
	console.log(`     bun install -g ${DIST}`);
	console.log("     vibe-tavern");
}

// Guarded so the manifest shape can be unit-tested without running a build.
if (import.meta.main) {
	main();
}
