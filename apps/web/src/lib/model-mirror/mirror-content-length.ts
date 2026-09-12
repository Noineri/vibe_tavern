/**
 * Worker-side Content-Length reconstruction for the server-side model
 * mirrors (Whisper STT, Kokoro TTS).
 *
 * Bun.serve strips an explicit Content-Length from streaming mirror
 * responses and answers chunked (P14, owner bug report 2026-09-06) — the
 * mirrors therefore carry the true size in the custom
 * `x-mirror-content-length` header, which DOES survive chunked encoding.
 * transformers.js reads `response.headers.get("Content-Length")` to compute
 * its download `total`; when that header is missing the progress total
 * collapses (bar jumps straight to the cap). This helper rebuilds a real
 * `content-length` header from the mirror header so transformers.js sees
 * the true size. Pure function — no DOM, no state.
 */

import { MIRROR_CONTENT_LENGTH_HEADER } from "@vibe-tavern/domain";

/** Return `response` unchanged unless it is a length-less mirror response
 *  carrying the mirror size header — then a reconstructed twin Response
 *  with a real `content-length`. The body stream and status pass through. */
export function restoreMirrorContentLength(response: Response): Response {
  if (response.headers.get("content-length") !== null) return response;
  const mirrored = response.headers.get(MIRROR_CONTENT_LENGTH_HEADER);
  if (mirrored === null) return response;
  const headers = new Headers(response.headers);
  headers.set("content-length", mirrored);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
