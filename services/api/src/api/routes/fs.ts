import { Hono } from "hono";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";

/**
 * Native OS filesystem dialog routes.
 *
 * Currently a single endpoint: `POST /api/fs/native-dialog` opens the OS's
 * native folder picker and returns the selected path. Used by the SillyTavern
 * folder import flow (`StFolderImport`) to obtain a filesystem path without a
 * browser-side `webkitdirectory` picker — the backend then reads the folder
 * directly via `scanSillyTavernDirectory` / `importSillyTavernDirectory`.
 *
 * Platform coverage (decided with the user, 2026-07-05):
 *   - win32   → PowerShell `System.Windows.Forms.FolderBrowserDialog` (real).
 *   - darwin  → `osascript` `choose folder` (real).
 *   - other   → `{ available: false }` stub. The XDG-portal implementation for
 *               Linux is out of scope for this cycle (a separate contributor change —
 *               change — cannot be tested from a Windows machine; a blind
 *               implementation would violate the stale-assumption rule).
 *
 * No request body — the dialog IS the input. POST not GET because it triggers
 * the side effect of opening a modal OS dialog (and GET would be cached).
 *
 * ── Windows compiled-binary fix ──────────────────────────────────────────
 * Spawning `powershell.exe` directly from a Bun-compiled standalone binary
 * (the production deployment shape) FAILS to show the dialog: the compiled
 * binary runs without a GUI desktop station, the child PowerShell inherits
 * that non-interactive station, and `FolderBrowserDialog.ShowDialog()` hangs
 * indefinitely without ever painting. (Plain `bun` in dev works because the
 * dev process is attached to an interactive console.)
 *
 * The fix is to launch via `cmd /c start /WAIT` — `start` reparents the
 * PowerShell process to the explorer/interactive desktop station, so the
 * dialog becomes visible. Side effect: `start` detaches the child from the
 * parent's stdio, so we cannot read the selected path from the Bun spawn's
 * stdout pipe. Instead the PowerShell script writes the result to a temp
 * file, and we read it back after the child exits. Cancel is signalled by an
 * empty file (the script's `if`-branch only writes on OK).
 */

/** 5 minutes. The user may walk away from the picker; we don't want to hang. */
const NATIVE_DIALOG_TIMEOUT_MS = 5 * 60 * 1000;

type NativeDialogResult =
	| { path: string }
	| { cancelled: true }
	| { available: false }
	| { error: string };

interface DialogRunResult {
	/** The dialog's textual output: the selected path on success, or empty on cancel. */
	stdout: string;
	exitCode: number | null;
}

/**
 * Spawn a subprocess and race it against a hard timeout. On timeout, kill the
 * subprocess and resolve `"timeout"`. We use async `Bun.spawn` (not
 * `spawnSync`) deliberately: the dialog blocks on user interaction, which
 * would block the entire event loop under `spawnSync` — unacceptable for a
 * server that must keep serving other requests while the picker is open.
 */
function runDialogWithTimeout(cmd: string[], ms: number): Promise<DialogRunResult | "timeout"> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let proc: ReturnType<typeof Bun.spawn>;
		try {
			proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
		} catch (e) {
			// spawn itself failed synchronously (command missing, etc.) —
			// reject so the caller surfaces a real {error} rather than a
			// silent {cancelled}.
			reject(e instanceof Error ? e : new Error(String(e)));
			return;
		}

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			try {
				proc.kill();
			} catch {
				// already dead — nothing to kill.
			}
			resolve("timeout");
		}, ms);

		const stdoutStream = proc.stdout;
		const stdoutPromise = stdoutStream instanceof ReadableStream
			? new Response(stdoutStream).text()
			: Promise.resolve("");
		Promise.all([stdoutPromise, proc.exited])
			.then(([stdout, exitCode]) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve({ stdout, exitCode });
			})
			.catch((e) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(e instanceof Error ? e : new Error(String(e)));
			});
	});
}

// ── Platform commands ──────────────────────────────────────────────────────
// macOS: `osascript` exits non-zero on Cancel; the selected path (POSIX form,
// trailing newline trimmed) arrives on stdout.
const MACOS_CMD = (prompt: string) => [
	"osascript",
	"-e",
	`POSIX path of (choose folder with prompt "${prompt.replace(/"/g, "\\\"")}")`,
];

/**
 * Build the Windows command for a single native folder-picker invocation.
 *
 * See the file-level doc comment for why this routes through
 * `cmd /c start /WAIT` and a temp file instead of spawning PowerShell
 * directly: a Bun-compiled standalone binary has no interactive desktop
 * station, so a direct PowerShell child cannot paint FolderBrowserDialog.
 * `start` reparents PowerShell to the interactive desktop station; the
 * selected path is written to `outFile` (empty file = user cancelled).
 *
 * Returns the full argv to pass to `Bun.spawn`. The caller owns `outFile`'s
 * lifecycle (create empty before spawn, read+unlink after).
 */
function windowsCmd(outFile: string): string[] {
	const outFilePosix = outFile.replace(/\\/g, "/");
	const psScript =
		"Add-Type -AssemblyName System.Windows.Forms;"
		+ "[System.Windows.Forms.Application]::EnableVisualStyles();"
		+ "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
		+ "$d.Description = 'Select folder';"
		+ "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK)"
		+ `{ Set-Content -Path '${outFilePosix}' -Value $d.SelectedPath -NoNewline }`;
	return [
		"cmd", "/c", "start", "/WAIT", "",
		"powershell.exe", "-NoProfile", "-NoLogo", "-WindowStyle", "Hidden",
		"-Command", psScript,
	];
}

async function openNativeFolderDialog(platform: string = process.platform): Promise<NativeDialogResult> {
	if (platform !== "win32" && platform !== "darwin") {
		// Linux stub — out of scope this cycle (see file doc comment).
		return { available: false };
	}

	if (platform === "win32") {
		// Run via `cmd /c start /WAIT` + temp file (see windowsCmd doc comment).
		// The temp file carries the selected path because `start` detaches the
		// child from our stdout pipe — reading it back after exit is the only
		// way to recover the result. The empty-file sentinel = cancel.
		const outFile = join(tmpdir(), `vt-native-dialog-${crypto.randomUUID()}.txt`);
		try {
			await Bun.write(outFile, "");
		} catch (e) {
			return { error: e instanceof Error ? e.message : String(e) };
		}
		const cmd = windowsCmd(outFile);
		try {
			const run = await runDialogWithTimeout(cmd, NATIVE_DIALOG_TIMEOUT_MS);
			let fileContent = "";
			try {
				fileContent = await Bun.file(outFile).text();
			} catch {
				// reading the result file failed — treat as cancel; mapDialogResult
				// will surface {cancelled} which is the safest fallback.
			}
			return mapDialogResult(run, fileContent);
		} catch (e) {
			return { error: e instanceof Error ? e.message : String(e) };
		} finally {
			try { await unlink(outFile); } catch {
				// best-effort cleanup — temp file may already be gone.
			}
		}
	}

	// macOS: direct osascript; stdout carries the POSIX path.
	try {
		const run = await runDialogWithTimeout(MACOS_CMD("Select folder"), NATIVE_DIALOG_TIMEOUT_MS);
		return mapDialogResult(run);
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * Map a finished (or timed-out) dialog subprocess into the response union.
 * Pure — extracted so the cancel/success/timeout logic is testable without
 * spawning a real OS dialog.
 *
 * On Windows the result arrives via `fileContent` (the temp file written by
 * the PowerShell script — `start` detaches the child so stdout is empty); on
 * macOS it arrives via `run.stdout` (osascript writes the POSIX path).
 *
 * @param fileContent Windows only: contents of the temp result file. Empty
 *   means the user cancelled (the script writes only on OK).
 */
export function mapDialogResult(run: DialogRunResult | "timeout", fileContent?: string): NativeDialogResult {
	if (run === "timeout") {
		// Treat an idle picker the same as the user walking away — cancel.
		return { cancelled: true };
	}

	// Prefer the Windows temp-file result when provided (it's authoritative —
	// `start` detaches stdout). Fall back to stdout for macOS / direct spawns.
	const raw = fileContent !== undefined ? fileContent : run.stdout;
	const path = raw.trim();
	// Empty path: Windows script didn't write (Cancel), or macOS osascript
	// returned nothing. Non-zero exit: macOS Cancel signals it this way.
	if (!path || (run.exitCode !== null && run.exitCode !== 0)) {
		return { cancelled: true };
	}
	return { path };
}

export function createFsRoutes() {
	return new Hono().post("/api/fs/native-dialog", async (c) => {
		const result = await openNativeFolderDialog();
		return c.json(result);
	});
}
