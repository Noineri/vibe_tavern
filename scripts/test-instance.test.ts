import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
	INSTANCE_PREFIX,
	OWNER_DEV_PORT,
	UsageError,
	instanceEnv,
	instancePaths,
	isDeletableInstanceDir,
	isSnapshotExcluded,
	isWebSourceFile,
	parseCli,
	parseNetstatListeners,
	snapshotData,
} from "./test-instance.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "vt-test-instance-"));
	temporaryDirectories.push(dir);
	return dir;
}

test("parseCli: defaults to port 8787, snapshot of repo data, auto build, quota polling off", () => {
	const opts = parseCli(["start"]);
	expect(opts.command).toBe("start");
	expect(opts.port).toBe(8787);
	expect(opts.fresh).toBe(false);
	expect(opts.build).toBe("auto");
	expect(opts.quotaPolling).toBe(false);
	expect(opts.source).toBe(join(import.meta.dir, "..", "data"));
});

test("parseCli: refuses the owner's dev port", () => {
	expect(() => parseCli(["start", "--port", String(OWNER_DEV_PORT)])).toThrow(UsageError);
	expect(() => parseCli(["stop", "--port", String(OWNER_DEV_PORT)])).toThrow(UsageError);
});

test("parseCli: rejects unknown verbs, bad ports and contradictory flags", () => {
	expect(() => parseCli([])).toThrow(UsageError);
	expect(() => parseCli(["restart"])).toThrow(UsageError);
	expect(() => parseCli(["start", "--port", "abc"])).toThrow(UsageError);
	expect(() => parseCli(["start", "--port", "70000"])).toThrow(UsageError);
	expect(() => parseCli(["start", "--build", "--no-build"])).toThrow(UsageError);
	expect(() => parseCli(["start", "--fresh", "--source", "x"])).toThrow(UsageError);
	expect(parseCli(["start", "--no-build"]).build).toBe("never");
	expect(parseCli(["start", "--build", "--quota-polling"]).quotaPolling).toBe(true);
});

test("parseNetstatListeners: picks LISTENING rows on exactly the port, v4 and v6", () => {
	const output = [
		"Active Connections",
		"",
		"  Proto  Local Address          Foreign Address        State           PID",
		"  TCP    0.0.0.0:8787           0.0.0.0:0              LISTENING       4120",
		"  TCP    0.0.0.0:18787          0.0.0.0:0              LISTENING       999",
		"  TCP    127.0.0.1:8787         127.0.0.1:51234        ESTABLISHED     4120",
		"  TCP    127.0.0.1:51234        127.0.0.1:8787         ESTABLISHED     777",
		"  TCP    [::]:8787              [::]:0                 LISTENING       4120",
		"  TCP    [::1]:8788             [::]:0                 LISTENING       555",
		"  UDP    0.0.0.0:8787           *:*                                    888",
	].join("\r\n");
	expect(parseNetstatListeners(output, 8787)).toEqual([4120]);
	expect(parseNetstatListeners(output, 8788)).toEqual([555]);
	expect(parseNetstatListeners(output, 9999)).toEqual([]);
});

test("isDeletableInstanceDir: only direct prefixed children of the temp base", () => {
	const base = join(tmpdir(), "vt-base");
	expect(isDeletableInstanceDir(instancePaths(base, 8787).baseDir, base)).toBe(true);
	expect(isDeletableInstanceDir(base, base)).toBe(false);
	expect(isDeletableInstanceDir(join(base, "other-dir"), base)).toBe(false);
	expect(isDeletableInstanceDir(join(base, `${INSTANCE_PREFIX}8787`, "data"), base)).toBe(false);
	expect(isDeletableInstanceDir(join(base, "..", `${INSTANCE_PREFIX}8787`), base)).toBe(false);
});

test("instanceEnv: drops every inherited VIBE_TAVERN_* and pins the instance settings", () => {
	const env = instanceEnv(
		{ PATH: "p", VIBE_TAVERN_DB_PATH: "live.db", VIBE_TAVERN_ROOT_DIR: "elsewhere", VIBE_TAVERN_PORT: "8788", UNSET: undefined },
		{ dataDir: "d", port: 8787, quotaPolling: false },
	);
	expect(env.PATH).toBe("p");
	expect("VIBE_TAVERN_DB_PATH" in env).toBe(false);
	expect("UNSET" in env).toBe(false);
	expect(env.VIBE_TAVERN_ROOT_DIR).toBe(join(import.meta.dir, ".."));
	expect(env.VIBE_TAVERN_DATA_DIR).toBe("d");
	expect(env.VIBE_TAVERN_PORT).toBe("8787");
	expect(env.VIBE_TAVERN_HOST).toBe("127.0.0.1");
	expect(env.VIBE_TAVERN_OPEN_BROWSER).toBe("0");
	expect(env.VIBE_TAVERN_QUOTA_POLLING).toBe("0");
	expect("VIBE_TAVERN_QUOTA_POLLING" in instanceEnv({}, { dataDir: "d", port: 8787, quotaPolling: true })).toBe(false);
});

test("isSnapshotExcluded / isWebSourceFile: DB triplet + model caches; test files", () => {
	for (const name of ["vibe-tavern.db", "vibe-tavern.db-wal", "vibe-tavern.db-shm", "kokoro-model-cache", "whisper-model-cache"]) {
		expect(isSnapshotExcluded(name)).toBe(true);
	}
	for (const name of ["characters", "assets", "mobile-access.json", "vibe-tavern.db.bak"]) {
		expect(isSnapshotExcluded(name)).toBe(false);
	}
	expect(isWebSourceFile("chat-view.tsx")).toBe(true);
	expect(isWebSourceFile("chat-view.test.tsx")).toBe(false);
	expect(isWebSourceFile("store.test.ts")).toBe(false);
});

test("snapshotData: captures uncheckpointed WAL rows and the file-store folders, skips caches", async () => {
	const source = await tempDir();
	const target = join(await tempDir(), "data");
	const writer = new Database(join(source, "vibe-tavern.db"));
	try {
		writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
		writer.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('committed-in-wal');");
		await mkdir(join(source, "characters", "adam"), { recursive: true });
		await Bun.write(join(source, "characters", "adam", "profile.md"), "# Adam\n");
		await mkdir(join(source, "kokoro-model-cache"));
		await Bun.write(join(source, "kokoro-model-cache", "model.bin"), "x");

		// The writer stays open: the row lives only in the WAL, as with a running server.
		await snapshotData(source, target);
	} finally {
		writer.close();
	}

	const copy = new Database(join(target, "vibe-tavern.db"), { readonly: true });
	try {
		expect(copy.query("SELECT v FROM t").all()).toEqual([{ v: "committed-in-wal" }]);
	} finally {
		copy.close();
	}
	expect(await Bun.file(join(target, "characters", "adam", "profile.md")).text()).toBe("# Adam\n");
	expect((await readdir(target)).sort()).toEqual(["characters", "vibe-tavern.db"]);
});

test("snapshotData: a source without a DB is an error, not an empty instance", async () => {
	const source = await tempDir();
	await expect(snapshotData(source, join(await tempDir(), "data"))).rejects.toThrow("--fresh");
});
