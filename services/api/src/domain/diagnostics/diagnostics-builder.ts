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
  const logLines = recentLogLines();
  const sizes = await measureDataSizes(input.dataDir);
  return [
    textEntry("vt-info.json", `${JSON.stringify(info, null, 2)}\n`),
    textEntry("server-log.txt", logLines.length > 0 ? `${logLines.join("\n")}\n` : ""),
    textEntry("provider-profiles.json", `${JSON.stringify(input.providerProfiles, null, 2)}\n`),
    textEntry("data-sizes.json", `${JSON.stringify(sizes, null, 2)}\n`),
  ];
}
