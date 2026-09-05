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
const STORE_NAME = "segments";

interface CachedSegment {
  key: string;
  blob: Blob;
  mime: string;
  createdAt: number;
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
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: "key" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
      });
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
