/**
 * Launcher — everything `Start Vibe Tavern.bat` used to do inline, as one
 * Bun script. The bat is now only "is bun installed" + `bun scripts/start.ts`
 * + `pause`; the owner starts the app by double-clicking it, so nothing here
 * takes flags — every decision is made from the repo state and the environment.
 *
 * WHAT CHANGED AND WHY (launcher rework 2026-10-17):
 * - The bat ran a full `bun run build` on every launch. The build is now
 *   skipped when a fingerprint of everything that can change its output
 *   (see `computeFingerprint`) matches the one stored after the last
 *   successful build.
 * - The old port check used `Get-NetTCPConnection` without `-State Listen`,
 *   so TIME_WAIT leftovers (owner PID 0) right after a restart were reported
 *   as «already in use by PID 0». The check is now a bind probe on the
 *   server's own host; only when that fails is PowerShell asked — once —
 *   who LISTENS on the port.
 * - «Kill PID n? [Y/n]» killed an unknown foreign process on Enter. The
 *   prompt now shows name, PID and command line, and Enter kills only a
 *   verified previous Vibe Tavern server (a bun process running
 *   prod-server.ts); for anything else Enter cancels.
 * - Logs were UTF-16 LE with every stderr line wrapped as a PowerShell error
 *   record (Windows PowerShell 5.1 `Tee-Object`), unsearchable by grep. The
 *   server's output is now piped through this process: forwarded to the
 *   console unchanged, appended to the log as UTF-8 with ANSI codes stripped.
 * - Four powershell.exe starts per launch became zero in the normal case.
 *
 * Every pure decision (.env parsing, fingerprint assembly, exit-code message,
 * «is this our server», prompt defaults, ANSI stripping) is an exported
 * function so scripts/start.test.ts pins it without launching anything.
 */

import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

export const DEFAULT_PORT = 8787;

/** The prod server binds this host unless VIBE_TAVERN_HOST overrides it
 *  (services/api/src/server/prod-server.ts). The bind probe must use the same
 *  host, otherwise a holder bound to a different interface is invisible. */
export const SERVER_HOST = "0.0.0.0";

/** Build-time inputs read from the environment (apps/web/bun-plugin-build-config.ts
 *  bakes them into the web bundle), so they belong in the build fingerprint. */
export const WEB_DEFAULT_ENV_KEYS = [
	"VIBE_TAVERN_WEB_DEFAULT_PROVIDER_LABEL",
	"VIBE_TAVERN_WEB_DEFAULT_BASE_URL",
	"VIBE_TAVERN_WEB_DEFAULT_MODEL",
] as const;

const FINGERPRINT_FILE = join("out", ".launch-fingerprint");

/** Windows reports a console Ctrl+C exit as STATUS_CONTROL_C_EXIT, unsigned or signed. */
const CTRL_C_EXIT_CODES: ReadonlySet<number> = new Set([3221225786, -1073741510]);

// ─── Pure logic ───────────────────────────────────────────────────────

/** `VIBE_TAVERN_PORT` (default 8787). Null = set but not a usable port. */
export function resolvePort(raw: string | undefined): number | null {
	if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
	const port = Number(raw.trim());
	return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/**
 * Parse a KEY=VALUE file. Blank lines and lines whose first character is `#`
 * are skipped; the value is everything after the FIRST `=` (so `=` and `!`
 * inside values survive — the old bat's delayed expansion ate `!`). Later
 * duplicates win, like repeated `set`s did. Keys keep their case; callers
 * that want the bat's case-insensitive matching upper-case them.
 */
export function parseDotEnv(text: string): Map<string, string> {
	const entries = new Map<string, string>();
	const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
	for (const rawLine of body.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		if (key === "") continue;
		entries.set(key, line.slice(eq + 1).trim());
	}
	return entries;
}

/**
 * The web-bundle defaults taken from `..\mcp\.env` (null = the file does not
 * exist). When the file exists the provider label is always NanoGPT, even if
 * it carries neither key — that is what the bat did.
 */
export function mcpWebDefaults(envFileText: string | null): Record<string, string> {
	if (envFileText === null) return {};
	const defaults: Record<string, string> = { VIBE_TAVERN_WEB_DEFAULT_PROVIDER_LABEL: "NanoGPT" };
	for (const [key, value] of parseDotEnv(envFileText)) {
		const name = key.toUpperCase();
		if (name === "NANO_GPT_BASE_URL") defaults.VIBE_TAVERN_WEB_DEFAULT_BASE_URL = value;
		else if (name === "NANO_GPT_MODEL") defaults.VIBE_TAVERN_WEB_DEFAULT_MODEL = value;
	}
	return defaults;
}

/** End-of-run message for the server's exit status. */
export function describeExit(exitCode: number | null, signalCode: string | number | null): string {
	if (signalCode === "SIGINT") return "Server stopped (Ctrl+C).";
	if (exitCode === null) return `Server was terminated (${signalCode ?? "unknown signal"}).`;
	if (exitCode === 0) return "Server stopped cleanly.";
	if (exitCode === 1) return "Server stopped (code 1).";
	if (CTRL_C_EXIT_CODES.has(exitCode)) return "Server stopped (Ctrl+C).";
	return `Server exited with code ${exitCode}.`;
}

export interface PortHolder {
	readonly pid: number;
	readonly name: string;
	/** Null when Windows hides it (elevated or protected process). */
	readonly commandLine: string | null;
}

export type HolderClass = "ours" | "foreign";

/** Ours = a bun process whose command line runs prod-server.ts. Anything else,
 *  including a bun whose command line is unreadable, is foreign — Enter must
 *  never kill something that could not be verified. */
export function classifyHolder(holder: PortHolder): HolderClass {
	const isBun = /^bun(\.exe)?$/i.test(holder.name);
	return isBun && holder.commandLine !== null && holder.commandLine.includes("prod-server.ts")
		? "ours"
		: "foreign";
}

/** Enter kills our own stale server; Enter cancels for everything else. */
export function promptDefaultYes(classification: HolderClass): boolean {
	return classification === "ours";
}

export interface HolderPrompt {
	readonly classification: HolderClass;
	readonly defaultYes: boolean;
	/** Lines shown before the question. */
	readonly details: readonly string[];
	readonly question: string;
}

export function holderPrompt(holder: PortHolder, port: number): HolderPrompt {
	const classification = classifyHolder(holder);
	const defaultYes = promptDefaultYes(classification);
	const who = `${holder.name || "unknown process"} (PID ${holder.pid})`;
	const details = [
		classification === "ours"
			? `Port ${port} is held by a previous Vibe Tavern server: ${who}.`
			: `Port ${port} is held by another program: ${who}.`,
		`Command line: ${holder.commandLine ?? "(not available)"}`,
	];
	const question =
		classification === "ours"
			? `Stop it and continue? [${defaultYes ? "Y/n" : "y/N"}] `
			: `Kill it anyway? [${defaultYes ? "Y/n" : "y/N"}] `;
	return { classification, defaultYes, details, question };
}

/** Enter takes the default; otherwise only y/yes agree. */
export function isYes(answer: string, defaultYes: boolean): boolean {
	const trimmed = answer.trim().toLowerCase();
	if (trimmed === "") return defaultYes;
	return trimmed === "y" || trimmed === "yes";
}

/** Parse the JSON the PowerShell holder query prints. Tolerant: garbage = no holders. */
export function parseHolders(stdout: string): PortHolder[] {
	if (stdout.trim() === "") return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.trim());
	} catch (err) {
		// PowerShell printed something that is not JSON (blocked cmdlet, locale
		// banner): treat as "owner unknown", the caller says so to the user.
		console.error(`Could not read the port-owner query result: ${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
	const list = Array.isArray(parsed) ? parsed : [parsed];
	const holders: PortHolder[] = [];
	for (const item of list) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		const pid = typeof record.pid === "number" ? record.pid : Number(record.pid);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		holders.push({
			pid,
			name: typeof record.name === "string" ? record.name : "",
			commandLine: typeof record.commandLine === "string" ? record.commandLine : null,
		});
	}
	return holders;
}

/** `yyyy-MM-dd_HHmmss` in local time — the old bat's log-name stamp. */
export function formatLogStamp(date: Date): string {
	const two = (n: number): string => String(n).padStart(2, "0");
	return (
		`${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}` +
		`_${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
	);
}

// CSI (colors, cursor), OSC (titles, hyperlinks) and two-byte escapes.
const ANSI_PATTERN = "\\u001b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)|[@-Z\\\\^_])";
const ANSI_GLOBAL = new RegExp(ANSI_PATTERN, "g");
const ANSI_AT_START = new RegExp(`^${ANSI_PATTERN}`);

export function stripAnsi(text: string): string {
	return text.replace(ANSI_GLOBAL, "");
}

/** A chunk can end mid-escape-sequence; hold that tail back for the next chunk
 *  so a split `ESC [ 3 1 m` is stripped whole instead of leaking `31m`. */
export function splitIncompleteEscape(text: string): { complete: string; tail: string } {
	const idx = text.lastIndexOf("\u001b");
	if (idx < 0) return { complete: text, tail: "" };
	const tail = text.slice(idx);
	// A real sequence is short; a long ESC-led run is not worth holding forever.
	if (tail.length <= 64 && !ANSI_AT_START.test(tail)) return { complete: text.slice(0, idx), tail };
	return { complete: text, tail: "" };
}

/** Per-stream sink for the log file: UTF-8 decode (multi-byte characters can
 *  straddle chunks), strip ANSI, hand the clean text to `append`. */
export function createLogChunkWriter(append: (text: string) => void): {
	push(chunk: Uint8Array): void;
	flush(): void;
} {
	const decoder = new TextDecoder("utf-8");
	let pending = "";
	return {
		push(chunk) {
			const { complete, tail } = splitIncompleteEscape(pending + decoder.decode(chunk, { stream: true }));
			pending = tail;
			const clean = stripAnsi(complete);
			if (clean !== "") append(clean);
		},
		flush() {
			const clean = stripAnsi(pending + decoder.decode()).replaceAll("\u001b", "");
			pending = "";
			if (clean !== "") append(clean);
		},
	};
}

// ─── Build fingerprint ────────────────────────────────────────────────

export interface FingerprintInputs {
	readonly head: string;
	/** `git diff HEAD --binary` — tracked changes, staged or not. */
	readonly diff: Uint8Array;
	/** Untracked, non-ignored files: path + content hash. */
	readonly untracked: ReadonlyArray<{ readonly path: string; readonly hash: string }>;
	readonly webEnv: Readonly<Record<string, string>>;
}

/** sha256 over the inputs. Fields are length-prefixed and untracked files are
 *  sorted, so neither concatenation ambiguity nor git's listing order can
 *  change the result. */
export function assembleFingerprint(inputs: FingerprintInputs): string {
	const hasher = new Bun.CryptoHasher("sha256");
	const field = (label: string, data: string | Uint8Array): void => {
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
		hasher.update(`${label}:${bytes.length}:`);
		hasher.update(bytes);
		hasher.update("\n");
	};
	field("head", inputs.head);
	field("diff", inputs.diff);
	for (const file of [...inputs.untracked].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
		field("untracked-path", file.path);
		field("untracked-hash", file.hash);
	}
	for (const key of WEB_DEFAULT_ENV_KEYS) field(`env-${key}`, inputs.webEnv[key] ?? "");
	return hasher.digest("hex");
}

/** stdout bytes of a git command, or null when git is missing or the command fails. */
async function gitOutput(root: string, args: readonly string[]): Promise<Uint8Array | null> {
	try {
		const proc = Bun.spawn(["git", ...args], {
			cwd: root,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			// Read-only probe: never let git take the index lock to refresh stat data.
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
		});
		const [bytes, code] = await Promise.all([new Response(proc.stdout).bytes(), proc.exited]);
		return code === 0 ? bytes : null;
	} catch (err) {
		// git is not installed or not on PATH: not a git checkout for our purposes.
		console.error(`git unavailable: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

async function hashFile(path: string): Promise<string> {
	try {
		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update(await Bun.file(path).bytes());
		return hasher.digest("hex");
	} catch (err) {
		// A directory (nested repo) or a file that vanished mid-scan: a stable
		// marker still lets the fingerprint notice when this changes.
		return `unreadable:${err instanceof Error ? err.name : "error"}`;
	}
}

/**
 * Fingerprint of everything that can change the build output, or null when it
 * cannot be computed (no git, `root` is not itself the top of a git checkout,
 * no commit yet) — null means "always build", exactly like before.
 * `--show-prefix` is empty only when `root` is the repository top, which is
 * checked without comparing drive-letter spellings of two paths.
 */
export async function computeFingerprint(
	root: string,
	webEnv: Readonly<Record<string, string>>,
): Promise<string | null> {
	const revParse = await gitOutput(root, ["rev-parse", "--show-prefix", "HEAD"]);
	if (revParse === null) return null;
	const [prefix, head] = new TextDecoder().decode(revParse).split("\n");
	if (prefix !== "" || !head) return null;

	const diff = await gitOutput(root, ["diff", "HEAD", "--binary"]);
	const listing = await gitOutput(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
	if (diff === null || listing === null) return null;

	const paths = new TextDecoder().decode(listing).split("\0").filter((p) => p !== "");
	const untracked: Array<{ path: string; hash: string }> = [];
	const BATCH = 32;
	for (let i = 0; i < paths.length; i += BATCH) {
		const batch = paths.slice(i, i + BATCH);
		const hashes = await Promise.all(batch.map((p) => hashFile(join(root, p))));
		batch.forEach((path, j) => untracked.push({ path, hash: hashes[j] ?? "" }));
	}
	return assembleFingerprint({ head, diff, untracked, webEnv });
}

// ─── Port handling ────────────────────────────────────────────────────

/** True when the port can be bound on `host` right now (same call the server
 *  itself uses in its early-bind check, so the two agree). */
export function isPortFree(port: number, host: string = SERVER_HOST): boolean {
	try {
		const probe = Bun.serve({ port, hostname: host, fetch: () => new Response() });
		probe.stop(true);
		return true;
	} catch (err) {
		const code = typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined;
		if (code === "EADDRINUSE") return false;
		throw err;
	}
}

export async function waitForPortFree(
	port: number,
	host: string = SERVER_HOST,
	timeoutMs = 10_000,
	intervalMs = 250,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (isPortFree(port, host)) return true;
		if (Date.now() >= deadline) return false;
		await Bun.sleep(intervalMs);
	}
}

/** Who LISTENS on the port — ONE PowerShell call. `-State Listen` is the point:
 *  TIME_WAIT leftovers (owner PID 0) are not holders. UTF-8 output keeps
 *  non-ASCII paths in command lines intact; -EncodedCommand avoids quoting. */
export async function queryListeningHolders(port: number): Promise<PortHolder[]> {
	const script = [
		"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
		"$ErrorActionPreference = 'SilentlyContinue'",
		`$owners = @(Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -ExpandProperty OwningProcess -Unique)`,
		"$rows = @(foreach ($p in $owners) {",
		'  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p"',
		"  [pscustomobject]@{ pid = [int]$p; name = $proc.Name; commandLine = $proc.CommandLine }",
		"}) | Where-Object { $_ }",
		"ConvertTo-Json -InputObject @($rows) -Compress",
	].join("\n");
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	const proc = Bun.spawn(
		["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
		{ stdin: "ignore", stdout: "pipe", stderr: "ignore" },
	);
	const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return parseHolders(out);
}

async function ask(question: string): Promise<string | null> {
	// Without a console there is nobody to answer; the caller declines. This
	// also keeps an agent or a pipe from killing the owner's server by accident.
	if (!process.stdin.isTTY) return null;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return await rl.question(question);
	} finally {
		rl.close();
	}
}

/** Port busy → show who holds it and offer to stop it (owner ruling
 *  2026-09-19: the launcher offers to kill the stale holder instead of dying
 *  silently). Returns true when the port is free afterwards. */
async function resolveBusyPort(port: number): Promise<boolean> {
	console.log("");
	console.log(`Port ${port} is already in use.`);
	const holders = process.platform === "win32" ? await queryListeningHolders(port) : [];
	if (holders.length === 0) {
		console.log("Could not identify the program holding it. Close that program, or set VIBE_TAVERN_PORT to another port.");
		return false;
	}
	for (const holder of holders) {
		const prompt = holderPrompt(holder, port);
		console.log("");
		for (const line of prompt.details) console.log(line);
		const answer = await ask(prompt.question);
		if (answer === null || !isYes(answer, prompt.defaultYes)) {
			console.log("Cancelled.");
			return false;
		}
		try {
			process.kill(holder.pid);
		} catch (err) {
			console.log(`Could not stop PID ${holder.pid}: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}
	if (!(await waitForPortFree(port))) {
		console.log(`Port ${port} did not become free in time.`);
		return false;
	}
	console.log("Stopped.");
	return true;
}

// ─── Launch ───────────────────────────────────────────────────────────

async function runInherited(command: readonly string[], cwd: string, env: Record<string, string | undefined>): Promise<number> {
	const proc = Bun.spawn([...command], { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	return await proc.exited;
}

/** Forward a child stream to the console byte-for-byte and mirror it into the log. */
async function pump(
	stream: ReadableStream<Uint8Array>,
	target: NodeJS.WriteStream,
	log: { push(chunk: Uint8Array): void; flush(): void },
): Promise<void> {
	for await (const chunk of stream) {
		target.write(chunk);
		log.push(chunk);
	}
	log.flush();
}

export async function main(): Promise<number> {
	const root = resolve(import.meta.dir, "..");
	process.chdir(root);

	const port = resolvePort(process.env.VIBE_TAVERN_PORT);
	if (port === null) {
		console.error(`VIBE_TAVERN_PORT="${process.env.VIBE_TAVERN_PORT}" is not a valid port (1-65535).`);
		return 1;
	}

	// The frontend resolves its API base to window.location.origin at runtime
	// (apps/web/src/gateway-client.ts), so the prod server (frontend + API on
	// one origin) does NOT need VIBE_TAVERN_WEB_API_URL pinned. Leaving it
	// unset keeps the built out/ port-agnostic, so two instances on different
	// ports can share the same build output without one breaking the other's
	// API calls.
	const env: Record<string, string | undefined> = { ...process.env, VIBE_TAVERN_PORT: String(port) };

	// Optional sibling file ..\mcp\.env (relative to the repo root's parent):
	// supplies the default provider baked into the web build.
	const mcpEnvFile = Bun.file(resolve(root, "..", "mcp", ".env"));
	Object.assign(env, mcpWebDefaults((await mcpEnvFile.exists()) ? await mcpEnvFile.text() : null));

	console.log("============================================");
	console.log(" Vibe Tavern");
	console.log("============================================");
	console.log("");
	console.log(`Server: http://127.0.0.1:${port}`);
	if (env.LOG_LEVEL?.toLowerCase() === "debug") console.log("Log level: debug");
	console.log("");

	// Reconcile node_modules against bun.lock on every launch. `bun install`
	// is a no-op (~30ms) when already in sync and self-heals when a dep was
	// added/removed since the last launch - unlike the old sentinel check
	// (a fixed list of package directories), which silently missed newly
	// added packages.
	console.log("Checking dependencies against bun.lock...");
	if ((await runInherited([process.execPath, "install"], root, env)) !== 0) {
		console.log("");
		console.log("Failed to install dependencies.");
		return 1;
	}

	const webEnv: Record<string, string> = {};
	for (const key of WEB_DEFAULT_ENV_KEYS) webEnv[key] = env[key] ?? "";
	const fingerprint = await computeFingerprint(root, webEnv);
	const fingerprintPath = join(root, FINGERPRINT_FILE);
	const stored = (await Bun.file(fingerprintPath).exists()) ? (await Bun.file(fingerprintPath).text()).trim() : null;
	console.log("");
	if (fingerprint !== null && stored === fingerprint) {
		console.log("Build is up to date - skipping (delete the out folder to force a rebuild).");
	} else {
		console.log("Changes since the last build - building...");
		// Drop the old fingerprint first: a failed build leaves out/ half
		// written, and the old fingerprint must not vouch for it.
		await rm(fingerprintPath, { force: true });
		if ((await runInherited([process.execPath, "run", "build"], root, env)) !== 0) {
			console.log("");
			console.log("Build failed.");
			return 1;
		}
		if (fingerprint !== null) await Bun.write(fingerprintPath, `${fingerprint}\n`);
	}

	console.log("");
	console.log("Starting server...");
	console.log("Press Ctrl+C to stop.");
	console.log("");

	if (!isPortFree(port) && !(await resolveBusyPort(port))) return 1;

	mkdirSync(join(root, "logs"), { recursive: true });
	const logFile = join("logs", `server-${formatLogStamp(new Date())}.log`);
	console.log(`Logging to ${logFile}`);
	console.log("");
	const logFd = openSync(join(root, logFile), "a");
	const append = (text: string): void => appendFileSync(logFd, text, "utf8");

	// Keep the server's colors when the console can show them. The server's
	// logger adds none of its own; the colors come from Bun's console.log
	// object formatting, which turns on for a TTY or FORCE_COLOR. The child
	// writes to a pipe, so it would see no TTY - say so explicitly, unless the
	// owner's environment already decided (NO_COLOR / FORCE_COLOR).
	const serverEnv = { ...env };
	if (process.stdout.isTTY && serverEnv.NO_COLOR === undefined && serverEnv.FORCE_COLOR === undefined) {
		serverEnv.FORCE_COLOR = "1";
	}

	// Ctrl+C reaches every process on the console, this one included. The
	// default would kill the launcher before it can print the end message and
	// before the server finishes its graceful shutdown; swallow it and let the
	// child's exit end the run. A second Ctrl+C means the child is stuck.
	let child: ReturnType<typeof Bun.spawn> | null = null;
	let interrupts = 0;
	const onInterrupt = (): void => {
		interrupts += 1;
		if (interrupts > 1) child?.kill();
	};
	process.on("SIGINT", onInterrupt);

	child = Bun.spawn([process.execPath, "--no-env-file", "services/api/src/server/prod-server.ts"], {
		cwd: root,
		env: serverEnv,
		stdin: "inherit",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdoutLog = createLogChunkWriter(append);
	const stderrLog = createLogChunkWriter(append);
	await Promise.all([
		pump(child.stdout as ReadableStream<Uint8Array>, process.stdout, stdoutLog),
		pump(child.stderr as ReadableStream<Uint8Array>, process.stderr, stderrLog),
		child.exited,
	]);
	process.off("SIGINT", onInterrupt);
	closeSync(logFd);

	console.log("");
	console.log(describeExit(child.exitCode, child.signalCode));
	console.log(`Log saved to ${logFile}`);
	console.log("");
	return child.exitCode ?? 1;
}

if (import.meta.main) {
	process.exit(await main());
}
