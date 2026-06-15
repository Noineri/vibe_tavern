import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FileStore, StorageFolder } from "./file-store.js";
import { STORAGE_FOLDERS, hashCanonicalJson } from "./file-store.js";

export interface ContentStoreConfig {
	fileStore: FileStore;
}

/** Options for writeEntity — displayName makes the filename human-readable. */
export interface WriteEntityOptions {
	displayName?: string;
}

/**
 * Coordination layer between entity stores and file I/O.
 *
 * Handles file paths, hashing, in-memory caching, and lazy migration.
 * Not a Drizzle store — works purely through FileStore.
 *
 * File naming: `{entityId}.json` by default, or `{entityId}.{slug}.json` when displayName is provided.
 */
export class ContentStore {
	private readonly _fileStore: FileStore;
	private readonly cache = new Map<string, { hash: string; data: unknown }>();
	private readonly textCache = new Map<string, { hash: string; text: string }>();

	constructor(config: ContentStoreConfig) {
		this._fileStore = config.fileStore;
	}

	private cacheKey(folder: StorageFolder, entityId: string): string {
		return `${folder}/${entityId}`;
	}

	private resolvePath(folder: StorageFolder, entityId: string, displayName?: string): string {
		if (displayName) {
			const slug = displayName
				.replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]/g, '-')
				.replace(/-+/g, '-')
				.replace(/^-|-$/g, '');
			return this._fileStore.resolvePath(folder, `${entityId}.${slug}.json`);
		}
		return this._fileStore.resolvePath(folder, `${entityId}.json`);
	}

	private resolveTextPath(folder: StorageFolder, entityId: string, extension = "md"): string {
		const safeExtension = extension.replace(/[^a-zA-Z0-9]/g, "") || "md";
		return this._fileStore.resolvePath(folder, `${entityId}.${safeExtension}`);
	}

	/**
	 * Read entity content from file. Try filename with ID first, then try any file starting with the ID.
	 * This handles both old format (id.json) and new format (id.slug.json).
	 *
	 * Legacy flat-layout read; prefer readEntityFile for folder-resident entities.
	 */
	async readEntity<T>(folder: StorageFolder, entityId: string): Promise<T | null> {
		const key = this.cacheKey(folder, entityId);
		const cached = this.cache.get(key);
		if (cached) return cached.data as T;

		const path = this.resolvePath(folder, entityId);
		try {
			const data = await this._fileStore.readJson<T>(path);
			const hash = hashCanonicalJson(data);
			this.cache.set(key, { hash, data });
			return data;
		} catch {
			return null;
		}
	}

	/**
	 * Write entity content to file with atomic tmp→rename.
	 * Updates cache. Returns the content hash.
	 *
	 * Legacy flat-layout write (data/{folder}/{id}(.{slug}).json). Prefer
	 * writeEntityFile for new folder-resident entities.
	 */
	async writeEntity(folder: StorageFolder, entityId: string, data: unknown, opts?: WriteEntityOptions): Promise<string> {
		const path = this.resolvePath(folder, entityId, opts?.displayName);
		const hash = hashCanonicalJson(data);
		await this._fileStore.writeJson(path, data);
		this.cache.set(this.cacheKey(folder, entityId), { hash, data });
		return hash;
	}

	/** Read UTF-8 text content from a file-backed entity such as summaries/*.md. */
	async readText(folder: StorageFolder, entityId: string, extension = "md"): Promise<string | null> {
		const key = `${this.cacheKey(folder, entityId)}.${extension}`;
		const cached = this.textCache.get(key);
		if (cached) return cached.text;

		const path = this.resolveTextPath(folder, entityId, extension);
		try {
			const text = await this._fileStore.readText(path);
			this.textCache.set(key, { hash: this.hashText(text), text });
			return text;
		} catch {
			return null;
		}
	}

	/** Write UTF-8 text content to a file-backed entity such as summaries/*.md. */
	async writeText(folder: StorageFolder, entityId: string, text: string, extension = "md"): Promise<string> {
		const key = `${this.cacheKey(folder, entityId)}.${extension}`;
		const path = this.resolveTextPath(folder, entityId, extension);
		const storedText = text.endsWith("\n") ? text : `${text}\n`;
		const hash = this.hashText(storedText);
		await this._fileStore.writeText(path, storedText);
		this.textCache.set(key, { hash, text: storedText });
		return hash;
	}

	/** Delete UTF-8 text content for a file-backed entity such as summaries/*.md. */
	async deleteText(folder: StorageFolder, entityId: string, extension = "md"): Promise<void> {
		const key = `${this.cacheKey(folder, entityId)}.${extension}`;
		const path = this.resolveTextPath(folder, entityId, extension);
		await this._fileStore.deleteFile(path);
		this.textCache.delete(key);
	}

	/**
	 * Check if entity file exists on disk.
	 */
	async exists(folder: StorageFolder, entityId: string): Promise<boolean> {
		const key = this.cacheKey(folder, entityId);
		if (this.cache.has(key)) return true;

		const path = this.resolvePath(folder, entityId);
		try {
			await this._fileStore.readJson(path);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Compute canonical JSON hash for arbitrary data.
	 */
	hashContent(data: unknown): string {
		return hashCanonicalJson(data);
	}

	hashText(text: string): string {
		return new Bun.CryptoHasher("sha256").update(new TextEncoder().encode(text)).digest("hex");
	}

	/**
	 * Delete entity file from disk and evict from cache.
	 * Tries both filename formats.
	 *
	 * Legacy flat-layout delete; prefer deleteEntityFolder for folder-resident
	 * entities (which also removes original.json, avatar.*, and gallery/).
	 */
	async deleteEntity(folder: StorageFolder, entityId: string): Promise<void> {
		// Try default path
		const path = this.resolvePath(folder, entityId);
		const file = Bun.file(path);
		if (await file.exists()) {
			await file.delete();
		}
		this.cache.delete(this.cacheKey(folder, entityId));
		for (const key of this.textCache.keys()) {
			if (key.startsWith(`${this.cacheKey(folder, entityId)}.`)) this.textCache.delete(key);
		}
	}

	// ─── Folder-aware primitives ───────────────────────────────────────────
	// Each entity lives in data/{folder}/{entityId}/ with named files inside
	// (card.json, persona.json, original.json, avatar.{ext}, gallery/, ...).
	// New code should prefer these over the flat writeEntity/readEntity/
	// deleteEntity above, which remain only to read/serve legacy flat files
	// during migration.

	private resolveLeafPath(folder: StorageFolder, entityId: string, leafName: string): string {
		return this._fileStore.resolvePath(folder, `${entityId}/${leafName}`);
	}

	/**
	 * Write a named entity file inside its folder:
	 * data/{folder}/{entityId}/{name}.json. Atomic (tmp→rename). Returns hash.
	 */
	async writeEntityFile(folder: StorageFolder, entityId: string, name: string, data: unknown): Promise<string> {
		const path = this.resolveLeafPath(folder, entityId, `${name}.json`);
		const hash = hashCanonicalJson(data);
		await this._fileStore.writeJson(path, data);
		this.cache.set(`${this.cacheKey(folder, entityId)}/${name}`, { hash, data });
		return hash;
	}

	/** Read a named entity file: data/{folder}/{entityId}/{name}.json. Null if missing. */
	async readEntityFile<T>(folder: StorageFolder, entityId: string, name: string): Promise<T | null> {
		const key = `${this.cacheKey(folder, entityId)}/${name}`;
		const cached = this.cache.get(key);
		if (cached) return cached.data as T;
		const path = this.resolveLeafPath(folder, entityId, `${name}.json`);
		try {
			const data = await this._fileStore.readJson<T>(path);
			const hash = hashCanonicalJson(data);
			this.cache.set(key, { hash, data });
			return data;
		} catch {
			return null;
		}
	}

	/**
	 * Write a binary file inside an entity folder (avatar, gallery image, ...).
	 * `leafName` includes the extension, e.g. "avatar.png". Returns the path.
	 */
	async writeBinary(folder: StorageFolder, entityId: string, leafName: string, data: Uint8Array): Promise<string> {
		const path = this.resolveLeafPath(folder, entityId, leafName);
		await this._fileStore.writeBinary(path, data);
		return path;
	}

	/** Read a binary file inside an entity folder. Null if missing. `leafName` includes the ext. */
	async readBinary(folder: StorageFolder, entityId: string, leafName: string): Promise<Buffer | null> {
		const path = this.resolveLeafPath(folder, entityId, leafName);
		if (!(await this._fileStore.pathExists(path))) return null;
		return this._fileStore.readBinary(path);
	}

	/**
	 * Delete the entire entity folder data/{folder}/{entityId}/ and everything
	 * under it (card.json, original.json, avatar.*, gallery/). Evicts all cache
	 * entries for this entity (flat key + nested-name keys). No-op if the folder
	 * is missing. Legacy flat files at data/{folder}/{entityId}.json are a
	 * separate path and are intentionally left in place (copy-forward policy).
	 */
	async deleteEntityFolder(folder: StorageFolder, entityId: string): Promise<void> {
		const dirPath = this._fileStore.resolvePath(folder, entityId);
		await this._fileStore.removeDir(dirPath);
		const prefix = this.cacheKey(folder, entityId);
		this.cache.delete(prefix);
		for (const key of [...this.cache.keys()]) {
			if (key.startsWith(`${prefix}/`)) this.cache.delete(key);
		}
		for (const key of [...this.textCache.keys()]) {
			if (key === prefix || key.startsWith(`${prefix}.`) || key.startsWith(`${prefix}/`)) {
				this.textCache.delete(key);
			}
		}
	}

	/** True if the entity folder data/{folder}/{entityId}/ exists on disk. */
	async entityFolderExists(folder: StorageFolder, entityId: string): Promise<boolean> {
		const dirPath = this._fileStore.resolvePath(folder, entityId);
		return this._fileStore.pathExists(dirPath);
	}

	// ─── Legacy flat-file migration helpers ───────────────────────────────
	// Pre-folder-layout entities live as flat data/{folder}/{id}(.{slug}).json.
	// These helpers find and copy them into the folder layout WITHOUT deleting
	// the source (copy-forward policy — single-user data-safety invariant).

	/**
	 * Find the legacy flat file for an entity, if any. Tries `{id}.json` first,
	 * then any `{id}.{slug}.json`. Returns the absolute path or null. Never
	 * matches the entity *folder* (`{id}/`) or unrelated ids sharing a prefix.
	 */
	async findLegacyFlatFile(folder: StorageFolder, entityId: string): Promise<string | null> {
		const dir = join(this._fileStore.dataRoot, folder);
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			return null;
		}
		// Prefer the exact `{id}.json` then fall back to `{id}.{slug}.json`.
		const exact = `${entityId}.json`;
		let fallback: string | null = null;
		for (const name of entries) {
			if (name === exact) return join(dir, name);
			if (name.endsWith(".json") && name.startsWith(`${entityId}.`)) {
				// startsWith(`${id}.`) excludes the folder `{id}` (no dot) and ids
				// that merely share a prefix (e.g. `char_1` vs `char_10`).
				fallback ??= join(dir, name);
			}
		}
		return fallback;
	}

	/**
	 * Copy-forward migration of a single entity from flat file to folder.
	 * Reads the legacy flat file → writes `{entityId}/{targetName}.json` →
	 * **does NOT delete the source**. Returns `true` if a migration happened,
	 * `false` if the folder already has the target file or there is no legacy
	 * source to migrate from. Idempotent and safe to retry.
	 */
	async migrateFlatToFolder(folder: StorageFolder, entityId: string, targetName: string): Promise<boolean> {
		// Already in folder — nothing to do.
		const existing = await this.readEntityFile(folder, entityId, targetName);
		if (existing !== null) return false;

		const legacyPath = await this.findLegacyFlatFile(folder, entityId);
		if (legacyPath === null) return false;

		const data = await this._fileStore.readJson<unknown>(legacyPath);
		await this.writeEntityFile(folder, entityId, targetName, data);
		// Intentionally do NOT delete legacyPath — copy-forward policy.
		return true;
	}

	/**
	 * Copy a flat asset from data/assets/{assetId}.{ext} into an entity folder
	 * at data/{folder}/{entityId}/{leafBaseName}.{ext}. Probes the candidate
	 * extensions in order and copies the first one found. Copy-forward: the
	 * flat source is NOT deleted (single-user data-safety invariant).
	 *
	 * This is the lazy-migration path for legacy flat avatars: the caller
	 * passes the stored `avatarAssetId` and gets back the discovered ext to
	 * persist in `avatarExt`. Returns null if no candidate file exists on disk
	 * (caller leaves `avatarAssetId` as-is — the avatar 404s, same as today) or
	 * if `assetId` is not a single safe filename. Idempotent and safe to retry.
	 */
	async copyAssetToEntityFolder(
		assetId: string,
		folder: StorageFolder,
		entityId: string,
		leafBaseName: string,
		candidateExts: readonly string[],
	): Promise<string | null> {
		// assetId must be a single filename segment — asset ids are always
		// `asset_<hex>`. Reject anything that could traverse or nest.
		if (!assetId || assetId.includes("/") || assetId.includes("\\") || assetId.includes("..")) {
			return null;
		}
		for (const ext of candidateExts) {
			const safeExt = ext.replace(/[^a-zA-Z0-9]/g, "");
			if (!safeExt) continue;
			try {
				const srcPath = this._fileStore.resolvePath(STORAGE_FOLDERS.assets, `${assetId}.${safeExt}`);
				if (!(await this._fileStore.pathExists(srcPath))) continue;
				const buf = await this._fileStore.readBinary(srcPath);
				if (buf.byteLength === 0) continue;
				await this.writeBinary(folder, entityId, `${leafBaseName}.${safeExt}`, new Uint8Array(buf));
				return safeExt;
			} catch {
				// try next extension
			}
		}
		return null;
	}

	/**
	 * Read entity file. If it doesn't exist, call factory to generate it,
	 * write the result to disk, and cache it.
	 *
	 * This is the lazy migration mechanism — factory is called ONLY
	 * when the file doesn't exist on disk.
	 */
	async readOrMigrate<T>(
		folder: StorageFolder,
		entityId: string,
		factory: () => Promise<{ data: T; hash: string }>,
		opts?: WriteEntityOptions,
	): Promise<T> {
		const key = this.cacheKey(folder, entityId);

		// Check cache first
		const cached = this.cache.get(key);
		if (cached) return cached.data as T;

		// Check file on disk
		const existing = await this.readEntity<T>(folder, entityId);
		if (existing !== null) return existing;

		// Lazy migration: generate from SQLite via factory
		const { data, hash } = await factory();
		const path = this.resolvePath(folder, entityId, opts?.displayName);
		await this._fileStore.writeJson(path, data);
		this.cache.set(key, { hash, data });
		return data;
	}

	/** Expose underlying FileStore for path resolution and raw I/O. */
	get fileStore(): FileStore {
		return this._fileStore;
	}
}
