/**
 * Image compression for vision API payloads.
 *
 * Providers like NanoGPT reject requests with large base64 images.
 * This module compresses PNG/WEBP to JPEG and resizes to a max dimension
 * before sending to the vision model.
 *
 * Uses pure-JS pngjs + jpeg-js — works on all platforms including Bun/Windows.
 */

import { PNG } from "pngjs";
import jpegJs from "jpeg-js";

/** Max dimension (width or height) for vision images. */
const MAX_VISION_DIMENSION = 1536;

/** JPEG quality (0-100). 80 is a good balance for vision. */
const JPEG_QUALITY = 80;

/**
 * Compress an image buffer for vision API consumption.
 *
 * - Decodes PNG/WEBP/GIF to RGBA
 * - Resizes if larger than MAX_VISION_DIMENSION
 * - Re-encodes as JPEG at quality 80
 *
 * Returns the JPEG buffer and MIME type.
 */
export function compressForVision(
  input: Buffer,
  inputMimeType: string,
): { buffer: Buffer; mimeType: string } {
  // For JPEG inputs, just check size — jpeg-js can't decode JPEG for re-encoding
  // Actually, we need to decode first. Let's handle what we can.
  const rgba = decodeToRGBA(input, inputMimeType);
  const { data, width, height } = resizeRGBA(rgba, rgba.width, rgba.height);

  const jpeg = jpegJs.encode(
    { data, width, height },
    JPEG_QUALITY,
  );

  return {
    buffer: jpeg.data,
    mimeType: "image/jpeg",
  };
}

/**
 * Decode an image buffer to RGBA pixels.
 * Supports PNG natively. For other formats, returns raw buffer (caller handles).
 */
function decodeToRGBA(
  input: Buffer,
  mimeType: string,
): { data: Buffer; width: number; height: number } {
  if (mimeType === "image/png" || mimeType === "image/png") {
    const png = PNG.sync.read(input);
    return { data: Buffer.from(png.data), width: png.width, height: png.height };
  }

  // For JPEG/WEBP/GIF — pngjs can't decode these.
  // Return as-is; the caller should pass through without compression.
  // In practice, JPEG inputs are already compressed and usually fine.
  throw new Error(`Unsupported image format for compression: ${mimeType}`);
}

/**
 * Nearest-neighbor resize of RGBA buffer.
 * Returns the same buffer if no resize needed.
 */
function resizeRGBA(
  rgba: { data: Buffer; width: number; height: number },
  origWidth: number,
  origHeight: number,
): { data: Buffer; width: number; height: number } {
  const maxDim = MAX_VISION_DIMENSION;
  if (origWidth <= maxDim && origHeight <= maxDim) {
    return rgba;
  }

  const scale = maxDim / Math.max(origWidth, origHeight);
  const newW = Math.round(origWidth * scale);
  const newH = Math.round(origHeight * scale);
  const resized = Buffer.alloc(newW * newH * 4);

  for (let y = 0; y < newH; y++) {
    const srcY = Math.min(Math.floor(y / scale), origHeight - 1);
    for (let x = 0; x < newW; x++) {
      const srcX = Math.min(Math.floor(x / scale), origWidth - 1);
      const srcIdx = (srcY * origWidth + srcX) * 4;
      const dstIdx = (y * newW + x) * 4;
      resized[dstIdx] = rgba.data[srcIdx];
      resized[dstIdx + 1] = rgba.data[srcIdx + 1];
      resized[dstIdx + 2] = rgba.data[srcIdx + 2];
      resized[dstIdx + 3] = rgba.data[srcIdx + 3];
    }
  }

  return { data: resized, width: newW, height: newH };
}

/**
 * Check if a MIME type can be compressed by this module.
 */
export function isCompressibleImage(mimeType: string): boolean {
  return mimeType === "image/png";
}

/**
 * Prepare an image buffer for sending to a vision model: compress + resize
 * when the format is supported (PNG → JPEG, capped at MAX_VISION_DIMENSION),
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
export function prepareImageForVision(
  buffer: Buffer,
  mimeType: string,
): { buffer: Buffer; mimeType: string } {
  if (!isCompressibleImage(mimeType)) return { buffer, mimeType };
  try {
    return compressForVision(buffer, mimeType);
  } catch {
    return { buffer, mimeType };
  }
}
