/**
 * Characterization tests for the native folder-dialog route
 * (ST_NATIVE_DIALOG_IMPORT_PLAN Wave 1, STN-1C; Linux support added later).
 *
 * Three layers:
 *
 *  1. `mapDialogResult` — the PURE mapping from a finished subprocess's
 *     {stdout, exitCode} (or a "timeout" marker) onto the `NativeDialogResult`
 *     response union. All four branches pinned: success, cancel-via-empty,
 *     cancel-via-nonzero-exit, timeout.
 *
 *  2. Linux helpers — `hasLinuxDisplay` (env-var check) and `linuxCmd` (argv
 *     construction for zenity/kdialog) are pure and tested directly.
 *
 *  3. `createFsRoutes` — the Hono route itself, invoked in-process via
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
	createFsRoutes,
	hasLinuxDisplay,
	linuxCmd,
	_resetLinuxDialogCacheForTests,
} from "../src/api/routes/fs.js";

describe("mapDialogResult", () => {
	test("success: non-empty stdout + zero exit → { path }", () => {
		const result = mapDialogResult({ stdout: "C:\\Users\\test\\cards\n", exitCode: 0 });
		expect(result).toEqual({ path: "C:\\Users\\test\\cards" });
	});

	test("success: macOS posix path is trimmed of trailing newline", () => {
		const result = mapDialogResult({ stdout: "/Users/test/cards\n", exitCode: 0 });
		expect(result).toEqual({ path: "/Users/test/cards" });
	});

	test("success: linux path from zenity/kdialog is trimmed", () => {
		const result = mapDialogResult({ stdout: "/home/test/SillyTavern/data\n", exitCode: 0 });
		expect(result).toEqual({ path: "/home/test/SillyTavern/data" });
	});

	test("cancel via empty stdout (Windows): user dismissed → { cancelled: true }", () => {
		// PowerShell prints nothing when ShowDialog != OK.
		const result = mapDialogResult({ stdout: "", exitCode: 0 });
		expect(result).toEqual({ cancelled: true });
	});

	test("cancel via whitespace-only stdout → { cancelled: true }", () => {
		// Defensive: .trim() runs before the empty check.
		const result = mapDialogResult({ stdout: "   \n\t  ", exitCode: 0 });
		expect(result).toEqual({ cancelled: true });
	});

	test("cancel via non-zero exit (macOS osascript / linux zenity Cancel exits 1) → { cancelled: true }", () => {
		const result = mapDialogResult({ stdout: "", exitCode: 1 });
		expect(result).toEqual({ cancelled: true });
	});

	test("non-zero exit with non-empty stdout still cancels (half-written output is not a selection)", () => {
		const result = mapDialogResult({ stdout: "/Users/test", exitCode: 1 });
		expect(result).toEqual({ cancelled: true });
	});

	test("null exitCode + empty stdout → { cancelled: true } (defensive: unknown exit treated as no-selection)", () => {
		const result = mapDialogResult({ stdout: "", exitCode: null });
		expect(result).toEqual({ cancelled: true });
	});

	test("null exitCode + non-empty stdout → { path } (stdout is the source of truth when exit is unknown)", () => {
		const result = mapDialogResult({ stdout: "C:\\picked\n", exitCode: null });
		expect(result).toEqual({ path: "C:\\picked" });
	});

	test("timeout (idle picker killed) → { cancelled: true }", () => {
		const result = mapDialogResult("timeout");
		expect(result).toEqual({ cancelled: true });
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
