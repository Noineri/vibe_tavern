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

/**
 * Minimal browser-global shape used only for level resolution, so `domain`
 * stays free of a DOM lib dependency. Accessed via `globalThis` because
 * `location` / `localStorage` are not typed under the package's ESNext lib.
 */
interface BrowserLogEnv {
  location?: { hash?: string };
  localStorage?: { getItem(key: string): string | null };
}

function resolveMinLevel(): LogLevel {
  // Backend (Bun): LOG_LEVEL env var.
  const env = (typeof process !== "undefined" && process?.env?.LOG_LEVEL?.toLowerCase()) as string | undefined;
  // Frontend (browser): debug diagnostics are hidden by default (info). Re-enable
  // without a rebuild via `#log=debug` in the URL (one-shot) or by setting
  // localStorage["vt:log-level"] once (persists across reloads). Mirrors the
  // backend LOG_LEVEL gate. localStorage can throw in private mode → guarded.
  let browser: string | undefined;
  try {
    const g = globalThis as unknown as BrowserLogEnv;
    const fromUrl = g.location?.hash?.match(/log=(\w+)/)?.[1]?.toLowerCase();
    const fromLs = g.localStorage?.getItem("vt:log-level")?.toLowerCase();
    browser = fromUrl ?? fromLs;
  } catch {
    browser = undefined;
  }
  const level = env ?? browser;
  if (level && level in LEVEL_ORDER) return level as LogLevel;
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
