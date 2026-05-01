import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

export const STORAGE_FOLDERS = {
  characters: "characters",
  personas: "personas",
  promptPresets: "promptPresets",
  lorebooks: "lorebooks",
  chatMirrors: "chatMirrors",
  assets: "assets",
  traces: "traces",
} as const;

export type StorageFolder = (typeof STORAGE_FOLDERS)[keyof typeof STORAGE_FOLDERS];

export interface FileStore {
  readonly dataRoot: string;
  resolvePath(folder: StorageFolder, relativePath: string): string;
  readJson<T = unknown>(absolutePath: string): T;
  writeJson(absolutePath: string, data: unknown): void;
  asyncWriteJson(absolutePath: string, data: unknown): Promise<void>;
}

function sortObjectKeys(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = obj[k];
    }
    return sorted;
  }
  return value;
}

function safeResolve(root: string, folder: StorageFolder, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error("Absolute paths are not allowed");
  }
  if (/^[a-zA-Z]:/.test(relativePath)) {
    throw new Error("Drive-letter paths are not allowed");
  }

  const parts = relativePath.split(/[/\\]/);
  for (const part of parts) {
    if (part === "" || part === ".") {
      throw new Error("Empty or dot segments are not allowed");
    }
    if (part === "..") {
      throw new Error("Path traversal not allowed");
    }
  }

  const target = resolve(root, folder, relativePath);
  const normalizedRoot = resolve(root);
  if (!target.startsWith(normalizedRoot + sep) && target !== normalizedRoot) {
    throw new Error("Resolved path escapes data root");
  }

  return target;
}

export function createFileStore(dataRoot?: string): FileStore {
  const root = resolve(dataRoot ?? join(process.cwd(), "data"));
  const writeLocks = new Map<string, Promise<void>>();
  return {
    dataRoot: root,
    resolvePath(folder, relativePath) {
      return safeResolve(root, folder, relativePath);
    },
    readJson<T = unknown>(absolutePath: string): T {
      return JSON.parse(readFileSync(absolutePath, "utf-8")) as T;
    },
    writeJson(absolutePath: string, data: unknown): void {
      const dir = resolve(absolutePath, "..");
      mkdirSync(dir, { recursive: true });
      const tmpPath = join(dir, `.tmp-${Date.now()}-${randomUUID().slice(0, 8)}`);
      writeFileSync(tmpPath, canonicalJsonBytes(data));
      renameSync(tmpPath, absolutePath);
    },
    async asyncWriteJson(absolutePath: string, data: unknown): Promise<void> {
      const previous = writeLocks.get(absolutePath) ?? Promise.resolve();
      const next = previous.then(async () => {
        const dir = resolve(absolutePath, "..");
        await mkdir(dir, { recursive: true });
        const tmpPath = join(dir, `.tmp-${Date.now()}-${randomUUID().slice(0, 8)}`);
        await writeFile(tmpPath, canonicalJsonBytes(data));
        await rename(tmpPath, absolutePath);
      }).finally(() => {
        writeLocks.delete(absolutePath);
      });
      writeLocks.set(absolutePath, next);
      await next;
    },
  };
}

export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(value, sortObjectKeys) + "\n";
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJsonString(value), "utf-8");
}

export function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
}
