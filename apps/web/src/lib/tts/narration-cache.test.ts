import { describe, expect, test } from "bun:test";

import {
  buildNarrationCacheKey,
  createNarrationSegmentCache,
  type NarrationCacheSignature,
} from "./narration-cache.js";

function signature(overrides: Partial<NarrationCacheSignature> = {}): NarrationCacheSignature {
  return {
    backend: "openai-compatible",
    endpoint: "http://localhost:4123/v1",
    model: "chatterbox-tts-1",
    responseFormat: "wav",
    speed: null,
    voiceId: "Jordas",
    narrator: false,
    text: "Hello world.",
    ...overrides,
  };
}

describe("buildNarrationCacheKey", () => {
  test("stable for identical input", () => {
    expect(buildNarrationCacheKey(signature())).toBe(buildNarrationCacheKey(signature()));
  });

  test("text change misses", () => {
    expect(buildNarrationCacheKey(signature({ text: "Other." }))).not.toBe(buildNarrationCacheKey(signature()));
  });

  test("synthesis-relevant fields each miss: backend, endpoint, model, format, speed, voice, role", () => {
    const base = buildNarrationCacheKey(signature());
    const variants = [
      signature({ backend: "elevenlabs" }),
      signature({ endpoint: "http://localhost:9999/v1" }),
      signature({ model: "chatterbox-tts-2" }),
      signature({ responseFormat: "mp3" }),
      signature({ speed: 1.25 }),
      signature({ voiceId: "Other" }),
      signature({ narrator: true }),
    ];
    for (const variant of variants) {
      expect(buildNarrationCacheKey(variant)).not.toBe(base);
    }
  });

  test("no secret material in the key: apiKey is not even an input", () => {
    const keys = Object.keys(signature());
    expect(keys).not.toContain("apiKey");
    expect(keys).not.toContain("key");
  });
});

describe("createNarrationSegmentCache", () => {
  test("put/get round-trip; miss → null", async () => {
    const cache = createNarrationSegmentCache();
    expect(await cache.get("missing")).toBeNull();
    const blob = new Blob(["audio-bytes"], { type: "audio/wav" });
    await cache.put("k1", blob, "audio/wav");
    const hit = await cache.get("k1");
    expect(hit).not.toBeNull();
    expect(await hit!.text()).toBe("audio-bytes");
  });

  test("overwrite replaces the entry", async () => {
    const cache = createNarrationSegmentCache();
    await cache.put("k", new Blob(["old"]), "audio/wav");
    await cache.put("k", new Blob(["new"]), "audio/wav");
    expect(await (await cache.get("k"))!.text()).toBe("new");
  });

  test("memory fallback serves when IndexedDB is absent", async () => {
    const realIndexedDB = (globalThis as { indexedDB?: unknown }).indexedDB;
    (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
    try {
      const cache = createNarrationSegmentCache();
      await cache.put("m", new Blob(["mem"]), "audio/wav");
      expect(await (await cache.get("m"))!.text()).toBe("mem");
    } finally {
      (globalThis as { indexedDB?: unknown }).indexedDB = realIndexedDB as never;
    }
  });
});
