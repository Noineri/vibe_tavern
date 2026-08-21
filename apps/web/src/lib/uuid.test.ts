import { describe, expect, test } from "bun:test";
import { randomUUID, uuidFromBytes } from "./uuid.js";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidFromBytes (insecure-context fallback)", () => {
  test("produces an RFC 4122 v4 string from arbitrary bytes", () => {
    const bytes = new Uint8Array(16).map((_, i) => (i * 7 + 1) & 0xff);
    expect(uuidFromBytes(bytes)).toMatch(V4);
  });

  test("does not mutate the caller's buffer", () => {
    const bytes = new Uint8Array(16).fill(0xff);
    const before = Array.from(bytes);
    uuidFromBytes(bytes);
    expect(Array.from(bytes)).toEqual(before);
  });

  test("forces version/variant bits regardless of input", () => {
    for (let n = 0; n < 32; n += 1) {
      const id = uuidFromBytes(new Uint8Array(16).fill(n));
      expect(id[14]).toBe("4");
      expect(["8", "9", "a", "b"]).toContain(id[19]);
    }
  });

  test("rejects buffers that are not 16 bytes long", () => {
    expect(() => uuidFromBytes(new Uint8Array(15))).toThrow(RangeError);
    expect(() => uuidFromBytes(new Uint8Array(17))).toThrow(RangeError);
  });
});

describe("randomUUID", () => {
  test("returns a valid v4 uuid via the native path (secure context)", () => {
    expect(randomUUID()).toMatch(V4);
  });

  test("falls back to getRandomValues when crypto.randomUUID is absent", () => {
    // Simulate an insecure context: shadow randomUUID with an own property
    // that reads as absent, then restore the original prototype lookup.
    const c = crypto as { randomUUID?: () => string };
    const hadOwn = Object.prototype.hasOwnProperty.call(c, "randomUUID");
    const original = c.randomUUID;
    try {
      Object.defineProperty(c, "randomUUID", {
        configurable: true,
        get: () => undefined,
      });
      for (let n = 0; n < 16; n += 1) expect(randomUUID()).toMatch(V4);
    } finally {
      if (hadOwn) {
        Object.defineProperty(c, "randomUUID", { configurable: true, writable: true, value: original });
      } else {
        delete c.randomUUID;
      }
    }
    expect(randomUUID()).toMatch(V4);
  });
});
