import type { OpenDataDirResult, SystemRuntimeApi } from "../contract/system-api.js";
import { detectInstallKind } from "../../domain/update/update-orchestrator.js";

/**
 * argv that opens `dir` in the platform's file manager.
 *
 * Pure and exported for per-platform tests: the path always lands as ONE argv
 * element — Bun.spawn execs directly with no shell, so spaces, quotes and
 * metacharacters in a directory name can never be re-parsed as commands
 * (the structural no-shell-injection guarantee the route test pins).
 *
 * Windows uses `explorer.exe` (present everywhere; `start` would need cmd.exe
 * quoting rules), and its exit code is ignored: explorer exits 1 in several
 * success shapes, including when the folder window simply opens.
 */
export function openDirCommand(platform: string, dir: string): string[] {
	if (platform === "win32") return ["explorer.exe", dir];
	if (platform === "darwin") return ["open", dir];
	return ["xdg-open", dir];
}

/** Spawn seam type — Bun.spawn in production, a double in tests. */
export type SpawnFn = (cmd: string[]) => Promise<{ exitCode: number | null; stderr: string }>;

export const bunSpawn: SpawnFn = async (cmd) => {
	const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { exitCode, stderr };
};

export class SystemAdapter implements SystemRuntimeApi {
	private readonly dataDir: string;
	private readonly platform: string;
	private readonly spawn: SpawnFn;

	constructor(deps: { dataDir: string; platform?: string; spawn?: SpawnFn }) {
		this.dataDir = deps.dataDir;
		this.platform = deps.platform ?? process.platform;
		this.spawn = deps.spawn ?? bunSpawn;
	}

	openDataDir = async (): Promise<OpenDataDirResult> => {
		// A harness-built adapter without a data dir has nothing to open.
		if (!this.dataDir) return { available: false };
		// The phone app's data dir is private to the APK — nothing to show.
		if (detectInstallKind() === "android" || this.platform === "android") return { available: false };
		const cmd = openDirCommand(this.platform, this.dataDir);
		try {
			const run = await this.spawn(cmd);
			// explorer.exe exits 1 on several success shapes (see openDirCommand);
			// everywhere else a non-zero exit means the manager refused the path.
			if (this.platform !== "win32" && run.exitCode !== 0) {
				return { error: run.stderr.trim() || `exit code ${run.exitCode}` };
			}
			return { opened: true };
		} catch (e) {
			return { error: e instanceof Error ? e.message : String(e) };
		}
	};
}
