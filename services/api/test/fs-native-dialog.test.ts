/**
 * Characterization tests for the native folder-dialog route
 * (ST_NATIVE_DIALOG_IMPORT_PLAN Wave 1, STN-1C).
 *
 * Two layers:
 *
 *  1. `mapDialogResult` — the PURE mapping from a finished subprocess's
 *     {stdout, exitCode} (or a "timeout" marker) onto the `NativeDialogResult`
 *     response union. All four branches pinned: success, cancel-via-empty,
 *     cancel-via-nonzero-exit, timeout.
 *
 *  2. `createFsRoutes` — the Hono route itself, invoked in-process via
 *     `app.request()`. The stub path (any platform that is not win32/darwin)
 *     is exercised by forcing `process.platform` to "linux"/"freebsd", so NO
 *     real OS dialog is ever spawned by this test suite. The actual Windows
 *     (PowerShell FolderBrowserDialog) and macOS (osascript) dialog invocations
 *     are blocking UI calls that require a human to click — they are verified
 *     manually per the plan's STN-1C self-check, not here.
 *
 * Written before any further refactor of fs.ts (AGENTS.md §1) so the pinned
 * behavior is the current contract: stdout is trimmed before the empty-check,
 * and non-zero exit is treated as cancellation even when stdout is non-empty
 * (defensive — osascript prints nothing useful on Cancel, but a half-written
 * stdout on non-zero exit is not a real selection).
 */
import { test, expect, describe, afterEach } from "bun:test";
import { mapDialogResult, createFsRoutes } from "../src/api/routes/fs.js";

describe("mapDialogResult", () => {
	test("success: non-empty stdout + zero exit → { path }", () => {
		const result = mapDialogResult({ stdout: "C:\\Users\\test\\cards\n", exitCode: 0 });
		expect(result).toEqual({ path: "C:\\Users\\test\\cards" });
	});

	test("success: macOS posix path is trimmed of trailing newline", () => {
		const result = mapDialogResult({ stdout: "/Users/test/cards\n", exitCode: 0 });
		expect(result).toEqual({ path: "/Users/test/cards" });
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

	test("cancel via non-zero exit (macOS osascript Cancel exits 1) → { cancelled: true }", () => {
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

describe("createFsRoutes — stub path integration", () => {
	const originalPlatform = process.platform;

	afterEach(() => {
		// Restore the real platform so the override never leaks out of this file
		// (mock.module is process-global — see AGENTS.md gotcha; property override
		// is scoped but must be restored explicitly).
		Object.defineProperty(process, "platform", {
			value: originalPlatform,
			configurable: true,
		});
	});

	test("Linux stub: returns { available: false } WITHOUT spawning any subprocess", async () => {
		// Force the stub branch so no real OS dialog is touched by this test.
		// On a Windows or macOS runner this would otherwise open a real picker
		// that blocks until a human clicks — untestable in CI.
		Object.defineProperty(process, "platform", {
			value: "linux",
			configurable: true,
		});

		const app = createFsRoutes();
		const res = await app.request("/api/fs/native-dialog", { method: "POST" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ available: false });
	});

	test("any non-win32/non-darwin platform hits the same stub (freebsd)", async () => {
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
