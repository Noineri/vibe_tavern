/**
 * Unit tests for the shared image-gen backend helpers (IG-R1) — the ONE
 * home the backends' former private twins moved into. Pins the contracts
 * the family relies on: the abort rethrow (the ai-assistant abort fix —
 * the caller's AbortError passes through untouched, cancellation stays
 * distinguishable from a network failure), the byte-identical wrap shape
 * (`<label> <operation> network error: <cause>`), the image-signature
 * sniffer's coverage, and the a1111/ComfyUI validation pair. Tier T0:
 * pure logic — the transport is a stub function argument, no globalThis
 * patches, no mock.module, nothing to restore.
 */

import { describe, expect, it } from "bun:test";

import {
  fetchOrWrap,
  requirePositiveInt,
  setOrUndefined,
  sniffImageMime,
} from "../src/domain/imagegen/backends/backend-helpers.js";

/** The family's main-error shape (message + cause/status options). */
class TestTransportError extends Error {
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "TestTransportError";
    this.status = options?.status;
  }
}

/** The family's size-error shape (message only). */
class TestSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestSizeError";
  }
}

const TRANSPORT_LABEL = "Test backend";
const SIZE_LABEL = "Test backend generation";

// ─── fetchOrWrap ─────────────────────────────────────────────────────────────

describe("fetchOrWrap (IG-R1)", () => {
  it("returns the transport's response untouched on success", async () => {
    const response = new Response("ok");
    const result = await fetchOrWrap(
      async () => response,
      "https://example.test/generate",
      { method: "POST" },
      "generation",
      TRANSPORT_LABEL,
      TestTransportError,
    );
    expect(result).toBe(response);
  });

  it("rethrows the caller's AbortError untouched (the abort contract)", async () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    const caught = await fetchOrWrap(
      async () => {
        throw abort;
      },
      "https://example.test/generate",
      { method: "POST" },
      "generation",
      TRANSPORT_LABEL,
      TestTransportError,
    ).catch((error: unknown) => error);
    expect(caught).toBe(abort);
    expect((caught as Error).name).toBe("AbortError");
    expect(caught).not.toBeInstanceOf(TestTransportError);
  });

  it("rethrows a DOMException AbortError (what fetch itself throws) untouched", async () => {
    const abort = new DOMException("Aborted", "AbortError");
    const caught = await fetchOrWrap(
      async () => {
        throw abort;
      },
      "https://example.test/generate",
      { method: "POST" },
      "generation",
      TRANSPORT_LABEL,
      TestTransportError,
    ).catch((error: unknown) => error);
    expect(caught).toBe(abort);
  });

  it("wraps an Error failure in the given class with the byte-identical message", async () => {
    const cause = new Error("boom");
    const caught = await fetchOrWrap(
      async () => {
        throw cause;
      },
      "https://example.test/generate",
      { method: "POST" },
      "generation",
      TRANSPORT_LABEL,
      TestTransportError,
    ).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(TestTransportError);
    expect((caught as TestTransportError).message).toBe(
      "Test backend generation network error: boom",
    );
    expect((caught as TestTransportError).cause).toBe(cause);
  });

  it("wraps a non-Error throw with String(cause) in the message", async () => {
    const caught = await fetchOrWrap(
      async () => {
        throw "raw failure";
      },
      "https://example.test/generate",
      { method: "POST" },
      "image download",
      TRANSPORT_LABEL,
      TestTransportError,
    ).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(TestTransportError);
    expect((caught as TestTransportError).message).toBe(
      "Test backend image download network error: raw failure",
    );
  });
});

// ─── sniffImageMime ──────────────────────────────────────────────────────────

describe("sniffImageMime (IG-R1)", () => {
  it("recognises the PNG signature", () => {
    expect(
      sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe("image/png");
  });

  it("recognises the JPEG signature", () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
  });

  it("recognises the GIF89a signature", () => {
    expect(sniffImageMime(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif");
  });

  it("requires the full 6-byte GIF header (5 bytes 'GIF89' is not an image)", () => {
    expect(sniffImageMime(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39]))).toBe(null);
  });

  it("recognises the RIFF/WEBP signature", () => {
    expect(
      sniffImageMime(
        Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe("image/webp");
  });

  it("returns null for a non-image payload and for empty bytes", () => {
    expect(sniffImageMime(Buffer.from("200 OK but this is a text body", "utf8"))).toBe(null);
    expect(sniffImageMime(Buffer.alloc(0))).toBe(null);
  });
});

// ─── requirePositiveInt ──────────────────────────────────────────────────────

describe("requirePositiveInt (IG-R1)", () => {
  it("passes a positive integer through", () => {
    expect(requirePositiveInt("width", 1, SIZE_LABEL, TestSizeError)).toBe(1);
    expect(requirePositiveInt("height", 1024, SIZE_LABEL, TestSizeError)).toBe(1024);
  });

  it("throws the given class with the byte-identical message for non-positive ints", () => {
    for (const bad of [0, -5]) {
      let thrown: unknown;
      try {
        requirePositiveInt("width", bad, SIZE_LABEL, TestSizeError);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TestSizeError);
      expect((thrown as TestSizeError).message).toBe(
        `Test backend generation accepts a positive integer width — got ${bad}`,
      );
    }
  });

  it("throws for non-finite and non-integral values (NaN, Infinity, 1.5)", () => {
    for (const bad of [NaN, Infinity, 1.5]) {
      let thrown: unknown;
      try {
        requirePositiveInt("height", bad, SIZE_LABEL, TestSizeError);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TestSizeError);
      expect((thrown as TestSizeError).message).toBe(
        `Test backend generation accepts a positive integer height — got ${bad}`,
      );
    }
  });
});

// ─── setOrUndefined ──────────────────────────────────────────────────────────

describe("setOrUndefined (IG-R1)", () => {
  it("trims a set value", () => {
    expect(setOrUndefined("  value  ")).toBe("value");
    expect(setOrUndefined("value")).toBe("value");
  });

  it("returns undefined for unset, empty, and whitespace-only values", () => {
    expect(setOrUndefined(undefined)).toBeUndefined();
    expect(setOrUndefined("")).toBeUndefined();
    expect(setOrUndefined("   ")).toBeUndefined();
  });
});
