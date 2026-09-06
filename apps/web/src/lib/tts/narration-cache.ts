/**
 * TPE-16: segment-level narration audio cache.
 *
 * One narration = N synthesized segments; without a cache every replay
 * re-generates all of them (owner's chatterbox console: request #8 fully
 * re-generated #6's identical chunks). The cache keys each segment by the
 * synthesis-relevant signature (backend + endpoint + model + format + speed
 * + voice + segment text) — text/voice/profile edits naturally miss, so no
 * explicit invalidation exists. Writes happen after every successful
 * synthesize; reads feed the playback queue directly (resume = synthesize
 * only the missing segments).
 *
 * Storage: IndexedDB (blobs survive reloads), in-memory Map fallback when
 * IDB is unavailable (private mode, tests) or permanently fails. The cache
 * is BEST-EFFORT: get/put never throw — narration must never fail because
 * the cache did. No eviction in v1 (owner decision: local-first,
 * user-managed storage; see the unit's report for size implications).
 *
 * TPE-18a: the same file also hosts the per-chat playlist INDEX
 * (chat→message→narrated rows, DB v2) — the pointer layer over this
 * content-hash-keyed segment cache.
 */

export interface NarrationCacheSignature {
  backend: string;
  endpoint: string | null;
  model: string | null;
  responseFormat: string | null;
  speed: number | null;
  voiceId: string;
  /** Segment's role run (narrator vs character); flows into the split, but
   *  pinned explicitly so key intent stays readable. */
  narrator: boolean;
  text: string;
}

export interface NarrationSegmentCache {
  get(key: string): Promise<Blob | null>;
  put(key: string, blob: Blob, mime: string): Promise<void>;
  /** Drop one entry — used when a cached blob fails playback (undecodable
   *  audio would otherwise poison every retry forever, since v1 has no
   *  eviction). Best-effort, never throws. */
  delete(key: string): Promise<void>;
}

const CACHE_VERSION = "v1";

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Stable key for one synthesized segment. Deliberately NOT profileId: a
 *  profile edit that changes synthesis-relevant fields must miss. Secrets
 *  never enter the key material (no apiKey — the wire contract forbids it
 *  from leaving the server anyway). */
export function buildNarrationCacheKey(input: NarrationCacheSignature): string {
  const canonical = [
    input.backend,
    input.endpoint ?? "",
    input.model ?? "",
    input.responseFormat ?? "",
    input.speed === null ? "" : String(input.speed),
    input.voiceId,
    input.narrator ? "narrator" : "voice",
    input.text,
  ].join("");
  return `${CACHE_VERSION}:${fnv1aHex(canonical)}`;
}

const DB_NAME = "vibe-tavern-narration-cache";
const DB_VERSION = 2;
const STORE_NAME = "segments";
/** TPE-18a: per-chat playlist index store (added in DB v2; v1 DBs upgrade
 *  by creating the missing store — the segments store is untouched). */
const INDEX_STORE_NAME = "playlist-index";

interface CachedSegment {
  key: string;
  blob: Blob;
  mime: string;
  createdAt: number;
}

/**
 * TPE-18a: per-chat playlist index — one row per chat, pointing at the
 * messageIds that were narrated (or are being narrated). The SEGMENT cache
 * above stays content-hash keyed; the index is the messageId pointer, so a
 * variant switch naturally misses (hash mismatch → re-synthesis) and the
 * row is re-upserted on the next successful narrate. Best-effort like the
 * segment cache: every method never throws.
 */
export interface NarrationPlaylistEntry {
  messageId: string;
  variantId: string;
  variantIndex: number;
  /** First two lines of the voiced variant text (owner decision). */
  snippet: string;
  /** Segment cache keys that back this narration (replay = cache hits). */
  cacheKeys: string[];
  narratedAt: number;
  /** TPE-18c: a saved library file exists for this exact variant
   *  (library-first playback + badge). Absent on pre-18c rows —
   *  loadPlaylist reconciles it against the server, so old rows heal. */
  inLibrary?: boolean;
}

export interface NarrationPlaylistIndex {
  list(chatId: string): Promise<NarrationPlaylistEntry[]>;
  upsert(chatId: string, entry: NarrationPlaylistEntry): Promise<void>;
  clear(chatId: string): Promise<void>;
}

interface StoredPlaylistIndex {
  key: string;
  items: Record<string, NarrationPlaylistEntry>;
  updatedAt: number;
}

function openNarrationDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(INDEX_STORE_NAME)) {
        db.createObjectStore(INDEX_STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

class IndexedDbNarrationPlaylistIndex implements NarrationPlaylistIndex {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openNarrationDb();
    return this.dbPromise;
  }

  async list(chatId: string): Promise<NarrationPlaylistEntry[]> {
    try {
      const db = await this.db();
      const record = await requestToPromise<StoredPlaylistIndex | undefined>(
        db.transaction(INDEX_STORE_NAME, "readonly").objectStore(INDEX_STORE_NAME).get(chatId),
      );
      if (!record || typeof record.items !== "object" || record.items === null) return [];
      return Object.values(record.items).sort((a, b) => a.narratedAt - b.narratedAt);
    } catch {
      // Best-effort index: a storage failure reads as an empty playlist.
      return [];
    }
  }

  async upsert(chatId: string, entry: NarrationPlaylistEntry): Promise<void> {
    try {
      const db = await this.db();
      const store = db.transaction(INDEX_STORE_NAME, "readwrite").objectStore(INDEX_STORE_NAME);
      const record = await requestToPromise<StoredPlaylistIndex | undefined>(store.get(chatId));
      const items = record && typeof record.items === "object" && record.items !== null ? record.items : {};
      items[entry.messageId] = entry;
      await requestToPromise(store.put({ key: chatId, items, updatedAt: Date.now() }));
    } catch {
      // Best-effort index: a failed write never fails the narration.
    }
  }

  async clear(chatId: string): Promise<void> {
    try {
      const db = await this.db();
      await requestToPromise(
        db.transaction(INDEX_STORE_NAME, "readwrite").objectStore(INDEX_STORE_NAME).delete(chatId),
      );
    } catch {
      // Best-effort index: a storage failure must not fail the narration.
    }
  }
}

class MemoryNarrationPlaylistIndex implements NarrationPlaylistIndex {
  private readonly chats = new Map<string, Map<string, NarrationPlaylistEntry>>();

  async list(chatId: string): Promise<NarrationPlaylistEntry[]> {
    const items = this.chats.get(chatId);
    if (!items) return [];
    return [...items.values()].sort((a, b) => a.narratedAt - b.narratedAt);
  }

  async upsert(chatId: string, entry: NarrationPlaylistEntry): Promise<void> {
    let items = this.chats.get(chatId);
    if (!items) {
      items = new Map();
      this.chats.set(chatId, items);
    }
    items.set(entry.messageId, entry);
  }

  async clear(chatId: string): Promise<void> {
    this.chats.delete(chatId);
  }
}

/** Preferred index with a permanent in-memory fallback — same contract as
 *  the segment cache: the first IDB failure retires the IDB leg for this
 *  instance (private mode, quota, missing API). */
export function createNarrationPlaylistIndex(): NarrationPlaylistIndex {
  let primary: NarrationPlaylistIndex | null =
    typeof indexedDB !== "undefined" && typeof indexedDB.open === "function"
      ? new IndexedDbNarrationPlaylistIndex()
      : null;
  const memory = new MemoryNarrationPlaylistIndex();
  return {
    async list(chatId: string): Promise<NarrationPlaylistEntry[]> {
      if (primary !== null) {
        try {
          return await primary.list(chatId);
        } catch {
          primary = null;
        }
      }
      return memory.list(chatId);
    },
    async upsert(chatId: string, entry: NarrationPlaylistEntry): Promise<void> {
      if (primary !== null) {
        try {
          await primary.upsert(chatId, entry);
          return;
        } catch {
          primary = null;
        }
      }
      await memory.upsert(chatId, entry);
    },
    async clear(chatId: string): Promise<void> {
      if (primary !== null) {
        try {
          await primary.clear(chatId);
          return;
        } catch {
          primary = null;
        }
      }
      await memory.clear(chatId);
    },
  };
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

class IndexedDbNarrationSegmentCache implements NarrationSegmentCache {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      // TPE-18a: shared opener (DB v2 carries the playlist-index store;
      // opening v1 against a v2 database would throw a VersionError).
      this.dbPromise = openNarrationDb();
    }
    return this.dbPromise;
  }

  async get(key: string): Promise<Blob | null> {
    try {
      const db = await this.db();
      const record = await requestToPromise<CachedSegment | undefined>(
        db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key),
      );
      return record?.blob instanceof Blob ? record.blob : null;
    } catch {
      // Best-effort cache: a storage failure is a miss, never a narration error.
      return null;
    }
  }

  async put(key: string, blob: Blob, mime: string): Promise<void> {
    try {
      const db = await this.db();
      await requestToPromise(
        db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put({ key, blob, mime, createdAt: Date.now() }),
      );
    } catch {
      // Best-effort cache: a storage failure must not fail the narration.
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const db = await this.db();
      await requestToPromise(
        db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(key),
      );
    } catch {
      // Best-effort cache: a storage failure must not fail the narration.
    }
  }
}

class MemoryNarrationSegmentCache implements NarrationSegmentCache {
  private readonly blobs = new Map<string, Blob>();

  async get(key: string): Promise<Blob | null> {
    return this.blobs.get(key) ?? null;
  }

  async put(key: string, blob: Blob, _mime: string): Promise<void> {
    this.blobs.set(key, blob);
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}

/** Preferred store with a permanent in-memory fallback: the first IDB
 *  failure retires the IDB leg for this instance (private mode, quota,
 *  missing API) — later calls serve the memory leg. */
export function createNarrationSegmentCache(): NarrationSegmentCache {
  let primary: NarrationSegmentCache | null =
    typeof indexedDB !== "undefined" && typeof indexedDB.open === "function"
      ? new IndexedDbNarrationSegmentCache()
      : null;
  const memory = new MemoryNarrationSegmentCache();
  return {
    async get(key: string): Promise<Blob | null> {
      if (primary !== null) {
        try {
          return await primary.get(key);
        } catch {
          primary = null;
        }
      }
      return memory.get(key);
    },
    async put(key: string, blob: Blob, mime: string): Promise<void> {
      if (primary !== null) {
        try {
          await primary.put(key, blob, mime);
          return;
        } catch {
          primary = null;
        }
      }
      await memory.put(key, blob, mime);
    },
    async delete(key: string): Promise<void> {
      if (primary !== null) {
        try {
          await primary.delete(key);
          return;
        } catch {
          primary = null;
        }
      }
      await memory.delete(key);
    },
  };
}
