import {
  flyBrainManifestSchema,
  type FlyBrainManifest,
} from "@vibe-tavern/api-contracts";

/** Dedicated Cache API namespace for sha-addressed Fly Tribunal brain bytes. */
export const FLY_BRAIN_CACHE_NAME = "vibe-tavern-fly-brain-v1";
export const FLY_BRAIN_MANIFEST_URL = "/api/fly/brain/manifest";
export const FLY_BRAIN_URL = "/api/fly/brain";
/** Fixed cache key for the manifest that names the currently cached revision. */
export const FLY_BRAIN_MANIFEST_CACHE_KEY = "/api/fly/cache/manifest";

/** Small structural subset of Cache used by the loader (test-friendly DI). */
export interface FlyBrainCache {
  match(request: RequestInfo): Promise<Response | undefined>;
  put(request: RequestInfo, response: Response): Promise<void>;
}

/** Small structural subset of CacheStorage used by the loader (test-friendly DI). */
export interface FlyBrainCacheStorage {
  open(cacheName: string): Promise<FlyBrainCache>;
}

/** Fetch seam: tests inject a route-local fake rather than patching globals. */
export type FlyBrainFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface FlyBrainIdleState {
  status: "idle";
}

export interface FlyBrainDownloadingState {
  status: "downloading";
  receivedBytes: number;
  totalBytes: number | null;
  /** Integer 0..100. A length-less response reports 0 until complete. */
  progress: number;
}

export interface FlyBrainReadyState {
  status: "ready";
  source: "cache" | "network";
  manifest: FlyBrainManifest;
  /** Exact compressed bytes. FT-7 owns decompression. */
  bytes: Uint8Array;
}

export interface FlyBrainErrorState {
  status: "error";
  error: string;
}

/** Plain status machine consumed by Wave 4's React hook. */
export type FlyBrainLoadState = FlyBrainIdleState | FlyBrainDownloadingState | FlyBrainReadyState | FlyBrainErrorState;

export interface FlyBrainLoadOptions {
  fetch?: FlyBrainFetch;
  cacheStorage?: FlyBrainCacheStorage;
  onProgress?: (state: FlyBrainDownloadingState) => void;
}

/** Content-addressed Cache API key for one compressed brain revision. */
export function flyBrainCacheKey(sha256: string): string {
  return `/api/fly/cache/brain/${sha256}`;
}

/**
 * Boot path: use a cached manifest plus its matching sha-addressed bytes
 * without fetching anything. Missing/stale/corrupt cache state returns idle;
 * Cache API failures become a typed error state rather than an uncaught crash.
 */
export async function loadCachedFlyBrain(
  options: Pick<FlyBrainLoadOptions, "cacheStorage"> = {},
): Promise<FlyBrainLoadState> {
  try {
    const cache = await openFlyBrainCache(options.cacheStorage);
    return await readCachedFlyBrain(cache);
  } catch (error) {
    return asErrorState(error);
  }
}

/**
 * Update/download path: fetch the current manifest, compare it against the
 * cached manifest + bytes, and stream a new compressed artifact only when
 * that sha is absent or stale. The hash is verified before ANY Cache API put.
 */
export async function downloadFlyBrain(options: FlyBrainLoadOptions = {}): Promise<FlyBrainLoadState> {
  try {
    const cache = await openFlyBrainCache(options.cacheStorage);
    const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    const manifest = await fetchManifest(fetcher);
    const cached = await readCachedFlyBrain(cache, manifest.binary.sha256);
    if (cached.status === "ready") return cached;

    const brainResponse = await fetcher(FLY_BRAIN_URL);
    if (!brainResponse.ok) {
      throw new Error(`Fly brain download failed with HTTP ${brainResponse.status}.`);
    }
    const bytes = await readDownloadedBytes(brainResponse, options.onProgress);
    const actualSha256 = await sha256Hex(bytes);
    if (actualSha256 !== manifest.binary.sha256) {
      throw new Error("Fly brain sha256 mismatch; downloaded bytes were not cached.");
    }

    // Persist only hash-verified compressed bytes. The manifest goes in last,
    // so a partially failed cache write never advertises a new revision.
    await cache.put(flyBrainCacheKey(manifest.binary.sha256), new Response(exactArrayBuffer(bytes)));
    await cache.put(
      FLY_BRAIN_MANIFEST_CACHE_KEY,
      new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/json" } }),
    );
    return { status: "ready", source: "network", manifest, bytes };
  } catch (error) {
    return asErrorState(error);
  }
}

async function openFlyBrainCache(override?: FlyBrainCacheStorage): Promise<FlyBrainCache> {
  const cacheStorage = override ?? globalThis.caches;
  if (cacheStorage === undefined) throw new Error("Cache API is unavailable for Fly Tribunal brain storage.");
  return cacheStorage.open(FLY_BRAIN_CACHE_NAME);
}

async function fetchManifest(fetcher: FlyBrainFetch): Promise<FlyBrainManifest> {
  const response = await fetcher(FLY_BRAIN_MANIFEST_URL);
  if (!response.ok) {
    throw new Error(`Fly brain manifest request failed with HTTP ${response.status}.`);
  }
  return flyBrainManifestSchema.parse(await response.json());
}

async function readCachedFlyBrain(
  cache: FlyBrainCache,
  expectedSha256?: string,
): Promise<FlyBrainLoadState> {
  const cachedManifestResponse = await cache.match(FLY_BRAIN_MANIFEST_CACHE_KEY);
  if (cachedManifestResponse === undefined) return { status: "idle" };

  let manifest: FlyBrainManifest;
  try {
    manifest = flyBrainManifestSchema.parse(await cachedManifestResponse.json());
  } catch {
    // A malformed/obsolete cached manifest is stale, not a fatal browser error.
    return { status: "idle" };
  }
  if (expectedSha256 !== undefined && manifest.binary.sha256 !== expectedSha256) {
    return { status: "idle" };
  }

  const brainResponse = await cache.match(flyBrainCacheKey(manifest.binary.sha256));
  if (brainResponse === undefined) return { status: "idle" };
  const bytes = new Uint8Array(await brainResponse.arrayBuffer());
  if (await sha256Hex(bytes) !== manifest.binary.sha256) {
    // Do not serve corrupt bytes. The network-aware path will re-download;
    // the boot-only path remains safely idle.
    return { status: "idle" };
  }
  return { status: "ready", source: "cache", manifest, bytes };
}

async function readDownloadedBytes(
  response: Response,
  onProgress: ((state: FlyBrainDownloadingState) => void) | undefined,
): Promise<Uint8Array> {
  if (response.body === null) throw new Error("Fly brain download returned no body.");

  const header = response.headers.get("Content-Length");
  const parsedLength = header === null ? Number.NaN : Number(header);
  const totalBytes = Number.isInteger(parsedLength) && parsedLength > 0 ? parsedLength : null;
  let receivedBytes = 0;
  const chunks: Uint8Array[] = [];
  onProgress?.({ status: "downloading", receivedBytes, totalBytes, progress: 0 });

  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    chunks.push(value);
    receivedBytes += value.byteLength;
    onProgress?.({
      status: "downloading",
      receivedBytes,
      totalBytes,
      progress: totalBytes === null ? 0 : Math.min(100, Math.floor((receivedBytes / totalBytes) * 100)),
    });
  }

  if (totalBytes === null) {
    onProgress?.({ status: "downloading", receivedBytes, totalBytes, progress: 100 });
  }
  return joinBytes(chunks, receivedBytes);
}

function joinBytes(chunks: Uint8Array[], byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function asErrorState(error: unknown): FlyBrainErrorState {
  return {
    status: "error",
    error: error instanceof Error ? error.message : String(error),
  };
}
