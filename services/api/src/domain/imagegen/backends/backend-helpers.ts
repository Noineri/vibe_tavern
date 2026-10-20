/**
 * @module imagegen/backends/backend-helpers
 *
 * ONE home for the HTTP/MIME/validation mechanics every image-gen backend
 * hand-copied before IG-R1 (19 private fetchOrWrap twins, 11 private
 * sniffers, the a1111/comfyui requirePositiveInt + setOrUndefined pair).
 * The helpers are parameterised by exactly what differed between the
 * copies — the error CLASS each backend throws and the label prefix of
 * its message — so every backend's behaviour and every error text stay
 * byte-identical to its former private twin.
 *
 * The abort contract (the ai-assistant abort fix) lives HERE once:
 * `fetchOrWrap` rethrows the caller's own `AbortError` untouched, so
 * cancellation stays distinguishable from a transport failure on every
 * backend, forever.
 *
 * `sniffImageMime` is the family's single image-signature sniffer (the
 * former raw-binary.ts `sniffImageMimeFromBytes`, GIF branch included —
 * load-bearing there: the raw-binary arm gates on `headerMime ?? sniffed`
 * and must recognise every format its vendors can serve). The backends
 * that sniff a payload they have ALREADY accepted use it purely as a
 * mimeType LABEL picker — `sniffImageMime(bytes) ?? <documented fallback>`
 * — never as a gate, so a null result never turns into an error there.
 */

/** The main transport-error constructor every image-gen backend shares:
 *  message + optional cause/status options. The class itself stays
 *  backend-local and typed; only its construction shape is shared. */
export type ImageGenTransportErrorCtor = new (
  message: string,
  options?: { cause?: unknown; status?: number },
) => Error;

/** The size-validation error constructor: message-only (the free-W×H
 *  fail-closed error class of the a1111/ComfyUI dialects). */
export type ImageGenSizeErrorCtor = new (message: string) => Error;

/** Await a fetch call through the injected seam. Transport-level failures
 *  wrap into the caller's typed error — EXCEPT the caller's own abort,
 *  which is rethrown untouched so cancellation stays distinguishable from
 *  a transport failure (the abort contract of the ai-assistant abort fix). */
export async function fetchOrWrap(
  transport: typeof fetch,
  url: string,
  init: RequestInit,
  operation: string,
  label: string,
  errorCtor: ImageGenTransportErrorCtor,
): Promise<Response> {
  try {
    return await transport(url, init);
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    throw new errorCtor(
      `${label} ${operation} network error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

/** Sniff the image MIME from magic bytes (PNG, JPEG, GIF, WebP). Vendors
 *  that error sometimes answer 200 with a text body — for the raw-binary
 *  arm that must surface as an error, not a corrupt "image"; for the
 *  envelope backends the result only labels bytes already accepted (see
 *  the module doc). */
export function sniffImageMime(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** Validate a free W×H integer (positive, finite, integral) — the shared
 *  body of the a1111/ComfyUI size guards; `label` and `errorCtor` keep
 *  each backend's fail-closed error class and text byte-identical. */
export function requirePositiveInt(
  name: string,
  value: number,
  label: string,
  errorCtor: ImageGenSizeErrorCtor,
): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new errorCtor(`${label} accepts a positive integer ${name} — got ${value}`);
  }
  return value;
}

/** A set string field: trimmed and non-empty, else undefined (unset fields
 *  are omitted from the wire body — the card's server-defaults rule). */
export function setOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
