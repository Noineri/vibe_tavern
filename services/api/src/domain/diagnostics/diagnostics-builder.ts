import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { readSchemaVersion, type AppDb } from "@vibe-tavern/db";
import { recentLogLines } from "@vibe-tavern/domain";

/**
 * SM-7 diagnostics — the technical-only bundle «Собрать диагностику» builds.
 *
 * Owner ruling (2026-10-06, «Техническое, без контента»): the zip may carry
 * VT version, platform/OS, DB schema version, recent server log lines,
 * provider profiles as type + base URL (NEVER keys), and data sizes. Never
 * chats, characters, prompts, or `data/logs/send-debug.log` (send events may
 * carry message content). The entry list below is the contract the route test
 * pins exactly; adding an entry is an owner conversation, not a refactor.
 */

/** The ONLY provider-profile fields diagnostics may touch — no names, no keys. */
export interface DiagnosticsProviderProfile {
  providerPreset: string;
  endpoint: string;
  isActive: boolean;
}

export interface DiagnosticsInput {
  dataDir: string;
  db: AppDb;
  version: string;
  installKind: string;
  canSelfUpdate: boolean;
  platform: string;
  arch: string;
  osRelease: string;
  providerProfiles: readonly DiagnosticsProviderProfile[];
}

export interface DiagnosticsEntry {
  path: string;
  bytes: number;
  content: Uint8Array;
}

function textEntry(path: string, text: string): DiagnosticsEntry {
  const content = new TextEncoder().encode(text);
  return { path, bytes: content.byteLength, content };
}

/** Cap for a redacted endpoint — a path long enough to carry a payload is not
 * an address anymore (some aggregators put encoded data into the path). */
const MAX_ENDPOINT_LENGTH = 200;

/**
 * The one place a provider endpoint is made safe for the diagnostics bundle
 * (defect 2026-11-04: `user:password@host` and `?api_key=…` shipped verbatim).
 * Keeps scheme://host:port/path — the address a supporter needs — and drops
 * everything a URL can hide secrets in: userinfo, the whole query string (key
 * params have no naming convention worth trusting a filter with) and the
 * fragment. Unparseable/empty endpoints degrade to explicit placeholders.
 */
export function redactEndpointForDiagnostics(raw: string): string {
  if (raw.trim() === "") return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "[invalid-url]";
  }
  const address = `${url.protocol}//${url.host}${url.pathname}`;
  return address.length > MAX_ENDPOINT_LENGTH ? `${address.slice(0, MAX_ENDPOINT_LENGTH)}…` : address;
}

/**
 * Ring lines are "{ISO} {LEVEL}{[tag]} {message}" — keep ONLY the header and
 * drop the message body (defect 2026-11-04: character-description fragments
 * reached server-log.txt through ordinary warnings; the message part of a log
 * line can carry ANY content and no redactor can tell prose from prose). The
 * zip keeps the technical timeline — when, at what level, in which subsystem —
 * while the readable log stays on disk in data/logs for the user to attach
 * manually if they choose.
 */
function logHeader(line: string): string {
  return line.replace(/^(\S+ \w+(?:\[[^\]]*\])?)(?: .*)?$/, "$1");
}

/** Total bytes under `dir` (top-level breakdown), following directories and
 * regular files only — symlinks are neither read nor followed. */
export async function measureDataSizes(dataDir: string): Promise<{ totalBytes: number; entries: Record<string, number> }> {
  const entries: Record<string, number> = {};
  const dirBytes = async (dir: string): Promise<number> => {
    let total = 0;
    let children: Dirent[] = [];
    try {
      children = await readdir(dir, { withFileTypes: true });
    } catch {
      return 0; // unreadable subtree: contribute nothing rather than fail the report
    }
    for (const child of children) {
      if (child.isSymbolicLink()) continue;
      const childPath = join(dir, child.name);
      if (child.isDirectory()) total += await dirBytes(childPath);
      else if (child.isFile()) {
        try {
          total += (await stat(childPath)).size;
        } catch {
          // vanished mid-walk — skip
        }
      }
    }
    return total;
  };
  let totalBytes = 0;
  for (const child of await readdir(dataDir, { withFileTypes: true }).catch(() => [])) {
    if (child.isSymbolicLink()) continue;
    const childPath = join(dataDir, child.name);
    const bytes = child.isDirectory() ? await dirBytes(childPath) : child.isFile() ? await stat(childPath).then((s) => s.size).catch(() => 0) : 0;
    entries[child.name] = bytes;
    totalBytes += bytes;
  }
  return { totalBytes, entries };
}

/** Build the diagnostics entries — the exact zip content, uncompressed. */
export async function buildDiagnosticsEntries(input: DiagnosticsInput): Promise<DiagnosticsEntry[]> {
  const info = {
    version: input.version,
    installKind: input.installKind,
    canSelfUpdate: input.canSelfUpdate,
    platform: { platform: input.platform, arch: input.arch, release: input.osRelease },
    dbSchemaVersion: readSchemaVersion(input.db),
    generatedAt: new Date().toISOString(),
  };
  const logLines = recentLogLines()
    .map(logHeader)
    .filter((header) => header !== "");
  const sizes = await measureDataSizes(input.dataDir);
  return [
    textEntry("vt-info.json", `${JSON.stringify(info, null, 2)}\n`),
    textEntry("server-log.txt", logLines.length > 0 ? `${logLines.join("\n")}\n` : ""),
    textEntry("provider-profiles.json", `${JSON.stringify(input.providerProfiles.map((profile) => ({ ...profile, endpoint: redactEndpointForDiagnostics(profile.endpoint) })), null, 2)}\n`),
    textEntry("data-sizes.json", `${JSON.stringify(sizes, null, 2)}\n`),
  ];
}
