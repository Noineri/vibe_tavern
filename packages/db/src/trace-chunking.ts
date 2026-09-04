import { createHash } from 'node:crypto';

/**
 * Content-addressed chunking for prompt-trace payload columns.
 *
 * Prompt traces snapshot the ENTIRE assembled prompt (the whole chat history
 * at that moment), so consecutive traces in a chat share almost all of their
 * bytes — stored again on every turn. Measured on the owner's live DB
 * (2026-09-07, 6199 traces): 1107 MB of payload strings collapse to ~187 MB
 * of unique chunks (≈5×), and growth per message becomes additive instead of
 * quadratic.
 *
 * A trace column is stored as a "skeleton" JSON document where every string
 * ≥ TRACE_CHUNK_THRESHOLD characters is replaced by a marker object
 * `{ "$vtchunk": "<sha256-hex>" }`; the string itself lives once in the
 * `prompt_trace_chunks` table keyed by that hash. Inflation reverses the
 * substitution, returning a deep-equal value with strings in their original
 * positions (object key order is preserved — the inflated value re-stringifies
 * byte-identically for non-chunked documents, and chunked markers occupy the
 * same key slots the original strings held).
 *
 * Marker safety: user content reaches these columns only as STRING values
 * (message text, layer text); markers are OBJECTS with the single key
 * "$vtchunk", so user data can never collide with a marker. Inflation only
 * substitutes objects with exactly that key shape and a 64-char hex value.
 */

/** Marker key identifying a chunk reference inside a skeleton document. */
export const TRACE_CHUNK_MARKER = '$vtchunk';

/**
 * Minimum string length (JS characters) that gets chunked. Shorter strings
 * stay inline — a reference costs ~80 bytes (marker key + sha256 hex), so
 * chunking anything below this would ENLARGE the row.
 */
export const TRACE_CHUNK_THRESHOLD = 256;

export interface TraceChunk {
  /** sha256 of the UTF-8 bytes of `content` (64 lowercase hex chars). */
  id: string;
  content: string;
}

export interface DeflatedTraceValue {
  /** The original value with every eligible string replaced by a marker object. */
  skeleton: unknown;
  /** Unique chunks extracted from this value, in first-encounter order. */
  chunks: TraceChunk[];
}

export function hashTraceChunk(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Replace every string ≥ threshold with a chunk marker, collecting the chunks.
 * Small strings, numbers, booleans, null, and object structure pass through
 * untouched. Arrays and plain objects are walked recursively; other object
 * kinds (dates, etc.) do not occur in trace payloads and are left as-is.
 */
export function deflateTraceValue(value: unknown): DeflatedTraceValue {
  const chunks = new Map<string, string>();
  const seen = new WeakSet<object>();

  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (v.length < TRACE_CHUNK_THRESHOLD) return v;
      const id = hashTraceChunk(v);
      if (!chunks.has(id)) chunks.set(id, v);
      return { [TRACE_CHUNK_MARKER]: id };
    }
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return v; // cycles cannot occur in JSON payloads; defensive
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v)) out[key] = walk((v as Record<string, unknown>)[key]);
    return out;
  };

  return { skeleton: walk(value), chunks: [...chunks].map(([id, content]) => ({ id, content })) };
}

function isMarkerObject(v: unknown): v is Record<typeof TRACE_CHUNK_MARKER, string> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== TRACE_CHUNK_MARKER) return false;
  const id = (v as Record<string, unknown>)[TRACE_CHUNK_MARKER];
  return typeof id === 'string' && /^[0-9a-f]{64}$/.test(id);
}

/**
 * Reverse {@link deflateTraceValue}: substitute every marker object with the
 * chunk content from `lookup`. A marker whose chunk is missing from the lookup
 * throws — chunks and their referencing rows are written in the same
 * transaction, so a miss means corrupted state that must surface loudly
 * rather than silently return a marker into the UI.
 */
export function inflateTraceValue<T = unknown>(skeleton: unknown, lookup: (id: string) => string | undefined): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v;
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    if (isMarkerObject(v)) {
      const id = v[TRACE_CHUNK_MARKER];
      const content = lookup(id);
      if (content === undefined) {
        throw new Error(`prompt-trace chunk '${id}' is referenced but missing from prompt_trace_chunks`);
      }
      return content;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v)) out[key] = walk((v as Record<string, unknown>)[key]);
    return out;
  };
  return walk(skeleton) as T;
}

/** Collect every chunk id referenced by a skeleton document, in order. */
export function collectTraceChunkIds(skeleton: unknown): string[] {
  const ids: string[] = [];
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const item of v) walk(item); return; }
    if (isMarkerObject(v)) { ids.push(v[TRACE_CHUNK_MARKER]); return; }
    for (const key of Object.keys(v)) walk((v as Record<string, unknown>)[key]);
  };
  walk(skeleton);
  return ids;
}
