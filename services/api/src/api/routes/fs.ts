import { Hono } from "hono";

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
 *               Linux is out of scope for this cycle (contributor Ваня, separate
 *               change — cannot be tested from a Windows machine; a blind
 *               implementation would violate the stale-assumption rule).
 *
 * No request body — the dialog IS the input. POST not GET because it triggers
 * the side effect of opening a modal OS dialog (and GET would be cached).
 */

/** 5 minutes. The user may walk away from the picker; we don't want to hang. */
const NATIVE_DIALOG_TIMEOUT_MS = 5 * 60 * 1000;

type NativeDialogResult =
	| { path: string }
	| { cancelled: true }
	| { available: false }
	| { error: string };

interface DialogRunResult {
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
// Each returns the selected absolute path on stdout (trimmed), or empty stdout
// to signal cancellation. Non-zero exit also signals cancellation (macOS
// osascript exits non-zero when the user presses Cancel).

const WINDOWS_CMD = [
	"powershell",
	"-WindowStyle", "Hidden",
	"-NonInteractive",
	"-Command",
	// STA is Windows PowerShell's default; FolderBrowserDialog requires it.
	// EnableVisualStyles + a throwaway Form owner keep the dialog foreground.
	"Add-Type -AssemblyName System.Windows.Forms;"
		+ "[System.Windows.Forms.Application]::EnableVisualStyles();"
		+ "$owner = New-Object System.Windows.Forms.Form;"
		+ "$owner.TopMost = $true;"
		+ "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
		+ "$d.Description = 'Select folder';"
		+ "if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK)"
		+ " { Write-Output $d.SelectedPath }",
];

const MACOS_CMD = (prompt: string) => [
	"osascript",
	"-e",
	`POSIX path of (choose folder with prompt "${prompt.replace(/"/g, '\\"')}")`,
];

async function openNativeFolderDialog(platform: string = process.platform): Promise<NativeDialogResult> {
	if (platform !== "win32" && platform !== "darwin") {
		// Linux stub — out of scope this cycle (see file doc comment).
		return { available: false };
	}

	const cmd = platform === "win32" ? WINDOWS_CMD : MACOS_CMD("Select folder");
	try {
		const run = await runDialogWithTimeout(cmd, NATIVE_DIALOG_TIMEOUT_MS);
		return mapDialogResult(run);
	} catch (e) {
		// spawn failure, stdout read failure, etc. — surface as a real error
		// rather than collapsing into {cancelled} (which would hide that
		// PowerShell/osascript is missing or broken on this machine).
		return { error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * Map a finished (or timed-out) dialog subprocess into the response union.
 * Pure — extracted so the cancel/success/timeout logic is testable without
 * spawning a real OS dialog.
 */
export function mapDialogResult(run: DialogRunResult | "timeout"): NativeDialogResult {
	if (run === "timeout") {
		// Treat an idle picker the same as the user walking away — cancel.
		return { cancelled: true };
	}

	const path = run.stdout.trim();
	// Empty stdout (Windows: dialog cancelled → no Write-Output) or non-zero
	// exit (macOS: osascript exits 1 on Cancel) both mean the user dismissed.
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
