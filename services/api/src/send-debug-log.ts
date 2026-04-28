import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const LOG_PATH = resolve(process.cwd(), "logs/send-debug.log");

export function logSendDebug(event: string, data: Record<string, unknown> = {}): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(
      LOG_PATH,
      `${new Date().toISOString()} ${event} ${JSON.stringify(data, redactSecrets)}\n`,
      "utf8",
    );
  } catch {
    // Debug logging must never break chat flow.
  }
}

function redactSecrets(key: string, value: unknown): unknown {
  if (/api.?key|authorization|token|secret/i.test(key)) {
    return value ? "[redacted]" : value;
  }
  return value;
}
