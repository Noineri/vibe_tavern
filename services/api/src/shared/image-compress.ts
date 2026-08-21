/**
 * Image compression for vision API payloads.
 *
 * Providers like NanoGPT reject requests with large base64 images.
 * This module compresses raster images to JPEG and resizes to a max dimension
 * before sending to the vision model.
 *
 * Uses Bun.Image (native codecs) — decodes JPEG/PNG/WebP/BMP/TIFF/AVIF/HEIC,
 * never upscales (only images over the cap are resized), re-encodes as JPEG.
 *
 * GIF stays passthrough: it is the one accepted image MIME whose payload can be
 * animated, and Bun.Image would silently flatten it to the first frame — a
 * too-big GIF fails at the provider exactly as before, which beats silently
 * destroying content the user attached. SVG stays passthrough (not raster).
 */

/** Max dimension (width or height) for vision images. */
const MAX_VISION_DIMENSION = 1536;

/** JPEG quality (0-100). 80 is a good balance for vision. */
const JPEG_QUALITY = 80;

const COMPRESSIBLE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/avif",
  "image/heic",
  "image/heif",
]);

/**
 * Check whether a MIME type can be compressed by this module.
 * Raster formats Bun.Image decodes — GIF (animation) and SVG (vector) excluded.
 */
export function isCompressibleImage(mimeType: string): boolean {
  return COMPRESSIBLE_MIMES.has(mimeType);
}

/**
 * Compress an image buffer for vision API consumption.
 *
 * - Decodes any supported raster format (format sniffed from bytes, not the
 *   MIME label)
 * - Resizes to fit {@link MAX_VISION_DIMENSION} — ONLY when oversized; Bun's
 *   `resize` upscales small images even with `fit: "inside"` (+ `upscale: false`
 *   is ignored, verified on Bun 1.4), so the over-cap check is explicit
 * - Re-encodes as JPEG at quality 80
 */
export async function compressForVision(
  input: Buffer,
  _inputMimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const source = new Bun.Image(input);
  const meta = await source.metadata();
  const pipeline =
    meta.width > MAX_VISION_DIMENSION || meta.height > MAX_VISION_DIMENSION
      ? source.resize(MAX_VISION_DIMENSION, MAX_VISION_DIMENSION, { fit: "inside" })
      : source;
  const jpeg = await pipeline.jpeg({ quality: JPEG_QUALITY }).bytes();
  return {
    buffer: Buffer.from(jpeg),
    mimeType: "image/jpeg",
  };
}

/**
 * Prepare an image buffer for sending to a vision model: compress + resize
 * when the format is supported (→ JPEG capped at MAX_VISION_DIMENSION),
 * otherwise pass the bytes through untouched.
 *
 * Centralized here so BOTH vision send paths stay in sync:
 *  • `resolveMultimodalContent` — vision-primary chat (pixels to the model)
 *  • `describeAttachments`    — fallback describe (gallery images + chat
 *    non-vision fallback) — the path gallery Describe uses.
 *
 * A previous drift left `describeAttachments` sending raw images, so large
 * gallery rows (up to the 20MB upload cap) were rejected by providers as
 * "too large". Routing both through this seam prevents that recurring.
 *
 * Never throws: on decode/encode failure the original buffer is returned so
 * the provider makes the final call (mirrors the original inline try/catch
 * semantics in resolveMultimodalContent).
 */
export async function prepareImageForVision(
  buffer: Buffer,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (!isCompressibleImage(mimeType)) return { buffer, mimeType };
  try {
    return await compressForVision(buffer, mimeType);
  } catch {
    return { buffer, mimeType };
  }
}
