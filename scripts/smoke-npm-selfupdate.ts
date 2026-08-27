/**
 * End-to-end smoke test of the npm channel's SELF-UPDATE, against a real
 * package registry.
 *
 * Usage:
 *   bun scripts/smoke-npm-selfupdate.ts
 *
 * Self-update is the one part of this channel that cannot be verified with a
 * single package: it needs two versions to exist somewhere resolvable, an
 * update check that reports the newer one, and a package manager that really
 * replaces the install. So this script stands up the whole world locally:
 *
 *   - verdaccio  — a throwaway registry with no uplink, holding 0.0.1 and 0.0.2
 *   - a mock GitHub release API — because version discovery is GitHub-based for
 *     every channel (VT_UPDATE_API_BASE)
 *   - a real global install of 0.0.1, updated in place to 0.0.2 through the
 *     same HTTP endpoints the SPA's update modal calls
 *
 * The assertion that matters is the last one: after the update, the installed
 * launcher reports 0.0.2. Everything before it is setup.
 *
 * Runtime is a few minutes, dominated by two frontend-less package builds and
 * two global installs.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OLD_VERSION = "0.0.1";
const NEW_VERSION = "0.0.2";
const SERVER_PORT = 8898;
const UPDATE_TIMEOUT_MS = 300_000;

function fail(message: string): never {
	console.error(`\n❌ ${message}`);
	process.exit(1);
}

function ok(message: string): void {
	console.log(`✅ ${message}`);
}

function step(message: string): void {
	console.log(`\n🔨 ${message}`);
}

async function run(
	command: string[],
	label: string,
	options: { cwd?: string; env?: Record<string, string>; allowFailure?: boolean } = {},
): Promise<string> {
	console.log(`$ ${command.join(" ")}`);
	const proc = Bun.spawn(command, {
		cwd: options.cwd ?? ROOT,
		env: { ...process.env, ...options.env },
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0 && options.allowFailure !== true) {
		console.error(`${stdout}${stderr}`.trim());
		fail(`${label} exited with code ${exitCode}`);
	}
	return stdout.trim();
}

async function waitFor(
	label: string,
	check: () => Promise<boolean>,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(500);
	}
	fail(`Timed out waiting for ${label}`);
}

/** An ephemeral free port. Racy in principle; the window is microseconds and
 *  the alternative is a fixed port that collides with a leftover run. */
function pickFreePort(): number {
	const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
	const port = probe.port;
	probe.stop(true);
	// Bun assigns a concrete port for `port: 0`; the type is `number | undefined`
	// only because a fixed port can stay unbound. A failed ephemeral bind is not
	// a recoverable state for this smoke script — fail loudly instead of
	// returning a bogus 0.
	if (port === undefined) {
		throw new Error("pickFreePort: Bun.serve({ port: 0 }) returned no assigned port");
	}
	return port;
}

/** A registry with no uplink: nothing reaches npmjs.org, and publishing needs
 *  no real account. */
async function startVerdaccio(workDir: string): Promise<{ url: string; stop: () => void }> {
	const configPath = join(workDir, "verdaccio.yaml");
	await writeFile(
		configPath,
		[
			`storage: ${JSON.stringify(join(workDir, "storage"))}`,
			"uplinks: {}",
			// verdaccio defaults to a 10 MB request body. The package is ~35 MB
			// packed (tokenizers and fonts), so publishing 413s without this.
			// Not a constraint on npmjs.org, which allows far more.
			"max_body_size: 200mb",
			"packages:",
			"  '**':",
			"    access: $all",
			"    publish: $all",
			"    unpublish: $all",
			"log: { type: stdout, format: pretty, level: warn }",
			"",
		].join("\n"),
		"utf-8",
	);

	// Installed locally and spawned by its real binary path rather than through
	// `bunx`. bunx stays alive as a PARENT of the verdaccio process, so killing
	// it leaves the registry listening — a leaked instance then answers the next
	// run's health check with the previous run's config, and the failure looks
	// like a config change that "did not take".
	await writeFile(join(workDir, "package.json"), '{"name":"vt-smoke-registry","private":true}\n', "utf-8");
	await run(["bun", "add", "--exact", "verdaccio@6.9.2"], "bun add verdaccio", { cwd: workDir });
	const verdaccioBin = join(workDir, "node_modules", ".bin", "verdaccio");

	const port = pickFreePort();
	const url = `http://127.0.0.1:${port}`;
	const proc = Bun.spawn([verdaccioBin, "--config", configPath, "--listen", url], {
		cwd: workDir,
		stdout: "inherit",
		stderr: "inherit",
		stdin: "ignore",
	});

	await waitFor(
		"verdaccio to accept connections",
		async () => {
			try {
				const response = await fetch(`${url}/-/ping`, { signal: AbortSignal.timeout(2_000) });
				return response.ok;
			} catch {
				return false;
			}
		},
		120_000,
	);

	return { url, stop: () => proc.kill() };
}

/** Stands in for GitHub's release API: version discovery is GitHub-based on
 *  every channel, including this one. */
function startReleaseApi(version: string): { url: string; stop: () => void } {
	const server = Bun.serve({
		port: 0,
		fetch: () =>
			Response.json({
				tag_name: `v${version}`,
				name: `Vibe Tavern v${version}`,
				body: "Smoke-test release",
				draft: false,
				prerelease: false,
				// resolveRelease rejects a release with no SHA256SUMS.txt as
				// unparseable, even though the npm path never verifies a
				// checksum. Present here for that reason alone.
				assets: [
					{ name: "SHA256SUMS.txt", browser_download_url: "http://127.0.0.1:1/SHA256SUMS.txt", size: 1 },
				],
			}),
	});
	return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

async function buildAndPublish(
	version: string,
	registryUrl: string,
	npmrcPath: string,
	skipFrontend: boolean,
): Promise<void> {
	step(`Building and publishing ${version}`);
	const args = ["bun", "scripts/build-npm-dist.ts"];
	if (skipFrontend) args.push("--skip-frontend");
	await run(args, `build-npm-dist ${version}`, { env: { VERSION: version } });

	await run(
		["npm", "publish", "--registry", registryUrl, "--tag", "latest"],
		`npm publish ${version}`,
		{ cwd: join(ROOT, "out", "npm-dist"), env: { npm_config_userconfig: npmrcPath } },
	);
	ok(`published vibe-tavern@${version} to the local registry`);
}

async function main() {
	const workDir = await mkdtemp(join(tmpdir(), "vt-selfupdate-"));
	const dataDir = join(workDir, "data");

	let verdaccio: { url: string; stop: () => void } | null = null;
	let releaseApi: { url: string; stop: () => void } | null = null;
	let server: ReturnType<typeof Bun.spawn> | null = null;
	let installed = false;

	try {
		step("Starting a throwaway registry");
		verdaccio = await startVerdaccio(workDir);
		ok(`verdaccio listening at ${verdaccio.url}`);

		// verdaccio permits anonymous publish under `publish: $all`, but the npm
		// CLI refuses to try without SOME token. Any value satisfies it.
		const npmrcPath = join(workDir, ".npmrc");
		const registryHost = verdaccio.url.replace(/^https?:/, "");
		await writeFile(
			npmrcPath,
			`registry=${verdaccio.url}/\n${registryHost}/:_authToken=smoke-test\n`,
			"utf-8",
		);

		await buildAndPublish(OLD_VERSION, verdaccio.url, npmrcPath, false);
		await buildAndPublish(NEW_VERSION, verdaccio.url, npmrcPath, true);

		step(`Installing ${OLD_VERSION} globally from the local registry`);
		const registryEnv = { BUN_CONFIG_REGISTRY: verdaccio.url };
		await run(["bun", "install", "-g", `vibe-tavern@${OLD_VERSION}`], "bun install -g", {
			env: registryEnv,
		});
		installed = true;

		const binDir = await run(["bun", "pm", "bin", "-g"], "bun pm bin -g");
		const binary = join(binDir, process.platform === "win32" ? "vibe-tavern.exe" : "vibe-tavern");
		const before = await run([binary, "--version"], "vibe-tavern --version");
		if (before !== OLD_VERSION) fail(`Installed version is ${before}, expected ${OLD_VERSION}`);
		ok(`installed vibe-tavern@${before}`);

		step("Starting the installed server with a mock release API");
		releaseApi = startReleaseApi(NEW_VERSION);
		const baseUrl = `http://127.0.0.1:${SERVER_PORT}`;
		server = Bun.spawn([binary], {
			cwd: workDir,
			env: {
				...process.env,
				...registryEnv,
				VIBE_TAVERN_DATA_DIR: dataDir,
				VIBE_TAVERN_HOST: "127.0.0.1",
				VIBE_TAVERN_PORT: String(SERVER_PORT),
				VIBE_TAVERN_OPEN_BROWSER: "0",
				VT_UPDATE_API_BASE: releaseApi.url,
				VT_NPM_REGISTRY_BASE: verdaccio.url,
			},
			stdout: "inherit",
			stderr: "inherit",
			stdin: "ignore",
		});

		await waitFor(
			"the server to answer /health",
			async () => {
				try {
					return (await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) })).ok;
				} catch {
					return false;
				}
			},
			120_000,
		);
		ok("server is up");

		step("Asking the server whether an update is available");
		const check = await (await fetch(`${baseUrl}/api/runtime/update/check`)).json();
		if (typeof check !== "object" || check === null) fail("update/check did not return an object");
		const checkResult = check as { available?: boolean; canSelfUpdate?: boolean; latestVersion?: string; installKind?: string; reason?: string };
		if (checkResult.installKind !== "npm") fail(`installKind is ${checkResult.installKind}, expected "npm"`);
		if (checkResult.canSelfUpdate !== true) fail("canSelfUpdate is false — the npm channel should be able to update itself");
		if (checkResult.available !== true) fail(`available is false (reason: ${checkResult.reason})`);
		if (checkResult.latestVersion !== NEW_VERSION) fail(`latestVersion is ${checkResult.latestVersion}, expected ${NEW_VERSION}`);
		ok(`update/check reports ${NEW_VERSION} available, canSelfUpdate=true`);

		step("Triggering the update through the same endpoint the modal uses");
		const trigger = await fetch(`${baseUrl}/api/runtime/update`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ tag: `v${NEW_VERSION}` }),
		});
		if (trigger.status !== 202) {
			fail(`POST /api/runtime/update responded ${trigger.status}: ${await trigger.text()}`);
		}
		ok("update accepted");

		// The server exits a beat after reporting "done", so a refused
		// connection following a successful phase is a PASS, not a failure.
		let sawDone = false;
		await waitFor(
			"the update to finish",
			async () => {
				try {
					const response = await fetch(`${baseUrl}/api/runtime/update/status`, {
						signal: AbortSignal.timeout(2_000),
					});
					const status = (await response.json()) as { phase?: string; error?: { message?: string } | null };
					if (status.phase === "error") {
						fail(`Update failed: ${status.error?.message ?? "(no message)"}`);
					}
					if (status.phase === "done") {
						sawDone = true;
						return true;
					}
					console.log(`   phase: ${status.phase}`);
					return false;
				} catch {
					// Connection gone. Only acceptable once the update reached a
					// terminal phase; otherwise the server died mid-update.
					return sawDone;
				}
			},
			UPDATE_TIMEOUT_MS,
		);
		ok("update reported done");

		await server.exited;
		server = null;

		step("Verifying the installed version actually changed");
		const after = await run([binary, "--version"], "vibe-tavern --version");
		if (after !== NEW_VERSION) fail(`Installed version is ${after} after the update, expected ${NEW_VERSION}`);
		ok(`self-update replaced ${OLD_VERSION} with ${after}`);
	} finally {
		server?.kill();
		releaseApi?.stop();
		if (installed) {
			await run(["bun", "remove", "-g", "vibe-tavern"], "bun remove -g", { allowFailure: true });
		}
		verdaccio?.stop();
		await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
	}

	console.log("\n✅ npm self-update smoke test passed.");
}

main();
