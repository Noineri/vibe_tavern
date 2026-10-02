/**
 * Isolated live test instance — `bun run test-instance <start|stop|status>`.
 *
 * WHY THIS EXISTS (owner request 2026-10-01): agents verifying a change in the
 * real app used to hand-roll the same five steps, and one variant of them
 * (`apps/web/dev-server.ts`, which hardcodes `<repo>/data` and ignores
 * VIBE_TAVERN_DATA_DIR) wrote into the owner's live DB — see
 * BUILD_MODE_F5_RESTORE_REPORT's execution log in the plan repo. This script is
 * the one sanctioned path:
 *
 *   start   1. snapshot the owner's data dir into a private temp dir — the DB via
 *              a READ-ONLY `VACUUM INTO` (WAL mode: a plain file copy can be
 *              torn), the file-store folders (characters/, personas/, assets/, …
 *              — the source of truth for card content, not the DB) via a copy
 *              that skips the model caches; `--fresh` starts from an empty dir;
 *           2. build the frontend when out/apps/web is older than its sources;
 *           3. spawn the PROD entry (never the dev server) detached, bound to
 *              127.0.0.1, with every inherited VIBE_TAVERN_* var dropped so a
 *              stray VIBE_TAVERN_DB_PATH cannot point it back at the live DB,
 *              and the quota poller off (the snapshot carries the owner's
 *              provider profiles — `--quota-polling` re-enables it);
 *           4. wait for `[prod] Application ready.`, print URL / PID / paths.
 *   stop    kill the recorded PID (verified as the port's listener first —
 *           never by image name), then delete the instance dir.
 *   status  print the recorded instance and whether it is alive.
 *
 * One instance per port; the state lives in
 * `<VIBE_TAVERN_TEST_TEMP_BASE ?? tmpdir()>/vibe-tavern-test-instance-<port>/`
 * (instance.json, server.log, data/). Port 8788 is the owner's dev server and is
 * refused outright; a busy port is refused with the owning PID.
 */

import { closeSync, openSync } from "node:fs";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Database } from "bun:sqlite";

const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_PORT = 8787;
/** The owner's dev/playtest server ("Start Vibe Tavern Dev.bat"). Never bind it. */
export const OWNER_DEV_PORT = 8788;
export const INSTANCE_PREFIX = "vibe-tavern-test-instance-";
const DB_FILE = "vibe-tavern.db";
const READY_MARKER = "[prod] Application ready.";
const READY_TIMEOUT_MS = 180_000;

/** Snapshot-copy exclusions: the DB triplet (taken via VACUUM INTO instead) and
 *  multi-hundred-MB model caches the server re-downloads on demand. */
export function isSnapshotExcluded(entryName: string): boolean {
	if (entryName === DB_FILE || entryName.startsWith(`${DB_FILE}-`)) return true;
	return entryName.endsWith("-model-cache");
}

export type Command = "start" | "stop" | "status";

export interface CliOptions {
	readonly command: Command;
	readonly port: number;
	readonly fresh: boolean;
	readonly build: "auto" | "always" | "never";
	readonly source: string;
	readonly quotaPolling: boolean;
}

const USAGE = `Usage: bun run test-instance <start|stop|status> [options]

  start   snapshot the owner's data, build the web bundle if stale, launch prod
          --port <n>         listen port (default ${DEFAULT_PORT}; ${OWNER_DEV_PORT} is refused)
          --fresh            empty data dir instead of a snapshot
          --source <dir>     data dir to snapshot (default <repo>/data)
          --build            always rebuild the frontend
          --no-build         never rebuild (fails if out/apps/web is missing)
          --quota-polling    keep the provider quota poller on (off by default)
  stop    kill the instance by its recorded PID and delete its temp dir
  status  show the recorded instance and whether it is alive`;

export function parseCli(argv: readonly string[]): CliOptions {
	const { values, positionals } = parseArgs({
		args: [...argv],
		allowPositionals: true,
		strict: true,
		options: {
			port: { type: "string" },
			fresh: { type: "boolean" },
			source: { type: "string" },
			build: { type: "boolean" },
			"no-build": { type: "boolean" },
			"quota-polling": { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	const command = positionals[0];
	if (values.help === true || (command !== "start" && command !== "stop" && command !== "status") || positionals.length > 1) {
		throw new UsageError(USAGE);
	}
	const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new UsageError(`Invalid --port "${values.port}".`);
	}
	if (port === OWNER_DEV_PORT) {
		throw new UsageError(`Port ${OWNER_DEV_PORT} is the owner's dev server — test instances never bind it.`);
	}
	if (values.build === true && values["no-build"] === true) {
		throw new UsageError("--build and --no-build are mutually exclusive.");
	}
	if (values.fresh === true && values.source !== undefined) {
		throw new UsageError("--fresh and --source are mutually exclusive.");
	}
	return {
		command,
		port,
		fresh: values.fresh === true,
		build: values.build === true ? "always" : values["no-build"] === true ? "never" : "auto",
		source: resolve(values.source ?? join(ROOT, "data")),
		quotaPolling: values["quota-polling"] === true,
	};
}

export class UsageError extends Error {}

// ─── Instance layout & state ─────────────────────────────────────────────────

export interface InstancePaths {
	readonly baseDir: string;
	readonly dataDir: string;
	readonly logPath: string;
	readonly statePath: string;
}

export function instancePaths(tempBase: string, port: number): InstancePaths {
	const baseDir = join(tempBase, `${INSTANCE_PREFIX}${port}`);
	return {
		baseDir,
		dataDir: join(baseDir, "data"),
		logPath: join(baseDir, "server.log"),
		statePath: join(baseDir, "instance.json"),
	};
}

export interface InstanceState {
	readonly pid: number;
	readonly port: number;
	readonly url: string;
	readonly baseDir: string;
	readonly dataDir: string;
	readonly logPath: string;
	readonly snapshotOf: string | null;
	readonly startedAt: string;
}

/** A recursive delete only ever targets a dir this script creates — guards
 *  against a hand-edited instance.json pointing `baseDir` somewhere else. */
export function isDeletableInstanceDir(dir: string, tempBase: string): boolean {
	const rel = relative(resolve(tempBase), resolve(dir));
	return rel !== "" && !rel.startsWith("..") && dirname(rel) === "." && basename(rel).startsWith(INSTANCE_PREFIX);
}

async function readState(statePath: string): Promise<InstanceState | null> {
	const file = Bun.file(statePath);
	if (!(await file.exists())) return null;
	return (await file.json()) as InstanceState;
}

// ─── Processes & ports ───────────────────────────────────────────────────────

/** PIDs listening on `port`, from `netstat -ano` output (Windows format:
 *  `  TCP    0.0.0.0:8787    0.0.0.0:0    LISTENING    1234`). */
export function parseNetstatListeners(output: string, port: number): number[] {
	const pids = new Set<number>();
	for (const line of output.split(/\r?\n/)) {
		const cols = line.trim().split(/\s+/);
		if (cols.length < 5 || cols[0] !== "TCP" || cols[3] !== "LISTENING") continue;
		if (!cols[1]?.endsWith(`:${port}`)) continue;
		const pid = Number(cols[4]);
		if (Number.isInteger(pid) && pid > 0) pids.add(pid);
	}
	return [...pids];
}

async function listenerPids(port: number): Promise<number[]> {
	if (process.platform === "win32") {
		const proc = Bun.spawn(["netstat", "-ano"], { stdout: "pipe", stderr: "ignore" });
		const output = await new Response(proc.stdout).text();
		await proc.exited;
		return parseNetstatListeners(output, port);
	}
	const proc = Bun.spawn(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { stdout: "pipe", stderr: "ignore" });
	const output = await new Response(proc.stdout).text();
	await proc.exited;
	return output.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Connect probe — catches a listener the PID lookup could not attribute. */
function portAcceptsConnections(port: number): Promise<boolean> {
	return new Promise((resolvePromise) => {
		const socket = connect({ host: "127.0.0.1", port });
		const done = (open: boolean) => {
			socket.destroy();
			resolvePromise(open);
		};
		socket.setTimeout(1_000, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** rm -rf with bounded retries for Windows' asynchronous handle release
 *  (same contract as scripts/test-file.ts `sweepDir`). */
async function removeDir(path: string): Promise<void> {
	for (let pass = 0; ; pass++) {
		try {
			await rm(path, { recursive: true, force: true });
			return;
		} catch (err) {
			if (pass >= 5) throw err;
			await sleep(300 * (pass + 1));
		}
	}
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

export async function snapshotData(source: string, target: string): Promise<void> {
	const sourceDb = join(source, DB_FILE);
	if (!(await Bun.file(sourceDb).exists())) {
		throw new Error(`No ${DB_FILE} in ${source} — nothing to snapshot (use --fresh for an empty instance).`);
	}
	await mkdir(target, { recursive: true });
	const targetDb = join(target, DB_FILE);
	// Read-only handle + VACUUM INTO: a transactionally consistent copy that
	// includes committed WAL frames, without writing a byte to the source.
	const db = new Database(sourceDb, { readonly: true });
	try {
		db.exec(`VACUUM INTO '${targetDb.replaceAll("'", "''")}'`);
	} finally {
		db.close();
	}
	for (const entry of await readdir(source, { withFileTypes: true })) {
		if (isSnapshotExcluded(entry.name)) continue;
		await cp(join(source, entry.name), join(target, entry.name), { recursive: true });
	}
}

// ─── Frontend build ──────────────────────────────────────────────────────────

/** Inputs of the web bundle: apps/web (minus tests/node_modules) and every
 *  package's src (the SPA imports domain, api-contracts, …). */
const WEB_SOURCE_ROOTS = [join(ROOT, "apps", "web"), join(ROOT, "packages")];
const SKIPPED_DIRS = new Set(["node_modules", "test", "tests", "__tests__", "dist", "out", "drizzle"]);

export function isWebSourceFile(name: string): boolean {
	return !/\.test\.[cm]?[jt]sx?$/.test(name);
}

async function newestMtime(dir: string): Promise<number> {
	let newest = 0;
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
			newest = Math.max(newest, await newestMtime(path));
		} else if (entry.isFile() && isWebSourceFile(entry.name)) {
			newest = Math.max(newest, (await stat(path)).mtimeMs);
		}
	}
	return newest;
}

async function ensureWebBuild(mode: CliOptions["build"]): Promise<void> {
	const indexHtml = join(ROOT, "out", "apps", "web", "index.html");
	const built = await stat(indexHtml).catch(() => null);
	if (mode === "never") {
		if (built === null) throw new Error(`--no-build, but ${indexHtml} does not exist.`);
		console.log("[test-instance] Frontend: using existing out/apps/web (--no-build).");
		return;
	}
	if (mode === "auto" && built !== null) {
		const newestSource = Math.max(...(await Promise.all(WEB_SOURCE_ROOTS.map(newestMtime))));
		if (newestSource <= built.mtimeMs) {
			console.log("[test-instance] Frontend: out/apps/web is up to date.");
			return;
		}
	}
	console.log("[test-instance] Frontend: building (bun run --filter @vibe-tavern/web build)...");
	const proc = Bun.spawn(["bun", "run", "--filter", "@vibe-tavern/web", "build"], {
		cwd: ROOT,
		stdout: "inherit",
		stderr: "inherit",
	});
	if ((await proc.exited) !== 0) throw new Error("Frontend build failed.");
}

// ─── Child environment ───────────────────────────────────────────────────────

/** The instance's env: the caller's env minus every VIBE_TAVERN_* (a leaked
 *  VIBE_TAVERN_DB_PATH or ROOT_DIR would point the instance at live data), plus
 *  the instance's own settings. */
export function instanceEnv(
	base: Readonly<Record<string, string | undefined>>,
	opts: { readonly dataDir: string; readonly port: number; readonly quotaPolling: boolean },
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value === undefined || key.startsWith("VIBE_TAVERN_")) continue;
		env[key] = value;
	}
	env.VIBE_TAVERN_ROOT_DIR = ROOT;
	env.VIBE_TAVERN_DATA_DIR = opts.dataDir;
	env.VIBE_TAVERN_HOST = "127.0.0.1";
	env.VIBE_TAVERN_PORT = String(opts.port);
	env.VIBE_TAVERN_OPEN_BROWSER = "0";
	if (!opts.quotaPolling) env.VIBE_TAVERN_QUOTA_POLLING = "0";
	return env;
}

// ─── Verbs ───────────────────────────────────────────────────────────────────

async function start(opts: CliOptions, tempBase: string): Promise<void> {
	const paths = instancePaths(tempBase, opts.port);
	const existing = await readState(paths.statePath);
	if (existing !== null && isAlive(existing.pid)) {
		throw new Error(
			`An instance is already recorded on port ${opts.port} (PID ${existing.pid}, ${existing.url}). ` +
				`Run "bun run test-instance stop --port ${opts.port}" first.`,
		);
	}
	const owners = await listenerPids(opts.port);
	if (owners.length > 0 || (await portAcceptsConnections(opts.port))) {
		const who = owners.length > 0 ? `PID ${owners.join(", ")}` : "an unidentified process";
		throw new Error(`Port ${opts.port} is busy (${who}). Not starting; stop that process or pick --port.`);
	}
	if (resolve(opts.source) === resolve(paths.dataDir)) {
		throw new Error("--source must not be the instance's own data dir.");
	}

	// Stale leftovers from a crashed run are ours to clear.
	await removeDir(paths.baseDir);
	await mkdir(paths.baseDir, { recursive: true });

	if (opts.fresh) {
		await mkdir(paths.dataDir, { recursive: true });
		console.log(`[test-instance] Data: fresh empty dir ${paths.dataDir}`);
	} else {
		console.log(`[test-instance] Data: snapshotting ${opts.source} (read-only)...`);
		const t0 = performance.now();
		await snapshotData(opts.source, paths.dataDir);
		console.log(`[test-instance] Data: snapshot done in ${((performance.now() - t0) / 1000).toFixed(1)}s → ${paths.dataDir}`);
	}

	await ensureWebBuild(opts.build);

	// One append-mode fd shared by stdout and stderr — two separate handles on
	// the same file would overwrite each other's output.
	const logFd = openSync(paths.logPath, "a");
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", join("services", "api", "src", "server", "prod-server.ts")],
		{
			cwd: ROOT,
			env: instanceEnv(Bun.env, { dataDir: paths.dataDir, port: opts.port, quotaPolling: opts.quotaPolling }),
			stdin: "ignore",
			stdout: logFd,
			stderr: logFd,
			detached: true,
		},
	);
	child.unref();
	closeSync(logFd);

	const url = `http://127.0.0.1:${opts.port}`;
	const state: InstanceState = {
		pid: child.pid,
		port: opts.port,
		url,
		baseDir: paths.baseDir,
		dataDir: paths.dataDir,
		logPath: paths.logPath,
		snapshotOf: opts.fresh ? null : opts.source,
		startedAt: new Date().toISOString(),
	};
	await Bun.write(paths.statePath, `${JSON.stringify(state, null, "\t")}\n`);

	const deadline = Date.now() + READY_TIMEOUT_MS;
	for (;;) {
		const log = await Bun.file(paths.logPath).text().catch(() => "");
		if (log.includes(READY_MARKER)) break;
		if (!isAlive(child.pid)) {
			throw new Error(`Instance exited during startup. Log tail (${paths.logPath}):\n${log.split("\n").slice(-30).join("\n")}`);
		}
		if (Date.now() > deadline) {
			throw new Error(
				`No "${READY_MARKER}" after ${READY_TIMEOUT_MS / 1000}s; PID ${child.pid} left running — ` +
					`inspect ${paths.logPath}, then "bun run test-instance stop --port ${opts.port}".`,
			);
		}
		await sleep(250);
	}

	console.log("[test-instance] Ready.");
	printState(state, true);
	console.log(`  stop:      bun run test-instance stop --port ${opts.port}`);
}

async function stop(opts: CliOptions, tempBase: string): Promise<void> {
	const paths = instancePaths(tempBase, opts.port);
	const state = await readState(paths.statePath);
	if (state === null) {
		console.log(`[test-instance] No instance recorded on port ${opts.port} (${paths.statePath}).`);
		return;
	}
	if (isAlive(state.pid)) {
		const owners = await listenerPids(state.port);
		if (!owners.includes(state.pid)) {
			// The PID is alive but not our listener — after a crash Windows may have
			// recycled it for an unrelated process. Never kill on a guess.
			throw new Error(
				`Recorded PID ${state.pid} is alive but is not listening on port ${state.port} ` +
					`(listeners: ${owners.length > 0 ? owners.join(", ") : "none"}). Refusing to kill it; ` +
					`verify the process by hand, then delete ${state.baseDir}.`,
			);
		}
		process.kill(state.pid);
		for (let i = 0; i < 40 && isAlive(state.pid); i++) await sleep(250);
		if (isAlive(state.pid)) throw new Error(`PID ${state.pid} did not exit after kill.`);
		console.log(`[test-instance] Killed PID ${state.pid}.`);
	} else {
		console.log(`[test-instance] PID ${state.pid} is not running.`);
	}
	if (!isDeletableInstanceDir(state.baseDir, tempBase)) {
		throw new Error(`Recorded baseDir ${state.baseDir} is not a test-instance dir under ${tempBase}; not deleting it.`);
	}
	await removeDir(state.baseDir);
	console.log(`[test-instance] Deleted ${state.baseDir}.`);
}

async function status(opts: CliOptions, tempBase: string): Promise<void> {
	const state = await readState(instancePaths(tempBase, opts.port).statePath);
	if (state === null) {
		console.log(`[test-instance] No instance recorded on port ${opts.port}.`);
		return;
	}
	printState(state, isAlive(state.pid));
}

function printState(state: InstanceState, alive: boolean): void {
	console.log(`  url:       ${state.url}`);
	console.log(`  pid:       ${state.pid}${alive ? "" : " (not running)"}`);
	console.log(`  data dir:  ${state.dataDir}${state.snapshotOf === null ? " (fresh)" : ` (snapshot of ${state.snapshotOf})`}`);
	console.log(`  log:       ${state.logPath}`);
	console.log(`  started:   ${state.startedAt}`);
}

async function main(): Promise<number> {
	let opts: CliOptions;
	try {
		opts = parseCli(process.argv.slice(2));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(message === USAGE ? USAGE : `${message}\n\n${USAGE}`);
		return 2;
	}
	const tempBase = resolve(Bun.env.VIBE_TAVERN_TEST_TEMP_BASE ?? tmpdir());
	try {
		if (opts.command === "start") await start(opts, tempBase);
		else if (opts.command === "stop") await stop(opts, tempBase);
		else await status(opts, tempBase);
		return 0;
	} catch (err) {
		console.error(`[test-instance] ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
}

if (import.meta.main) process.exitCode = await main();
