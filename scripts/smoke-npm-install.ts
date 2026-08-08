/**
 * End-to-end smoke test of the npm distribution as a REAL global install.
 *
 * Usage:
 *   bun scripts/smoke-npm-install.ts <path-to-tarball>
 *
 * Installs the packed tarball with `bun install -g`, starts the installed
 * server on a scratch data directory, asserts it actually serves, then
 * uninstalls. Exits non-zero on the first failed assertion.
 *
 * Why a Bun script rather than shell steps in the workflow: this runs on
 * ubuntu, windows AND macos, and the three would otherwise need bash + pwsh
 * copies of the same logic. It also makes the check runnable locally, which is
 * how you debug a red matrix leg without pushing commits.
 *
 * What it is actually pinning — every one of these has a plausible failure mode
 * that only appears in a real install, never in `bun run dev`:
 *   - the bin shim is created and is executable;
 *   - assets resolve from the INSTALLED package directory, not from the CWD
 *     (the script runs the server from a scratch dir precisely so a cwd-relative
 *     fallback cannot rescue a broken lookup);
 *   - the build declares installKind "npm", so the binary-swap updater is never
 *     offered a package install to swap;
 *   - the SPA is served, i.e. web/ survived packing.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const PACKAGE_NAME = "vibe-tavern";
const STARTUP_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;

function fail(message: string): never {
	console.error(`❌ ${message}`);
	process.exit(1);
}

function ok(message: string): void {
	console.log(`✅ ${message}`);
}

async function run(command: string[], label: string): Promise<string> {
	console.log(`\n$ ${command.join(" ")}`);
	const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const output = `${stdout}${stderr}`.trim();
	if (output.length > 0) console.log(output);
	if (exitCode !== 0) fail(`${label} exited with code ${exitCode}`);
	return stdout.trim();
}

/**
 * The installed launcher, whatever the platform names it.
 *
 * Windows gets THREE files from a global bun install — `vibe-tavern`,
 * `vibe-tavern.bunx` and `vibe-tavern.exe` — and only the `.exe` can be
 * spawned. Picking by "first entry whose name starts with the package name"
 * selects `.bunx` (it sorts before `.exe`), which fails with a baffling
 * "Executable not found in $PATH" naming a file that plainly exists. Hence an
 * explicit, ordered candidate list rather than a prefix match.
 */
async function findInstalledBinary(): Promise<string> {
	const binDir = (await run(["bun", "pm", "bin", "-g"], "bun pm bin -g")).trim();
	if (binDir.length === 0) fail("`bun pm bin -g` printed nothing — cannot locate the global bin directory.");

	const candidates =
		process.platform === "win32"
			? [`${PACKAGE_NAME}.exe`, `${PACKAGE_NAME}.cmd`, `${PACKAGE_NAME}.bat`]
			: [PACKAGE_NAME];

	const entries = await readdir(binDir).catch(() => [] as string[]);
	const match = candidates.find((name) => entries.includes(name));
	if (match === undefined) {
		fail(
			`No runnable ${PACKAGE_NAME} launcher in ${binDir}.\n` +
				`  Looked for: ${candidates.join(", ")}\n` +
				`  Present:    ${entries.join(", ") || "(empty)"}`,
		);
	}
	return join(binDir, match);
}

async function waitForServer(baseUrl: string, deadline: number): Promise<void> {
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
			if (response.ok) return;
		} catch {
			// Not listening yet — the server binds early but this covers the gap
			// before that, and any transient refusal during startup.
		}
		await Bun.sleep(POLL_INTERVAL_MS);
	}
	fail(`Server did not answer ${baseUrl}/health within ${STARTUP_TIMEOUT_MS / 1000}s`);
}

/**
 * Accept either the tarball itself or the directory it was downloaded into.
 *
 * The directory form exists for CI: `actions/download-artifact` lands the file
 * under a folder, and expanding a `*.tgz` glob in a workflow `run:` step would
 * need one spelling for bash and another for pwsh. Resolving it here keeps the
 * matrix legs identical.
 */
async function resolveTarball(input: string): Promise<string> {
	// `bun install -g ./relative.tgz` fails with "ENOENT extracting tarball";
	// the absolute path works. Resolve here so no caller can trip on it.
	const path = isAbsolute(input) ? input : resolve(process.cwd(), input);

	const entries = await readdir(path).catch(() => null);
	if (entries === null) {
		if (!(await Bun.file(path).exists())) fail(`Tarball not found: ${path}`);
		return path;
	}

	const tarballs = entries.filter((name) => name.endsWith(".tgz"));
	if (tarballs.length === 0) fail(`No .tgz found in ${path}`);
	if (tarballs.length > 1) fail(`Expected exactly one .tgz in ${path}, found: ${tarballs.join(", ")}`);
	return join(path, tarballs[0] ?? "");
}

async function main() {
	const input = process.argv[2];
	if (input === undefined) fail("Usage: bun scripts/smoke-npm-install.ts <tarball-or-directory>");

	const tarball = await resolveTarball(input);

	console.log(`📦 Smoke-testing ${tarball}`);

	const dataDir = await mkdtemp(join(tmpdir(), "vt-npm-smoke-"));
	let installed = false;

	try {
		await run(["bun", "install", "-g", tarball], "bun install -g");
		installed = true;

		const binary = await findInstalledBinary();
		ok(`launcher installed at ${binary}`);

		const version = await run([binary, "--version"], `${PACKAGE_NAME} --version`);
		if (!/^\d+\.\d+\.\d+/.test(version)) fail(`--version printed ${JSON.stringify(version)}, expected a semver`);
		ok(`--version reports ${version}`);

		// Port 0 is not an option: the server prints its port but the runtime
		// binds what it is told. Pick a high fixed port unlikely to collide on a
		// fresh runner.
		const port = 8899;
		const baseUrl = `http://127.0.0.1:${port}`;

		// The CWD is a scratch directory with no out/apps/web and no drizzle/,
		// so every asset lookup must succeed via the installed package root.
		const server = Bun.spawn([binary], {
			cwd: dataDir,
			env: {
				...process.env,
				VIBE_TAVERN_DATA_DIR: join(dataDir, "data"),
				VIBE_TAVERN_HOST: "127.0.0.1",
				VIBE_TAVERN_PORT: String(port),
				VIBE_TAVERN_OPEN_BROWSER: "0",
			},
			stdout: "inherit",
			stderr: "inherit",
			stdin: "ignore",
		});

		try {
			await waitForServer(baseUrl, Date.now() + STARTUP_TIMEOUT_MS);
			ok("server answered /health");

			const infoResponse = await fetch(`${baseUrl}/api/runtime/info`);
			if (!infoResponse.ok) fail(`/api/runtime/info responded ${infoResponse.status}`);
			const info = await infoResponse.json();
			if (typeof info !== "object" || info === null) fail("/api/runtime/info did not return an object");
			const installKind = (info as { installKind?: string }).installKind;
			if (installKind !== "npm") {
				fail(`installKind is ${JSON.stringify(installKind)}, expected "npm" — the build-time define did not survive packing.`);
			}
			ok('installKind is "npm"');

			const indexResponse = await fetch(baseUrl);
			if (!indexResponse.ok) fail(`GET / responded ${indexResponse.status}`);
			const html = await indexResponse.text();
			if (!html.toLowerCase().includes("<!doctype html")) fail("GET / did not return an HTML document");
			ok("SPA index served");
		} finally {
			server.kill();
			await server.exited;
		}
	} finally {
		if (installed) {
			// Best-effort: a failed uninstall must not mask the real failure.
			await run(["bun", "remove", "-g", PACKAGE_NAME], "bun remove -g").catch(() => undefined);
		}
		await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
	}

	console.log("\n✅ npm distribution smoke test passed.");
}

main();
