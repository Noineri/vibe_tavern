// hygiene:allow-abs-path-inputs — a quoted bun.exe path is classifier input data (a process command line), never opened
/**
 * Pins the pure decisions of the launcher (scripts/start.ts). Nothing here
 * launches the app: the fingerprint tests run against throwaway git repos
 * under tmpdir(), the port probe uses an ephemeral port (never 8787/8788).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assembleFingerprint,
	classifyHolder,
	computeFingerprint,
	createLogChunkWriter,
	DEFAULT_PORT,
	describeExit,
	formatLogStamp,
	holderPrompt,
	isPortFree,
	isYes,
	mcpWebDefaults,
	parseDotEnv,
	parseHolders,
	promptDefaultYes,
	resolvePort,
	splitIncompleteEscape,
	stripAnsi,
	waitForPortFree,
	type PortHolder,
} from "./start.js";

const temporaryDirectories: string[] = [];

afterAll(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(dir);
	return dir;
}

describe("resolvePort", () => {
	test("defaults when unset or empty, accepts a valid port, rejects garbage", () => {
		expect(resolvePort(undefined)).toBe(DEFAULT_PORT);
		expect(resolvePort("")).toBe(DEFAULT_PORT);
		expect(resolvePort("9001")).toBe(9001);
		expect(resolvePort("0")).toBeNull();
		expect(resolvePort("70000")).toBeNull();
		expect(resolvePort("abc")).toBeNull();
		expect(resolvePort("80.5")).toBeNull();
	});
});

describe("parseDotEnv", () => {
	test("skips comments and blank lines, keeps everything after the first =", () => {
		const parsed = parseDotEnv(
			["# a comment", "", "A=1", "B=x=y=z", "  # indented comment", "C=pa!ss!word", "D="].join("\r\n"),
		);
		expect(Object.fromEntries(parsed)).toEqual({ A: "1", B: "x=y=z", C: "pa!ss!word", D: "" });
	});

	test("ignores a BOM, lines without a key, and lets a later duplicate win", () => {
		const parsed = parseDotEnv("\uFEFFA=1\n=novalue\njunk\nA=2\n");
		expect(Object.fromEntries(parsed)).toEqual({ A: "2" });
	});
});

describe("mcpWebDefaults", () => {
	test("a missing file maps to nothing", () => {
		expect(mcpWebDefaults(null)).toEqual({});
	});

	test("maps the NanoGPT keys case-insensitively and sets the provider label", () => {
		const defaults = mcpWebDefaults(
			["# keys", "nano_gpt_base_url=https://nano.example/v1?a=b!", "NANO_GPT_MODEL=some/model", "OTHER=ignored"].join("\n"),
		);
		expect(defaults).toEqual({
			VIBE_TAVERN_WEB_DEFAULT_PROVIDER_LABEL: "NanoGPT",
			VIBE_TAVERN_WEB_DEFAULT_BASE_URL: "https://nano.example/v1?a=b!",
			VIBE_TAVERN_WEB_DEFAULT_MODEL: "some/model",
		});
	});

	test("an existing file without the keys still sets the provider label", () => {
		expect(mcpWebDefaults("OTHER=1\n")).toEqual({ VIBE_TAVERN_WEB_DEFAULT_PROVIDER_LABEL: "NanoGPT" });
	});
});

describe("describeExit", () => {
	test("maps exit codes to the end-of-run messages", () => {
		expect(describeExit(0, null)).toBe("Server stopped cleanly.");
		expect(describeExit(1, null)).toBe("Server stopped (code 1).");
		expect(describeExit(3221225786, null)).toBe("Server stopped (Ctrl+C).");
		expect(describeExit(-1073741510, null)).toBe("Server stopped (Ctrl+C).");
		expect(describeExit(0xc000013a, null)).toBe("Server stopped (Ctrl+C).");
		expect(describeExit(137, null)).toBe("Server exited with code 137.");
	});

	test("a signal exit without a code is reported, SIGINT as Ctrl+C", () => {
		expect(describeExit(null, "SIGINT")).toBe("Server stopped (Ctrl+C).");
		expect(describeExit(null, "SIGKILL")).toBe("Server was terminated (SIGKILL).");
	});
});

describe("port holder classification", () => {
	const ours: PortHolder = {
		pid: 4242,
		name: "bun.exe",
		commandLine: '"C:\\bun\\bun.exe" --no-env-file services/api/src/server/prod-server.ts',
	};

	test("bun running prod-server.ts is ours", () => {
		expect(classifyHolder(ours)).toBe("ours");
		expect(classifyHolder({ ...ours, name: "BUN.EXE" })).toBe("ours");
		expect(classifyHolder({ ...ours, name: "bun" })).toBe("ours");
	});

	test("anything else is foreign", () => {
		expect(classifyHolder({ ...ours, name: "node.exe" })).toBe("foreign");
		expect(classifyHolder({ ...ours, commandLine: "bun run something-else.ts" })).toBe("foreign");
		expect(classifyHolder({ ...ours, commandLine: null })).toBe("foreign");
		expect(classifyHolder({ ...ours, name: "bunny.exe" })).toBe("foreign");
		expect(classifyHolder({ pid: 7, name: "node.exe", commandLine: "node prod-server.ts" })).toBe("foreign");
	});

	test("Enter kills only our own server", () => {
		expect(promptDefaultYes("ours")).toBe(true);
		expect(promptDefaultYes("foreign")).toBe(false);
		expect(isYes("", true)).toBe(true);
		expect(isYes("", false)).toBe(false);
		expect(isYes("  ", false)).toBe(false);
		expect(isYes("y", false)).toBe(true);
		expect(isYes("YES", false)).toBe(true);
		expect(isYes("n", true)).toBe(false);
		expect(isYes("maybe", true)).toBe(false);
	});

	test("the prompt shows name, PID and command line, with the matching default marker", () => {
		const own = holderPrompt(ours, 8787);
		expect(own.defaultYes).toBe(true);
		expect(own.question).toContain("[Y/n]");
		const shown = own.details.join("\n");
		expect(shown).toContain("bun.exe");
		expect(shown).toContain("4242");
		expect(shown).toContain("prod-server.ts");

		const other = holderPrompt({ pid: 99, name: "chrome.exe", commandLine: null }, 8787);
		expect(other.defaultYes).toBe(false);
		expect(other.question).toContain("[y/N]");
		expect(other.details.join("\n")).toContain("chrome.exe");
		expect(other.details.join("\n")).toContain("99");
		expect(other.details.join("\n")).toContain("(not available)");
	});
});

describe("parseHolders", () => {
	test("reads the PowerShell JSON, one holder or several, null command line allowed", () => {
		const text = JSON.stringify([
			{ pid: 10, name: "bun.exe", commandLine: "bun prod-server.ts" },
			{ pid: 11, name: "System", commandLine: null },
		]);
		expect(parseHolders(text)).toEqual([
			{ pid: 10, name: "bun.exe", commandLine: "bun prod-server.ts" },
			{ pid: 11, name: "System", commandLine: null },
		]);
		expect(parseHolders('{"pid":5,"name":"a","commandLine":"b"}')).toEqual([{ pid: 5, name: "a", commandLine: "b" }]);
	});

	test("empty, null entries, PID 0 and non-JSON all yield no holder", () => {
		expect(parseHolders("[]")).toEqual([]);
		expect(parseHolders("[null]")).toEqual([]);
		expect(parseHolders('[{"pid":0,"name":"Idle","commandLine":null}]')).toEqual([]);
		expect(parseHolders("")).toEqual([]);
		expect(parseHolders("not json")).toEqual([]);
	});
});

describe("formatLogStamp", () => {
	test("is yyyy-MM-dd_HHmmss in local time with zero padding", () => {
		expect(formatLogStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02_030405");
		expect(formatLogStamp(new Date(2026, 11, 31, 23, 59, 59))).toBe("2026-12-31_235959");
	});
});

describe("ANSI stripping", () => {
	test("removes colors, cursor moves and OSC titles, leaves text", () => {
		expect(stripAnsi("\u001b[31mred\u001b[0m plain")).toBe("red plain");
		expect(stripAnsi("\u001b[2K\u001b[1Gline")).toBe("line");
		expect(stripAnsi("\u001b]0;title\u0007after")).toBe("after");
		expect(stripAnsi("\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\")).toBe("link");
		expect(stripAnsi("no escapes [31m here")).toBe("no escapes [31m here");
	});

	test("holds back a sequence cut by a chunk boundary", () => {
		expect(splitIncompleteEscape("abc\u001b[3")).toEqual({ complete: "abc", tail: "\u001b[3" });
		expect(splitIncompleteEscape("abc\u001b")).toEqual({ complete: "abc", tail: "\u001b" });
		expect(splitIncompleteEscape("abc\u001b[31m")).toEqual({ complete: "abc\u001b[31m", tail: "" });
		expect(splitIncompleteEscape("plain")).toEqual({ complete: "plain", tail: "" });
	});

	test("the log writer decodes UTF-8 split across chunks and strips split escapes", () => {
		const written: string[] = [];
		const writer = createLogChunkWriter((text) => written.push(text));
		const encoder = new TextEncoder();
		const bytes = encoder.encode("\u001b[32mok\u001b[0m caf\u00e9 \u2713\n");
		// Cut inside the first escape and inside the multi-byte check mark.
		const cutInEscape = 2;
		const cutInCheck = bytes.length - 3;
		writer.push(bytes.slice(0, cutInEscape));
		writer.push(bytes.slice(cutInEscape, cutInCheck));
		writer.push(bytes.slice(cutInCheck));
		writer.flush();
		expect(written.join("")).toBe("ok caf\u00e9 \u2713\n");
	});
});

describe("assembleFingerprint", () => {
	const base = {
		head: "abc123",
		diff: new TextEncoder().encode("diff --git a/x b/x\n"),
		untracked: [
			{ path: "a.txt", hash: "h1" },
			{ path: "b.txt", hash: "h2" },
		],
		webEnv: {
			VIBE_TAVERN_WEB_DEFAULT_PROVIDER_LABEL: "NanoGPT",
			VIBE_TAVERN_WEB_DEFAULT_BASE_URL: "https://x/v1",
			VIBE_TAVERN_WEB_DEFAULT_MODEL: "m",
		},
	};

	test("is stable, ignores untracked listing order, and reacts to every input", () => {
		const reference = assembleFingerprint(base);
		expect(assembleFingerprint({ ...base })).toBe(reference);
		expect(assembleFingerprint({ ...base, untracked: [...base.untracked].reverse() })).toBe(reference);
		expect(assembleFingerprint({ ...base, head: "def456" })).not.toBe(reference);
		expect(assembleFingerprint({ ...base, diff: new TextEncoder().encode("other") })).not.toBe(reference);
		expect(assembleFingerprint({ ...base, untracked: [{ path: "a.txt", hash: "h1" }] })).not.toBe(reference);
		expect(
			assembleFingerprint({
				...base,
				untracked: [
					{ path: "a.txt", hash: "changed" },
					{ path: "b.txt", hash: "h2" },
				],
			}),
		).not.toBe(reference);
		for (const key of Object.keys(base.webEnv)) {
			expect(assembleFingerprint({ ...base, webEnv: { ...base.webEnv, [key]: "changed" } })).not.toBe(reference);
		}
	});

	test("field boundaries cannot be shifted to forge a collision", () => {
		const left = assembleFingerprint({ ...base, head: "ab", diff: new TextEncoder().encode("c") });
		const right = assembleFingerprint({ ...base, head: "a", diff: new TextEncoder().encode("bc") });
		expect(left).not.toBe(right);
	});
});

describe("computeFingerprint (throwaway git repo)", () => {
	const webEnv = {
		VIBE_TAVERN_WEB_DEFAULT_PROVIDER_LABEL: "",
		VIBE_TAVERN_WEB_DEFAULT_BASE_URL: "",
		VIBE_TAVERN_WEB_DEFAULT_MODEL: "",
	};

	async function git(cwd: string, ...args: string[]): Promise<void> {
		const proc = Bun.spawn(
			["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
			{ cwd, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
		);
		const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
		if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	}

	async function makeRepo(): Promise<string> {
		const repo = await tempDir("vt-start-fp-");
		await git(repo, "init", "-q");
		await writeFile(join(repo, ".gitignore"), "out/\nignored.txt\n");
		await writeFile(join(repo, "tracked.txt"), "one\n");
		await git(repo, "add", ".gitignore", "tracked.txt");
		await git(repo, "commit", "-q", "-m", "init");
		return repo;
	}

	test("equal when nothing changed, different after each kind of change", async () => {
		const repo = await makeRepo();
		const clean = await computeFingerprint(repo, webEnv);
		expect(clean).toMatch(/^[0-9a-f]{64}$/);
		expect(await computeFingerprint(repo, webEnv)).toBe(clean);

		// Tracked edit: differs, staged or not, and reverting restores it.
		await writeFile(join(repo, "tracked.txt"), "two\n");
		const edited = await computeFingerprint(repo, webEnv);
		expect(edited).not.toBe(clean);
		await git(repo, "add", "tracked.txt");
		expect(await computeFingerprint(repo, webEnv)).toBe(edited);
		await writeFile(join(repo, "tracked.txt"), "one\n");
		await git(repo, "add", "tracked.txt");
		expect(await computeFingerprint(repo, webEnv)).toBe(clean);

		// Untracked file: its presence and its content both count.
		await writeFile(join(repo, "new.txt"), "a\n");
		const withNew = await computeFingerprint(repo, webEnv);
		expect(withNew).not.toBe(clean);
		await writeFile(join(repo, "new.txt"), "b\n");
		expect(await computeFingerprint(repo, webEnv)).not.toBe(withNew);
		await rm(join(repo, "new.txt"));
		expect(await computeFingerprint(repo, webEnv)).toBe(clean);

		// Ignored files and the build output itself never count.
		await writeFile(join(repo, "ignored.txt"), "x\n");
		await mkdir(join(repo, "out"), { recursive: true });
		await writeFile(join(repo, "out", ".launch-fingerprint"), "whatever\n");
		expect(await computeFingerprint(repo, webEnv)).toBe(clean);

		// The baked-in web defaults count.
		expect(await computeFingerprint(repo, { ...webEnv, VIBE_TAVERN_WEB_DEFAULT_MODEL: "m2" })).not.toBe(clean);

		// A new commit changes HEAD even though the content is the same as before.
		await git(repo, "commit", "-q", "--allow-empty", "-m", "empty");
		expect(await computeFingerprint(repo, webEnv)).not.toBe(clean);
	});

	test("not a git checkout, a repo subdirectory, or a repo without commits means no fingerprint", async () => {
		const plain = await tempDir("vt-start-fp-plain-");
		expect(await computeFingerprint(plain, webEnv)).toBeNull();

		const repo = await makeRepo();
		const sub = join(repo, "sub");
		await mkdir(sub);
		expect(await computeFingerprint(sub, webEnv)).toBeNull();

		const empty = await tempDir("vt-start-fp-empty-");
		await git(empty, "init", "-q");
		expect(await computeFingerprint(empty, webEnv)).toBeNull();
	});
});

describe("port probe (ephemeral port)", () => {
	test("a bound port is busy, a released one is free", async () => {
		const holder = Bun.serve({ port: 0, hostname: "0.0.0.0", fetch: () => new Response() });
		const port = holder.port;
		if (port === undefined) throw new Error("ephemeral port was not assigned");
		try {
			expect(isPortFree(port)).toBe(false);
		} finally {
			holder.stop(true);
		}
		expect(await waitForPortFree(port, "0.0.0.0", 5_000, 50)).toBe(true);
		expect(isPortFree(port)).toBe(true);
	});
});
