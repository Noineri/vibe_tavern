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
	const text = await readFile(LOCKFILE, "utf8");
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
