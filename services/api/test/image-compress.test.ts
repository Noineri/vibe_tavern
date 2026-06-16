import { describe, expect, test } from "bun:test";
import { PNG } from "pngjs";
import {
  compressForVision,
  isCompressibleImage,
  prepareImageForVision,
} from "../src/shared/image-compress.js";

// prepareImageForVision is the shared seam between the vision-primary path
// (resolveMultimodalContent) and the fallback describe path
// (describeAttachments). It exists to kill the drift that left gallery
// describe sending raw 20MB images that providers rejected as "too large".
//
// These tests pin (a) the existing compression behavior it wraps and
// (b) the never-throws passthrough contract both call sites rely on.

/** Build a valid in-memory PNG of the given dimensions (all-black). */
function makePng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  // pngjs zero-fills .data → fully transparent black. Fine for encode/decode.
  return PNG.sync.write(png);
}

describe("image-compress: isCompressibleImage", () => {
  test("only PNG is compressible (existing behavior)", () => {
    expect(isCompressibleImage("image/png")).toBe(true);
    expect(isCompressibleImage("image/jpeg")).toBe(false);
    expect(isCompressibleImage("image/webp")).toBe(false);
    expect(isCompressibleImage("image/gif")).toBe(false);
  });
});

describe("image-compress: compressForVision (characterization)", () => {
  test("PNG → JPEG with magic bytes", () => {
    const png = makePng(8, 8);
    const out = compressForVision(png, "image/png");
    expect(out.mimeType).toBe("image/jpeg");
    // JPEG SOI marker
    expect(out.buffer[0]).toBe(0xff);
    expect(out.buffer[1]).toBe(0xd8);
    // Compressed payload should be smaller than the raw RGBA encoding would be
    // for any non-trivial image, but we only assert it produced *some* bytes.
    expect(out.buffer.length).toBeGreaterThan(0);
  });

  test("oversized PNG is resized to <= MAX_VISION_DIMENSION (1536)", () => {
    const png = makePng(2000, 1000);
    const out = compressForVision(png, "image/png");
    expect(out.mimeType).toBe("image/jpeg");
    // Re-decode the JPEG to confirm both dims fit under the cap. jpeg-js is
    // already a dependency of image-compress.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jpegJs = require("jpeg-js");
    const decoded = jpegJs.decode(out.buffer, { useTArray: true });
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(1536);
  });
});

describe("image-compress: prepareImageForVision (shared seam)", () => {
  test("PNG is compressed to JPEG", () => {
    const png = makePng(16, 16);
    const out = prepareImageForVision(png, "image/png");
    expect(out.mimeType).toBe("image/jpeg");
    expect(out.buffer).not.toBe(png); // a new buffer was produced
  });

  test("non-compressible formats (JPEG/WEBP/GIF) pass through untouched", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    for (const mime of ["image/jpeg", "image/webp", "image/gif"] as const) {
      const out = prepareImageForVision(jpeg, mime);
      expect(out.buffer).toBe(jpeg); // same reference — no copy, no work
      expect(out.mimeType).toBe(mime);
    }
  });

  test("NEVER throws — invalid/corrupt PNG falls back to the original bytes", () => {
    // This is the contract both call sites depend on: a corrupt image must not
    // abort the whole describe batch. The original inline try/catch in
    // resolveMultimodalContent had this property; prepareImageForVision keeps it.
    const corrupt = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header, no body
    const out = prepareImageForVision(corrupt, "image/png");
    expect(out.buffer).toBe(corrupt);
    expect(out.mimeType).toBe("image/png");
  });

  test("empty buffer (corrupt) falls back to original without throwing", () => {
    const empty = Buffer.alloc(0);
    const out = prepareImageForVision(empty, "image/png");
    expect(out.buffer).toBe(empty);
    expect(out.mimeType).toBe("image/png");
  });
});
