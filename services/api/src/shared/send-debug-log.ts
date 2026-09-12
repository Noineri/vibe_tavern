import { resolve, dirname } from "node:path";
import { mkdir, appendFile } from "node:fs/promises";

/**
 * Configurable debug log writer.
 *
 * By default, logs to `cwd/logs/send-debug.log` (backward compat for dev mode).
 * Call `configureLogDir(logsDir)` at startup to override the log directory.
 * The standalone server calls this with the resolved OS-convention logs dir.
 */

let logDir: string | undefined;
let logPath: string = resolve(process.cwd(), "logs", "send-debug.log");
let dirEnsure: Promise<void> | null = null;

export function configureLogDir(dir: string): void {
	logDir = dir;
	logPath = resolve(dir, "send-debug.log");
	dirEnsure = null;
}

export function logSendDebug(
	event: string,
	data: Record<string, unknown> = {},
): void {
	try {
		if (dirEnsure === null) {
			// Fire-and-forget, but its RESULT is chained below: every append waits
			// for the directory to exist first. A cold or slow filesystem can no
			// longer lose the mkdir/append race and turn the ENOENT rejection into
			// an unhandled rejection billed to an unrelated test file or prod
			// process (2026-09-11 CI incident — TEST_SUITE_HYGIENE_REPORT TH-1).
			dirEnsure = mkdir(dirname(logPath), { recursive: true }).then(
				() => undefined,
				() => undefined,
			);
		}
		const line = `${new Date().toISOString()} ${event} ${JSON.stringify(data, redactSecrets)}\n`;
		void dirEnsure
			.then(() => appendFile(logPath, line))
			.catch(() => {
				/* Fire-and-forget debug logging must never throw into the request hot
				 * path, and a failed write must never surface as an unhandled
				 * rejection — bun bills those to whatever file is currently
				 * running and fails it anonymously. */
			});
	} catch {
		/* Sync safety net (e.g. JSON.stringify throwing on exotic input). */
	}
}

function redactSecrets(key: string, value: unknown): unknown {
	if (/api.?key|authorization|token|secret/i.test(key) && typeof value === "string") {
		return value ? "[redacted]" : value;
	}
	return value;
}
