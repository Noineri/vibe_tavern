/**
 * Image compression for vision API payloads.
 *
 * Providers like NanoGPT reject requests with large base64 images, so an
 * attachment is downscaled to a max dimension and re-encoded as JPEG before it
 * goes to the vision model.
 *
 * Uses Bun.Image (native codecs): decode → resize → JPEG encode is recorded as
 * one pipeline and runs on a worker thread when the terminal `bytes()` is
 * awaited.
 */

/** Max dimension (width or height) for vision images. */
const MAX_VISION_DIMENSION = 1536;

/** JPEG quality (0-100). 80 is a good balance for vision. */
const JPEG_QUALITY = 80;

/**
 * MIMEs this module compresses.
 *
 * The bound is the upload gate, not Bun.Image: `ALLOWED_MIMES` in
 * `domain/asset/asset-service.ts` admits only jpeg/png/gif/webp, and every
 * attachment gets its `mimeType` from that gate, so no other image MIME can
 * reach here. GIF is excluded deliberately — it is the one accepted image MIME
 * whose payload can be animated, and Bun.Image would silently flatten it to
 * the first frame; a too-big GIF failing at the provider beats destroying
 * content the user attached.
 *
 * bmp/tiff/avif/heic/heif used to be listed and were unreachable twice over:
 * no upload can carry them, and on Linux Bun.Image cannot even decode them
 * (measured on 1.4.2 — tiff/avif/heic throw `ERR_IMAGE_FORMAT_UNSUPPORTED`,
 * "HEIC/AVIF/TIFF require the OS codec"; bmp throws `ERR_IMAGE_DECODE_FAILED`
 * for every variant except 24-bit BMP3).
 */
const COMPRESSIBLE_MIMES: Record<string, true> = {
  "image/jpeg": true,
  "image/png": true,
  "image/webp": true,
};

/**
 * Compress an image buffer for vision API consumption: decode (format sniffed
 * from the bytes, not the MIME label), downscale to fit
 * {@link MAX_VISION_DIMENSION}, re-encode as JPEG at quality 80.
 *
 * `withoutEnlargement` is what keeps a small image small: `fit: "inside"`
 * alone upscales a smaller source (measured on Bun 1.4.2 — an 8×8 PNG through
 * `resize(1536, 1536, { fit: "inside" })` comes back 1536×1536 / 37KB, with
 * `withoutEnlargement: true` it stays 8×8 / 631 bytes). An oversized source
 * resizes identically either way (2000×1000 → 1536×768), so the option
 * replaces the former manual over-cap gate and its `metadata()` round-trip.
 * That is a simplification, not a speed-up: `metadata()` reads the header
 * only, and interleaved timings on a 3000×2000 JPEG are indistinguishable
 * (median 48.9ms before, 49.3ms after, identical output bytes).
 */
export async function compressForVision(input: Buffer): Promise<{ buffer: Buffer; mimeType: string }> {
  const jpeg = await new Bun.Image(input)
    .resize(MAX_VISION_DIMENSION, MAX_VISION_DIMENSION, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .bytes();
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
  if (COMPRESSIBLE_MIMES[mimeType] !== true) return { buffer, mimeType };
  try {
    return await compressForVision(buffer);
  } catch {
    return { buffer, mimeType };
  }
}
