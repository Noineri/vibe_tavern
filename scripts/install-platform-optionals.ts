/**
 * Install platform-specific optional dependencies that `bun install --frozen-lockfile` skips.
 *
 * WHY THIS SCRIPT EXISTS:
 *   Bun issue #16696 — `bun install --frozen-lockfile` silently skips platform-specific
 *   optional dependencies (native bindings like rolldown, lightningcss, tailwindcss/oxide)
 *   in workspace setups. This script parses bun.lock, finds the packages matching the
 *   current OS/CPU/libc, and installs them explicitly via `bun install --no-save`.
 *
 *   See: https://github.com/oven-sh/bun/issues/16696
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const LOCKFILE = join(ROOT, "bun.lock");

const cpuByArch: Record<string, string> = {
	x64: "x64",
	arm64: "arm64",
	arm: "arm",
};

const os = process.env.NATIVE_OS ?? process.platform;
const cpu = process.env.NATIVE_CPU ?? (cpuByArch[process.arch] ?? process.arch);
const libc = process.env.NATIVE_LIBC ?? (os === "linux" ? "gnu" : undefined);

function specFromEntry(name: string, resolved: string): string | null {
	const prefix = `${name}@`;
	if (!resolved.startsWith(prefix)) return null;
	const version = resolved.slice(prefix.length);
	return `${name}@${version}`;
}

function metaValue(meta: string, key: string): string | null {
	const match = meta.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
	return match?.[1] ?? null;
}

function matchesLibc(name: string): boolean {
	if (os !== "linux" || !libc) return true;
	const hasGnu = name.includes("-gnu") || name.includes("linux-gnu");
	const hasMusl = name.includes("-musl") || name.includes("linux-musl");
	if (!hasGnu && !hasMusl) return true;
	return libc === "musl" ? hasMusl : hasGnu;
}

async function run(command: string[]) {
	const proc = Bun.spawn(command, {
		cwd: ROOT,
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`${command.join(" ")} exited with code ${exitCode}`);
}

async function main() {
	const lockPath = LOCKFILE;
	if (!await Bun.file(lockPath).exists()) {
		console.error("[native-optionals] ERROR: bun.lock not found at", lockPath);
		process.exit(1);
	}
	const text = await readFile(lockPath, "utf8");
	if (text.length < 100) {
		console.warn("[native-optionals] WARNING: bun.lock is suspiciously small (" + text.length + " bytes)");
	}
	const specs = new Set<string>();
	const entryRe = /^\s*"([^"]+)": \["([^"]+)",\s*"[^"]*",\s*\{([^}]*)\}/gm;
	for (const match of text.matchAll(entryRe)) {
		const [, name, resolved, meta] = match;
		if (metaValue(meta, "os") !== os) continue;
		if (metaValue(meta, "cpu") !== cpu) continue;
		if (!matchesLibc(name)) continue;
		const spec = specFromEntry(name, resolved);
		if (spec) specs.add(spec);
	}

	if (specs.size === 0) {
		console.warn("[native-optionals] WARNING: No platform optional deps found for os=" + os + " cpu=" + cpu + (libc ? " libc=" + libc : ""));
		console.warn("[native-optionals] This may indicate a bun.lock format change. Expected at least 3 deps (rolldown, lightningcss, tailwindcss/oxide).");
	} else if (specs.size < 3) {
		console.warn("[native-optionals] WARNING: Only " + specs.size + " platform optional deps found. Expected at least 3 (rolldown, lightningcss, tailwindcss/oxide).");
	}

	if (specs.size === 0) {
		console.log(`[native-optionals] no platform optional deps for os=${os} cpu=${cpu}${libc ? ` libc=${libc}` : ""}`);
		return;
	}

	const list = [...specs].sort();
	console.log(`[native-optionals] installing ${list.length} platform optional deps for os=${os} cpu=${cpu}${libc ? ` libc=${libc}` : ""}`);
	for (const spec of list) console.log(`  - ${spec}`);
	if (process.env.DRY_RUN === "1") return;
	await run(["bun", "install", "--no-save", ...list]);
}

main().catch((error) => {
	console.error("[native-optionals] failed:", error);
	process.exit(1);
});
