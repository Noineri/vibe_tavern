/**
 * Lightweight structured logger for Vibe Tavern.
 *
 * Uses Bun-native console methods under the hood but adds:
 *   - Level filtering (LOG_LEVEL env var: "debug" | "info" | "warn" | "error")
 *   - Tagged prefixes for subsystem identification
 *   - Printf-style formatting (via Bun's console)
 *
 * Usage:
 *   import { log } from "@vibe-tavern/domain";
 *   const logger = log.tag("lore");
 *   logger.debug("Pass: %d entries", count);    // hidden unless LOG_LEVEL=debug
 *   logger.info("Migration done: %d rows", n);  // always visible
 *   logger.warn("Something odd: %s", msg);
 *   logger.error("Failed:", err);
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function resolveMinLevel(): LogLevel {
  const env = (typeof process !== "undefined" && process?.env?.LOG_LEVEL?.toLowerCase()) as string | undefined;
  if (env && env in LEVEL_ORDER) return env as LogLevel;
  return "info";
}

const MIN_LEVEL = LEVEL_ORDER[resolveMinLevel()];

export class Logger {
  private prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix ? `[${prefix}]` : "";
  }

  /** Derive a child logger with a sub-tag. */
  child(sub: string): Logger {
    return new Logger(this.prefix ? `${this.prefix.slice(1, -1)}:${sub}` : sub);
  }

  debug(fmt: string, ...args: unknown[]): void {
    if (MIN_LEVEL > LEVEL_ORDER.debug) return;
    console.debug(this.fmt(fmt), ...args);
  }

  info(fmt: string, ...args: unknown[]): void {
    if (MIN_LEVEL > LEVEL_ORDER.info) return;
    console.log(this.fmt(fmt), ...args);
  }

  warn(fmt: string, ...args: unknown[]): void {
    if (MIN_LEVEL > LEVEL_ORDER.warn) return;
    console.warn(this.fmt(fmt), ...args);
  }

  error(fmt: string, ...args: unknown[]): void {
    // errors always shown
    console.error(this.fmt(fmt), ...args);
  }

  private fmt(msg: string): string {
    return this.prefix ? `${this.prefix} ${msg}` : msg;
  }
}

/** Create a tagged logger bound to a subsystem (e.g. "lore", "db", "stream"). */
export function tag(prefix: string): Logger {
  return new Logger(prefix);
}

/** Root logger — no prefix, for server startup and general messages. */
export const root = new Logger("");

/** Exported as `log` for convenience: import { log } from "@vibe-tavern/domain" */
export const log = { tag, root };
