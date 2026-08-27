/**
 * Docker availability probe for the TTS "Local server" quickstart (TTS
 * settings defects report, D8/F5): the quickstart cards must not assume
 * docker exists — the panel shows an honest "docker not found" state plus
 * non-docker launch variants. This module is the server-side half: one
 * `docker --version` call, bounded by a timeout, normalized to a wire
 * shape. It never throws: every failure mode (not installed, not on PATH,
 * spawn error, timeout) degrades to `{ available: false, version: null }`.
 */

export interface DockerProbeResult {
	available: boolean;
	version: string | null;
}

/** Injectable seam for tests: run `docker --version`, resolve its stdout, or
 *  null when the binary cannot run. The default uses Bun.spawn with a
 *  bounded wait — a hung `docker` (e.g. a broken Desktop install) must not
 *  hang the route. */
export type DockerVersionRunner = () => Promise<string | null>;

export const DOCKER_PROBE_TIMEOUT_MS = 3000;

async function runDockerVersion(): Promise<string | null> {
	const proc = Bun.spawn(["docker", "--version"], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const stdout = new Response(proc.stdout).text();
	const timer = new Promise<"timeout">((resolve) => {
		setTimeout(() => resolve("timeout"), DOCKER_PROBE_TIMEOUT_MS).unref();
	});
	const exit = await Promise.race([proc.exited, timer]);
	if (exit === "timeout") {
		proc.kill();
		return null;
	}
	const code = typeof exit === "number" ? exit : 1;
	if (code !== 0) return null;
	const text = (await stdout).trim();
	return text.length > 0 ? text : null;
}

/** Normalize `Docker version 27.3.1, build abc123` (and localized variants\n *  that still start with a version-looking token) to a short version string.\n *  The full first line is kept when parsing fails — it is still honest,\n *  non-sensitive output of `docker --version`. */
export function parseDockerVersion(raw: string): string {
	const match = raw.match(/(\d+(?:\.\d+)+)/);
	if (match !== null) return match[1];
	return raw;
}

let runnerOverride: DockerVersionRunner | null = null;

/** Test seam: replace the process spawn. Pass null to restore. */
export function __setDockerProbeRunnerForTests(runner: DockerVersionRunner | null): void {
	runnerOverride = runner;
}

export async function probeDockerAvailability(): Promise<DockerProbeResult> {
	const runner = runnerOverride ?? runDockerVersion;
	try {
		const raw = await runner();
		if (raw === null) return { available: false, version: null };
		return { available: true, version: parseDockerVersion(raw) };
	} catch {
		// A probe must never take the panel down — degrade to "not found".
		return { available: false, version: null };
	}
}
