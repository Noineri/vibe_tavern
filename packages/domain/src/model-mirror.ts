/**
 * Shared constants for the server-side model mirrors (Whisper STT, Kokoro
 * TTS) and their browser-side fetch wrappers.
 *
 * Wire reality (P14, owner bug report 2026-09-06): Bun.serve strips an
 * explicit Content-Length from STREAMING bodies and answers chunked — so a
 * mirror response built as `c.body(stream, { "Content-Length": n })` never
 * delivers that header on the wire. transformers.js reads
 * `response.headers.get("Content-Length")` for its download `total`; without
 * it the progress total collapses (bar jumps to the cap). Custom headers DO
 * survive chunked encoding, so the mirrors additionally emit the true size
 * under {@link MIRROR_CONTENT_LENGTH_HEADER}, and the worker-side fetch
 * wrappers reconstruct a real `content-length` header from it before
 * transformers.js sees the Response. Cache hits avoid the whole problem:
 * they are served as `Bun.file` responses, which Bun.serve answers with a
 * genuine Content-Length (sendfile path).
 */

/** Header carrying the true body size past Bun.serve's chunked re-encoding.
 *  Value: the byte size as a decimal string, same format as Content-Length. */
export const MIRROR_CONTENT_LENGTH_HEADER = "x-mirror-content-length";
