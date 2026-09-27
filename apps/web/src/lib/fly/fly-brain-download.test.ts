import { describe, expect, test } from "bun:test";
import type { FlyBrainManifest } from "@vibe-tavern/api-contracts";
import {
  downloadFlyBrain,
  FLY_BRAIN_MANIFEST_CACHE_KEY,
  FLY_BRAIN_MANIFEST_URL,
  FLY_BRAIN_URL,
  flyBrainCacheKey,
  loadCachedFlyBrain,
  type FlyBrainCache,
  type FlyBrainCacheStorage,
  type FlyBrainFetch,
} from "./fly-brain-download.js";

/**
 * Fly brain download/cache contract (FLY_TRIBUNAL_PLAN FT-6).
 *
 * L1 checklist:
 * 1. Paths: cache keys are module exports; no filesystem paths.
 * 2. Restores: fetch/cache enter through per-test DI, no globals patched.
 * 3. Determinism: in-memory streams and completed load results; no waits.
 * 4. Platform: Web API fakes only, no OS paths or file order.
 * 5. Shared worker pool: no module mocks or mutable global registries.
 * 6. Stable state: assertions inspect terminal loader states/cache entries.
 */

class MemoryCache implements FlyBrainCache {
  readonly entries = new Map<string, Response>();

  async match(request: RequestInfo): Promise<Response | undefined> {
    return this.entries.get(cacheKey(request))?.clone();
  }

  async put(request: RequestInfo, response: Response): Promise<void> {
    this.entries.set(cacheKey(request), response.clone());
  }
}

class MemoryCacheStorage implements FlyBrainCacheStorage {
  readonly cache = new MemoryCache();
  readonly openedNames: string[] = [];

  async open(cacheName: string): Promise<FlyBrainCache> {
    this.openedNames.push(cacheName);
    return this.cache;
  }
}

function cacheKey(request: RequestInfo): string {
  return typeof request === "string" ? request : request.url;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function manifestFor(sha256: string, sizeBytes: number): FlyBrainManifest {
  return {
    format: "fly-brain-manifest/1",
    generatedAt: "2026-09-27T00:00:00.000Z",
    generator: "test",
    source: {
      dataset: "mcns",
      version: "1.0",
      access: "test",
      license: "CC-BY-4.0",
      attribution: "test",
    },
    binary: {
      file: "connectome.bin.gz",
      formatVersion: 1,
      sha256,
      sizeBytes,
      neuronCount: 1,
      edgeCount: 1,
    },
    weights: {
      unit: "test",
      aggregation: "test",
      excitatory: [],
      inhibitory: [],
      unknownDefaultsTo: "test",
    },
    groups: [],
    countsByGroup: {},
    types: [],
  };
}

function chunkedResponse(bytes: Uint8Array): Response {
  const midpoint = Math.floor(bytes.byteLength / 2);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, midpoint));
      controller.enqueue(bytes.slice(midpoint));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Length": String(bytes.byteLength) },
  });
}

function makeFetch(manifest: FlyBrainManifest, bytes: Uint8Array): {
  fetch: FlyBrainFetch;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (input) => {
      const url = requestUrl(input);
      calls.push(url);
      if (url === FLY_BRAIN_MANIFEST_URL) {
        return new Response(JSON.stringify(manifest), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === FLY_BRAIN_URL) return chunkedResponse(bytes);
      throw new Error(`Unexpected fetch: ${url}`);
    },
  };
}

describe("Fly brain download/cache", () => {
  test("streams byte progress, verifies sha, and persists under the sha key", async () => {
    const bytes = textBytes("brain");
    const manifest = manifestFor(await sha256(bytes), bytes.byteLength);
    const network = makeFetch(manifest, bytes);
    const cacheStorage = new MemoryCacheStorage();
    const progress: number[] = [];

    const result = await downloadFlyBrain({
      fetch: network.fetch,
      cacheStorage,
      onProgress: (state) => progress.push(state.progress),
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready brain");
    expect(result.source).toBe("network");
    expect(Array.from(result.bytes)).toEqual(Array.from(bytes));
    expect(progress).toEqual([0, 40, 100]);
    expect(cacheStorage.cache.entries.has(flyBrainCacheKey(manifest.binary.sha256))).toBe(true);
    expect(cacheStorage.cache.entries.has(FLY_BRAIN_MANIFEST_CACHE_KEY)).toBe(true);
  });

  test("sha mismatch returns an error and persists neither bytes nor manifest", async () => {
    const bytes = textBytes("brain");
    const manifest = manifestFor("0".repeat(64), bytes.byteLength);
    const network = makeFetch(manifest, bytes);
    const cacheStorage = new MemoryCacheStorage();

    const result = await downloadFlyBrain({ fetch: network.fetch, cacheStorage });

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected sha mismatch error");
    expect(result.error).toContain("sha256 mismatch");
    expect(cacheStorage.cache.entries.size).toBe(0);
  });

  test("boot path returns matching cached bytes without invoking fetch", async () => {
    const bytes = textBytes("brain");
    const manifest = manifestFor(await sha256(bytes), bytes.byteLength);
    const cacheStorage = new MemoryCacheStorage();
    const network = makeFetch(manifest, bytes);
    const downloaded = await downloadFlyBrain({ fetch: network.fetch, cacheStorage });
    expect(downloaded.status).toBe("ready");

    const booted = await loadCachedFlyBrain({ cacheStorage });

    expect(booted.status).toBe("ready");
    if (booted.status !== "ready") throw new Error("expected cached brain");
    expect(booted.source).toBe("cache");
    expect(Array.from(booted.bytes)).toEqual(Array.from(bytes));
    // `loadCachedFlyBrain` has no fetch dependency: boot performed zero network calls.
    expect(network.calls).toEqual([FLY_BRAIN_MANIFEST_URL, FLY_BRAIN_URL]);
  });

  test("a Cache API failure resolves to a typed error state", async () => {
    const bytes = textBytes("brain");
    const manifest = manifestFor(await sha256(bytes), bytes.byteLength);
    const network = makeFetch(manifest, bytes);
    const unavailableCache: FlyBrainCacheStorage = {
      async open(): Promise<FlyBrainCache> {
        throw new Error("Cache API denied");
      },
    };

    const result = await downloadFlyBrain({ fetch: network.fetch, cacheStorage: unavailableCache });

    expect(result).toEqual({ status: "error", error: "Cache API denied" });
  });
});
