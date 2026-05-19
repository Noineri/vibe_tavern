import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";

/**
 * Configurable debug log writer.
 *
 * By default, logs to `cwd/logs/send-debug.log` (backward compat for dev mode).
 * Call `configureLogDir(logsDir)` at startup to override the log directory.
 * The standalone server calls this with the resolved OS-convention logs dir.
 */

let logDir: string | undefined;
let logPath: string = resolve(process.cwd(), "logs", "send-debug.log");
let dirEnsured = false;

export function configureLogDir(dir: string): void {
	logDir = dir;
	logPath = resolve(dir, "send-debug.log");
	dirEnsured = false;
}

export function logSendDebug(
	event: string,
	data: Record<string, unknown> = {},
): void {
	try {
		if (!dirEnsured) {
			void mkdir(dirname(logPath), { recursive: true });
			dirEnsured = true;
		}
		void (Bun.write as any)(logPath, `${new Date().toISOString()} ${event} ${JSON.stringify(data, redactSecrets)}\n`, { append: true });
	} catch {
	}
}

function redactSecrets(key: string, value: unknown): unknown {
	if (/api.?key|authorization|token|secret/i.test(key) && typeof value === "string") {
		return value ? "[redacted]" : value;
	}
	return value;
}
