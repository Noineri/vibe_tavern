import type { FileStore, StorageFolder } from "./file-store.js";
import { hashCanonicalJson } from "./file-store.js";

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

	/**
	 * Read entity content from file. Try filename with ID first, then try any file starting with the ID.
	 * This handles both old format (id.json) and new format (id.slug.json).
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
	 */
	async writeEntity(folder: StorageFolder, entityId: string, data: unknown, opts?: WriteEntityOptions): Promise<string> {
		const path = this.resolvePath(folder, entityId, opts?.displayName);
		const hash = hashCanonicalJson(data);
		await this._fileStore.writeJson(path, data);
		this.cache.set(this.cacheKey(folder, entityId), { hash, data });
		return hash;
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

	/**
	 * Delete entity file from disk and evict from cache.
	 * Tries both filename formats.
	 */
	async deleteEntity(folder: StorageFolder, entityId: string): Promise<void> {
		// Try default path
		const path = this.resolvePath(folder, entityId);
		const file = Bun.file(path);
		if (await file.exists()) {
			await file.delete();
		}
		this.cache.delete(this.cacheKey(folder, entityId));
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
