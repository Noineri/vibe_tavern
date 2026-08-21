import { describe, expect, test } from "bun:test";
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
// These tests pin (a) which formats the seam compresses, (b) the resize cap
// without upscaling, and (c) the never-throws passthrough contract both call
// sites rely on.
//
// pngjs/jpeg-js were removed together with the pure-JS codec this module used
// to use — fixtures below are self-contained: an embedded 8×8 transparent PNG
// seed, stretched/re-encoded through Bun.Image itself. (A 1×1 seed renders
// "decode failed" on Bun 1.4 — do not shrink it back.)

const PNG_8X8 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAADElEQVR4AWMYBWAAAAEIAAGGQtUVAAAAAElFTkSuQmCC",
  "base64",
);

/** Build a solid transparent image of exact dimensions in the given format. */
async function makeImage(
  width: number,
  height: number,
  format: "png" | "jpeg" | "webp",
): Promise<Buffer> {
  const stretched = new Bun.Image(PNG_8X8).resize(width, height, { fit: "fill" });
  const encoded =
    format === "png"
      ? await stretched.png().bytes()
      : format === "jpeg"
        ? await stretched.jpeg({ quality: 80 }).bytes()
        : await stretched.webp().bytes();
  return Buffer.from(encoded);
}

async function dims(buf: Buffer): Promise<{ width: number; height: number; format: string }> {
  return await new Bun.Image(buf).metadata();
}

function expectJpegMagic(buf: Buffer): void {
  // JPEG SOI marker
  expect(buf[0]).toBe(0xff);
  expect(buf[1]).toBe(0xd8);
}

describe("image-compress: isCompressibleImage", () => {
  test("raster formats Bun.Image decodes are compressible; GIF/SVG are not", () => {
    for (const mime of [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/bmp",
      "image/tiff",
      "image/avif",
      "image/heic",
      "image/heif",
    ] as const) {
      expect(isCompressibleImage(mime)).toBe(true);
    }
    // GIF: animated payload — flattening to the first frame would silently
    // destroy it, so it passes through exactly as before this module existed.
    expect(isCompressibleImage("image/gif")).toBe(false);
    expect(isCompressibleImage("image/svg+xml")).toBe(false);
    expect(isCompressibleImage("application/octet-stream")).toBe(false);
  });
});

describe("image-compress: compressForVision", () => {
  test("PNG → JPEG with magic bytes", async () => {
    const png = await makeImage(8, 8, "png");
    const out = await compressForVision(png, "image/png");
    expect(out.mimeType).toBe("image/jpeg");
    expectJpegMagic(out.buffer);
    expect(out.buffer.length).toBeGreaterThan(0);
  });

  test("oversized image is resized to <= 1536 (never upscaled beyond the cap)", async () => {
    const png = await makeImage(2000, 1000, "png");
    const out = await compressForVision(png, "image/png");
    const meta = await dims(out.buffer);
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(1536);
    expect(meta.format).toBe("jpeg");
  });

  test("image below the cap is NOT upscaled (Bun resize would, the module guards)", async () => {
    const png = await makeImage(8, 8, "png");
    const out = await compressForVision(png, "image/png");
    const meta = await dims(out.buffer);
    // fit:"inside" upscales small inputs even with upscale:false (verified on
    // Bun 1.4) — this pin protects the explicit over-cap gate in the module.
    expect(meta.width).toBe(8);
    expect(meta.height).toBe(8);
  });

  test("JPEG input is re-encoded (old pure-JS codec could not decode JPEG at all)", async () => {
    const jpeg = await makeImage(640, 480, "jpeg");
    const out = await compressForVision(jpeg, "image/jpeg");
    expect(out.mimeType).toBe("image/jpeg");
    expectJpegMagic(out.buffer);
    const meta = await dims(out.buffer);
    expect(meta.width).toBe(640);
  });

  test("WEBP input is re-encoded as JPEG", async () => {
    const webp = await makeImage(32, 32, "webp");
    const out = await compressForVision(webp, "image/webp");
    expect(out.mimeType).toBe("image/jpeg");
    expectJpegMagic(out.buffer);
  });
});

describe("image-compress: prepareImageForVision (shared seam)", () => {
  test("compressible image is compressed to JPEG", async () => {
    const png = await makeImage(16, 16, "png");
    const out = await prepareImageForVision(png, "image/png");
    expect(out.mimeType).toBe("image/jpeg");
    expectJpegMagic(out.buffer);
    expect(out.buffer).not.toBe(png); // a new buffer was produced
  });

  test("non-compressible formats (GIF/SVG) pass through untouched", async () => {
    const raw = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    for (const mime of ["image/gif", "image/svg+xml"] as const) {
      const out = await prepareImageForVision(raw, mime);
      expect(out.buffer).toBe(raw); // same reference — no copy, no work
      expect(out.mimeType).toBe(mime);
    }
  });

  test("NEVER throws — invalid/corrupt input falls back to the original bytes", async () => {
    // This is the contract both call sites depend on: a corrupt image must not
    // abort the whole describe batch. The original inline try/catch in
    // resolveMultimodalContent had this property; prepareImageForVision keeps it.
    const corrupt = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header, no body
    const out = await prepareImageForVision(corrupt, "image/png");
    expect(out.buffer).toBe(corrupt);
    expect(out.mimeType).toBe("image/png");
  });

  test("empty buffer (corrupt) falls back to original without throwing", async () => {
    const empty = Buffer.alloc(0);
    const out = await prepareImageForVision(empty, "image/png");
    expect(out.buffer).toBe(empty);
    expect(out.mimeType).toBe("image/png");
  });
});
