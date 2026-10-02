/**
 * Pure avatar-thumbnail normalizer (LINK_BINDING_PERF_PLAN LB-1A).
 *
 * Folder avatars (`avatar.{ext}`) are served into every bound-entity list,
 * so oversized portraits dominate the link-binding popover's first paint.
 * This helper shrinks a just-written avatar to a ≤ 512 px webp thumbnail —
 * the same longest side `AvatarCropModal` produces (`CROP_SIZE = 512`) —
 * while the ORIGINAL bytes always survive in `avatar-full.{ext}` (written
 * by the callers in LB-1B, not here).
 *
 * Rules (plan Wave 1 item 1):
 * - `gif` → unchanged (no animation support; decoding would flatten).
 * - Animated webp (RIFF/WEBP with an `ANIM` chunk or the VP8X animation
 *   flag) → unchanged, same reason.
 * - Already webp with both sides ≤ 512 → unchanged.
 * - Everything else → re-encode to webp quality 85; `resize(512, 512,
 *   { fit: "inside" })` ONLY when a side exceeds 512 — never upscale.
 * - Any thrown error → the input is returned unchanged with a warning
 *   (normalization must never fail an upload or import).
 *
 * Pure helper: no file I/O, no store access. Wiring into the write paths
 * is LB-1B; the startup backfill is a later unit.
 *
 * `Bun.Image` facts verified on this machine (Bun 1.4.2, Windows x64) and
 * against context7 `/oven-sh/bun/bun-v1.4.2` (docs/runtime/image.mdx):
 * `new Bun.Image(bytes)` accepts an in-memory TypedArray, `metadata()` is
 * an async terminal returning `{ width, height, format }` with formats
 * `"png" | "jpeg" | "webp" | …`, `fit: "inside"` preserves aspect ratio,
 * and `.webp({ quality }).bytes()` re-encodes without touching the input.
 */

/** Longest allowed thumbnail side. Matches AvatarCropModal's CROP_SIZE so
 *  no avatar slot visibly changes (plan non-negotiable constraint). */
const THUMBNAIL_MAX_SIDE = 512;

/** Webp re-encode quality. Probed value: a 2048×2736 PNG lands at ~11 KB
 *  at 256 px — quality 85 keeps portraits crisp at a fraction of the bytes. */
const WEBP_QUALITY = 85;

export interface NormalizedAvatarThumbnail {
  bytes: Uint8Array;
  ext: string;
  changed: boolean;
}

/** WebP container animation detector. Animated webp always carries an
 *  `ANIM` chunk and sets the VP8X animation flag (bit 1 of the flags
 *  byte); checking both survives files that only set one. Returns false
 *  for anything that is not a RIFF/WEBP container (the caller then relies
 *  on the metadata decode). */
function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const isRiff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  const isWebp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (!isRiff || !isWebp) return false;

  // Walk the chunk list: fourcc + little-endian uint32 size + payload,
  // payloads padded to an even byte count.
  let offset = 12;
  let sawAnimChunk = false;
  let sawVp8xAnimationFlag = false;
  while (offset + 8 <= bytes.length) {
    const tag = String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
    const size = (bytes[offset + 4]! | (bytes[offset + 5]! << 8) | (bytes[offset + 6]! << 16) | (bytes[offset + 7]! << 24)) >>> 0;
    if (tag === "ANIM") sawAnimChunk = true;
    if (tag === "VP8X" && offset + 8 < bytes.length && (bytes[offset + 8]! & 0b10) !== 0) {
      sawVp8xAnimationFlag = true;
    }
    offset += 8 + size + (size % 2);
  }
  return sawAnimChunk || sawVp8xAnimationFlag;
}

/** Normalize an avatar's bytes to a ≤ 512 px webp thumbnail when possible.
 *  Never throws: on any decode/encode error the input comes back unchanged
 *  (with `changed: false`) and a warning is logged — the write path must
 *  not fail because normalization did. */
export async function normalizeAvatarThumbnail(
  bytes: Uint8Array,
  ext: string,
): Promise<NormalizedAvatarThumbnail> {
  const normalizedExt = ext.toLowerCase();
  if (normalizedExt === "gif") {
    return { bytes, ext, changed: false };
  }
  if (normalizedExt === "webp" && isAnimatedWebp(bytes)) {
    return { bytes, ext, changed: false };
  }

  try {
    const image = new Bun.Image(bytes);
    const { width, height, format } = await image.metadata();
    if (format === "webp" && width <= THUMBNAIL_MAX_SIDE && height <= THUMBNAIL_MAX_SIDE) {
      return { bytes, ext, changed: false };
    }
    const pipeline = width > THUMBNAIL_MAX_SIDE || height > THUMBNAIL_MAX_SIDE
      ? image.resize(THUMBNAIL_MAX_SIDE, THUMBNAIL_MAX_SIDE, { fit: "inside" })
      : image;
    const encoded = await pipeline.webp({ quality: WEBP_QUALITY }).bytes();
    return { bytes: encoded, ext: "webp", changed: true };
  } catch (error) {
    console.warn("[avatar-thumbnail] normalization failed; keeping the original bytes", error);
    return { bytes, ext, changed: false };
  }
}
