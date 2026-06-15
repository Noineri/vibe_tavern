import { access, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

export const STORAGE_FOLDERS = {
	characters: "characters",
	personas: "personas",
	promptPresets: "promptPresets",
	lorebooks: "lorebooks",
	scripts: "scripts",
	chatMirrors: "chatMirrors",
	assets: "assets",
	traces: "traces",
	summaries: "summaries",
} as const;

export type StorageFolder =
	(typeof STORAGE_FOLDERS)[keyof typeof STORAGE_FOLDERS];

/**
 * Image extensions probed when locating a flat asset file on disk
 * (data/assets/{assetId}.{ext}). Asset ids never encode the ext, so the ext is
 * discovered by probe at migration time. Ordered by commonality.
 */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"] as const;

export interface FileStore {
	readonly dataRoot: string;
	resolvePath(folder: StorageFolder, relativePath: string): string;
	readJson<T = unknown>(absolutePath: string): Promise<T>;
	writeJson(absolutePath: string, data: unknown): Promise<void>;
	asyncWriteJson(absolutePath: string, data: unknown): Promise<void>;
	readText(absolutePath: string): Promise<string>;
	writeText(absolutePath: string, text: string): Promise<void>;
	deleteFile(absolutePath: string): Promise<void>;
	/** Write raw bytes atomically (tmp→rename). */
	writeBinary(absolutePath: string, data: Uint8Array): Promise<void>;
	/** Read raw bytes as a Buffer. Throws if the path is missing — check pathExists first. */
	readBinary(absolutePath: string): Promise<Buffer>;
	/** Recursively remove a directory (or a file). No-op if the path is missing. */
	removeDir(absolutePath: string): Promise<void>;
	/** True if a file or directory exists at the path. */
	pathExists(absolutePath: string): Promise<boolean>;
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

function safeResolve(
	root: string,
	folder: StorageFolder,
	relativePath: string,
): string {
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

async function writeLocked(
	writeLocks: Map<string, Promise<void>>,
	absolutePath: string,
	data: string | Uint8Array,
): Promise<void> {
	const previous = writeLocks.get(absolutePath) ?? Promise.resolve();
	const next = previous
		.then(async () => {
			const dir = resolve(absolutePath, "..");
			const tmpPath = join(
				dir,
				`.tmp-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
			);
			await Bun.write(tmpPath, data);
			await rename(tmpPath, absolutePath);
		})
		.finally(() => {
			writeLocks.delete(absolutePath);
		});
	writeLocks.set(absolutePath, next);
	await next;
}

export function createFileStore(dataRoot?: string): FileStore {
	const root = resolve(dataRoot ?? join(process.cwd(), "data"));
	const writeLocks = new Map<string, Promise<void>>();
	return {
		dataRoot: root,
		resolvePath(folder, relativePath) {
			return safeResolve(root, folder, relativePath);
		},
		readJson<T = unknown>(absolutePath: string): Promise<T> {
			return Bun.file(absolutePath).json() as Promise<T>;
		},
		writeJson(absolutePath: string, data: unknown): Promise<void> {
			return writeLocked(writeLocks, absolutePath, canonicalJsonBytes(data));
		},
		asyncWriteJson(absolutePath: string, data: unknown): Promise<void> {
			return writeLocked(writeLocks, absolutePath, canonicalJsonBytes(data));
		},
		readText(absolutePath: string): Promise<string> {
			return Bun.file(absolutePath).text();
		},
		writeText(absolutePath: string, text: string): Promise<void> {
			return writeLocked(writeLocks, absolutePath, text);
		},
		async deleteFile(absolutePath: string): Promise<void> {
			const file = Bun.file(absolutePath);
			if (await file.exists()) await file.delete();
		},
		writeBinary(absolutePath: string, data: Uint8Array): Promise<void> {
			return writeLocked(writeLocks, absolutePath, data);
		},
		async readBinary(absolutePath: string): Promise<Buffer> {
			return Buffer.from(await Bun.file(absolutePath).arrayBuffer());
		},
		async removeDir(absolutePath: string): Promise<void> {
			// force:true makes removal a no-op when the path is missing.
			await rm(absolutePath, { recursive: true, force: true });
		},
		pathExists(absolutePath: string): Promise<boolean> {
			// access() resolves both files and directories; its "missing" failure
			// is the expected negative result, not a swallowed real error.
			return access(absolutePath)
				.then(() => true)
				.catch(() => false);
		},
	};
}

export function canonicalJsonString(value: unknown): string {
	return JSON.stringify(value, sortObjectKeys) + "\n";
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJsonString(value));
}

export function hashCanonicalJson(value: unknown): string {
  return new Bun.CryptoHasher("sha256").update(canonicalJsonBytes(value)).digest("hex");
}
