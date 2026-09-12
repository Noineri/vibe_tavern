import { describe, expect, mock, test } from "bun:test";

import {
  NARRATION_OGG_WASM_URL,
  encodeNarrationSegmentsToOgg,
} from "./narration-ogg.js";
import type { DecodedNarrationAudio, NarrationOggEncoder } from "./narration-ogg.js";

/** Stub decoder: each blob decodes to one mono segment whose samples are
 *  the blob's raw bytes (order-pinned), at a fixed rate. */
function stubDecoder(rate = 24000): (blob: Blob) => Promise<DecodedNarrationAudio> {
  return async (blob) => ({
    sampleRate: rate,
    channels: [Float32Array.from(new Uint8Array(await blob.arrayBuffer()))],
  });
}

/** Stub encoder: encode() emits E<n> per call, finalize() emits Z — the
 *  merge order is byte-pinned by the test. */
function stubEncoder(calls: string[]): NarrationOggEncoder {
  let n = 0;
  return {
    configure: () => {},
    encode: () => {
      const tag = `E${n}`;
      n += 1;
      calls.push(tag);
      return new TextEncoder().encode(tag);
    },
    finalize: () => {
      calls.push("Z");
      return new TextEncoder().encode("Z");
    },
  };
}

function blobOf(values: number[]): Blob {
  return new Blob([new Uint8Array(values)], { type: "audio/wav" });
}

describe("narration OGG merge (TPE-18c)", () => {
  test("the wasm URL is a static public asset (never a bundled chunk)", () => {
    expect(NARRATION_OGG_WASM_URL.startsWith("/narration-ogg.wasm")).toBe(true);
    expect(NARRATION_OGG_WASM_URL).not.toMatch(/assets\/index-/);
  });

  test("two segment blobs merge into ONE byte stream in order: E0 E1 Z", async () => {
    const calls: string[] = [];
    const decode = stubDecoder();
    const seen: Blob[] = [];
    const result = await encodeNarrationSegmentsToOgg([blobOf([1, 2]), blobOf([3])], {
      decodeAudio: async (blob) => {
        seen.push(blob);
        return decode(blob);
      },
      loadEncoder: async () => stubEncoder(calls),
    });
    expect(calls).toEqual(["E0", "E1", "Z"]);
    expect(seen.length).toBe(2);
    expect(new TextDecoder().decode(result.bytes)).toBe("E0E1Z");
    expect(result).toMatchObject({ sampleRate: 24000, channels: 1, blobCount: 2, durationSec: 3 / 24000 });
  });

  test("empty input throws (never an empty library file)", async () => {
    await expect(encodeNarrationSegmentsToOgg([], { loadEncoder: async () => stubEncoder([]) })).rejects.toThrow(
      /no audio segments/,
    );
  });

  test("rate mismatch between segments throws an honest error", async () => {
    const blobs = [blobOf([1]), blobOf([2])];
    let first = true;
    await expect(
      encodeNarrationSegmentsToOgg(blobs, {
        decodeAudio: async (blob) => {
          const rate = first ? 24000 : 16000;
          first = false;
          return { sampleRate: rate, channels: [Float32Array.from(new Uint8Array(await blob.arrayBuffer()))] };
        },
        loadEncoder: async () => stubEncoder([]),
      }),
    ).rejects.toThrow(/different format/);
  });

  test("encoder creation failure propagates (visible save error, no partial file)", async () => {
    await expect(
      encodeNarrationSegmentsToOgg([blobOf([1])], {
        decodeAudio: stubDecoder(),
        loadEncoder: async () => {
          throw new Error("wasm offline");
        },
      }),
    ).rejects.toThrow("wasm offline");
  });

  test("the module loads with zero fetches (wasm only moves on first real save)", async () => {
    const implementation = async (): Promise<Response> => new Response(new Uint8Array());
    // Skill-api precedent: bun's Mock lacks fetch.preconnect — reattach it.
    const fetchSpy = Object.assign(mock(implementation), { preconnect: globalThis.fetch.preconnect });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      await encodeNarrationSegmentsToOgg([blobOf([9])], {
        decodeAudio: stubDecoder(),
        loadEncoder: async () => stubEncoder([]),
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
