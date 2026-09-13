/**
// hygiene:allow-abs-path-inputs — paths are mocked kdialog/powershell stdout strings, never loaded
 * Characterization tests for the native folder-dialog route
 * (ST_NATIVE_DIALOG_IMPORT_PLAN Wave 1, STN-1C; Linux support added later).
 *
 * Four layers:
 *
 *  1. `mapDialogResult` — the PURE mapping from a finished subprocess's
 *     {stdout, exitCode, signalCode} onto the `NativeDialogResult` response
 *     union. All branches pinned: success, cancel-via-empty,
 *     cancel-via-nonzero-exit, killed-by-deadline.
 *
 *  2. `runDialog` — the real spawn seam, exercised with stand-in "dialog"
 *     subprocesses (this runtime, `bun -e`) so the deadline, the cancel exit
 *     and the kill escalation are pinned without a human clicking a picker.
 *
 *  3. Linux helpers — `hasLinuxDisplay` (env-var check) and `linuxCmd` (argv
 *     construction for zenity/kdialog) are pure and tested directly.
 *
 *  4. `createFsRoutes` — the Hono route itself, invoked in-process via
 *     `app.request()`. The Linux no-display path and the unknown-platform path
 *     are exercised by forcing `process.platform` / env vars, so NO real OS
 *     dialog is ever spawned by this test suite. The actual Windows
 *     (PowerShell FolderBrowserDialog), macOS (osascript), and Linux
 *     (zenity/kdialog) dialog invocations are blocking UI calls that require a
 *     human to click — they are verified manually, not here.
 */
import { test, expect, describe, afterEach } from "bun:test";
import {
	mapDialogResult,
	runDialog,
	createFsRoutes,
	hasLinuxDisplay,
	linuxCmd,
	_resetLinuxDialogCacheForTests,
} from "../src/api/routes/fs.js";

/** A subprocess that exited normally: no signal, zero exit, `stdout` as given. */
function ok(stdout: string): { stdout: string; exitCode: number; signalCode: null } {
	return { stdout, exitCode: 0, signalCode: null };
}

describe("mapDialogResult", () => {
	test("success: non-empty stdout + zero exit → { path }", () => {
		const result = mapDialogResult(ok("C:\\Users\\test\\cards\n"));
		expect(result).toEqual({ path: "C:\\Users\\test\\cards" });
	});

	test("success: macOS posix path is trimmed of trailing newline", () => {
		const result = mapDialogResult(ok("/Users/test/cards\n"));
		expect(result).toEqual({ path: "/Users/test/cards" });
	});

	test("success: linux path from zenity/kdialog is trimmed", () => {
		const result = mapDialogResult(ok("/home/test/SillyTavern/data\n"));
		expect(result).toEqual({ path: "/home/test/SillyTavern/data" });
	});

	test("cancel via empty stdout (Windows): user dismissed → { cancelled: true }", () => {
		// PowerShell prints nothing when ShowDialog != OK.
		const result = mapDialogResult(ok(""));
		expect(result).toEqual({ cancelled: true });
	});

	test("cancel via whitespace-only stdout → { cancelled: true }", () => {
		// Defensive: .trim() runs before the empty check.
		const result = mapDialogResult(ok("   \n\t  "));
		expect(result).toEqual({ cancelled: true });
	});

	test("cancel via non-zero exit (macOS osascript / linux zenity Cancel exits 1) → { cancelled: true }", () => {
		const result = mapDialogResult({ stdout: "", exitCode: 1, signalCode: null });
		expect(result).toEqual({ cancelled: true });
	});

	test("non-zero exit with non-empty stdout still cancels (half-written output is not a selection)", () => {
		const result = mapDialogResult({ stdout: "/Users/test", exitCode: 1, signalCode: null });
		expect(result).toEqual({ cancelled: true });
	});

	test("null exitCode + empty stdout → { cancelled: true } (defensive: unknown exit treated as no-selection)", () => {
		const result = mapDialogResult({ stdout: "", exitCode: null, signalCode: null });
		expect(result).toEqual({ cancelled: true });
	});

	test("null exitCode + non-empty stdout → { path } (stdout is the source of truth when exit is unknown)", () => {
		const result = mapDialogResult({ stdout: "C:\\picked\n", exitCode: null, signalCode: null });
		expect(result).toEqual({ path: "C:\\picked" });
	});

	test("a signalled picker never yields a path, whatever exit code came with the signal", () => {
		// A picker killed mid-write still hands back what it had already
		// printed (Bun delivers the partial pipe contents). POSIX reports the
		// kill as 137, which the non-zero rule below would also cancel — the
		// second shape is the one only the signal check catches, and it is why
		// the check does not lean on the 128+signal convention.
		expect(
			mapDialogResult({ stdout: "/home/test/half-writ", exitCode: 137, signalCode: "SIGKILL" }),
		).toEqual({ cancelled: true });
		expect(
			mapDialogResult({ stdout: "/home/test/half-writ", exitCode: 0, signalCode: "SIGKILL" }),
		).toEqual({ cancelled: true });
	});
});

// These are integration pins against the platform clock on purpose: the
// deadline lives inside Bun.spawn (the runtime kills the child), so there is
// no timer in our code to fake. Waits are hundreds of milliseconds and the
// awaited signal is the child's own exit, not a guessed duration.
describe("runDialog — real subprocess deadline", () => {
	test("a dialog that prints a path and exits 0 maps to { path }", async () => {
		const run = await runDialog(
			[process.execPath, "-e", 'process.stdout.write("/home/test/picked")'],
			10_000,
		);
		expect(run).toEqual({ stdout: "/home/test/picked", exitCode: 0, signalCode: null });
		expect(mapDialogResult(run)).toEqual({ path: "/home/test/picked" });
	});

	test("a cancelled dialog (non-zero exit, no signal) is NOT reported as a timeout", async () => {
		// osascript/zenity/kdialog exit non-zero on Cancel. That must stay
		// distinguishable from a killed picker: same {cancelled} answer, but
		// only the kill path is allowed to discard stdout.
		const run = await runDialog([process.execPath, "-e", "process.exit(1)"], 10_000);
		expect(run.exitCode).toBe(1);
		expect(run.signalCode).toBeNull();
		expect(mapDialogResult(run)).toEqual({ cancelled: true });
	});

	test("an idle dialog is killed at the deadline and cancels, keeping its partial stdout out of the result", async () => {
		const started = Bun.nanoseconds();
		const run = await runDialog(
			[
				process.execPath,
				"-e",
				'process.stdout.write("/home/test/partial"); setTimeout(() => {}, 30_000)',
			],
			300,
		);
		const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
		expect(elapsedMs).toBeLessThan(5_000);
		expect(run.signalCode).not.toBeNull();
		// The partial write did arrive — this is exactly why mapDialogResult
		// checks the signal before trusting stdout.
		expect(run.stdout).toBe("/home/test/partial");
		expect(mapDialogResult(run)).toEqual({ cancelled: true });
	}, 15_000);

	test.skipIf(process.platform === "win32")(
		"a dialog that ignores SIGTERM is still killed at the deadline",
		async () => {
			// Bun sends killSignal once and never escalates, so a SIGTERM-only
			// deadline would hang here forever (measured: still alive 2.5s after
			// a 400ms timeout). runDialog asks for SIGKILL for this reason.
			const run = await runDialog(
				[
					process.execPath,
					"-e",
					'process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); setTimeout(() => {}, 30_000)',
				],
				400,
			);
			expect(run.signalCode).toBe("SIGKILL");
			expect(mapDialogResult(run)).toEqual({ cancelled: true });
		},
		15_000,
	);

	test("a missing dialog binary rejects (so the route answers {error}, not a silent cancel)", async () => {
		await expect(runDialog(["vt-definitely-not-a-real-dialog-binary"], 10_000)).rejects.toThrow();
	});
});

describe("hasLinuxDisplay", () => {
	const origDisplay = process.env.DISPLAY;
	const origWayland = process.env.WAYLAND_DISPLAY;

	afterEach(() => {
		if (origDisplay !== undefined) process.env.DISPLAY = origDisplay;
		else delete process.env.DISPLAY;
		if (origWayland !== undefined) process.env.WAYLAND_DISPLAY = origWayland;
		else delete process.env.WAYLAND_DISPLAY;
	});

	test("returns true when DISPLAY is set (X11)", () => {
		process.env.DISPLAY = ":0";
		delete process.env.WAYLAND_DISPLAY;
		expect(hasLinuxDisplay()).toBe(true);
	});

	test("returns true when WAYLAND_DISPLAY is set (Wayland)", () => {
		delete process.env.DISPLAY;
		process.env.WAYLAND_DISPLAY = "wayland-0";
		expect(hasLinuxDisplay()).toBe(true);
	});

	test("returns false when neither DISPLAY nor WAYLAND_DISPLAY is set (headless)", () => {
		delete process.env.DISPLAY;
		delete process.env.WAYLAND_DISPLAY;
		expect(hasLinuxDisplay()).toBe(false);
	});
});

describe("linuxCmd", () => {
	test("zenity: --file-selection --directory + --title=<prompt>", () => {
		expect(linuxCmd("zenity", "Select folder")).toEqual([
			"zenity", "--file-selection", "--directory", "--title=Select folder",
		]);
	});

	test("kdialog: --getexistingdirectory <HOME> <caption>", () => {
		const origHome = process.env.HOME;
		process.env.HOME = "/home/test";
		try {
			expect(linuxCmd("kdialog", "Select folder")).toEqual([
				"kdialog", "--getexistingdirectory", "/home/test", "Select folder",
			]);
		} finally {
			if (origHome !== undefined) process.env.HOME = origHome;
			else delete process.env.HOME;
		}
	});

	test("kdialog: falls back to / when HOME is unset", () => {
		const origHome = process.env.HOME;
		delete process.env.HOME;
		try {
			expect(linuxCmd("kdialog", "Pick dir")).toEqual([
				"kdialog", "--getexistingdirectory", "/", "Pick dir",
			]);
		} finally {
			if (origHome !== undefined) process.env.HOME = origHome;
			else delete process.env.HOME;
		}
	});
});

describe("createFsRoutes — Linux + unknown-platform integration", () => {
	const originalPlatform = process.platform;
	const origDisplay = process.env.DISPLAY;
	const origWayland = process.env.WAYLAND_DISPLAY;

	afterEach(() => {
		Object.defineProperty(process, "platform", {
			value: originalPlatform,
			configurable: true,
		});
		if (origDisplay !== undefined) process.env.DISPLAY = origDisplay;
		else delete process.env.DISPLAY;
		if (origWayland !== undefined) process.env.WAYLAND_DISPLAY = origWayland;
		else delete process.env.WAYLAND_DISPLAY;
		_resetLinuxDialogCacheForTests();
	});

	test("Linux without a graphical session → { available: false } (no subprocess spawned)", async () => {
		Object.defineProperty(process, "platform", {
			value: "linux",
			configurable: true,
		});
		delete process.env.DISPLAY;
		delete process.env.WAYLAND_DISPLAY;
		_resetLinuxDialogCacheForTests();

		const app = createFsRoutes();
		const res = await app.request("/api/fs/native-dialog", { method: "POST" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ available: false });
	});

	test("unknown platform (freebsd) → { available: false }", async () => {
		Object.defineProperty(process, "platform", {
			value: "freebsd",
			configurable: true,
		});

		const app = createFsRoutes();
		const res = await app.request("/api/fs/native-dialog", { method: "POST" });
		const body = await res.json();
		// Must round-trip through JSON with no undefined fields leaking.
		expect(JSON.parse(JSON.stringify(body))).toEqual({ available: false });
	});
});
