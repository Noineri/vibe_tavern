/**
 * Pure narration text chunking for the Kokoro in-browser TTS path.
 *
 * `splitParagraphs` is the paragraph boundary used by the playback orchestrator;
 * `chunkNarrationText` produces model-safe chunks (≤ maxChars, default 400).
 *
 * Whitespace normalization:
 * - Input `\r\n` is normalized to `\n` before splitting.
 * - Paragraphs are delimited by blank lines: one or more empty lines, each
 *   possibly containing whitespace (`\n\s*\n`). Single newlines inside a
 *   paragraph are preserved as-is until the sentence/word split stage.
 * - `splitParagraphs` trims each paragraph and drops empty entries — never
 *   emits empty or whitespace-only strings.
 * - `chunkNarrationText` joins sentences inside one paragraph with a single
 *   space when re-packing them into chunks, and joins words inside an
 *   overlong sentence with a single space. Original multi-space runs are
 *   therefore collapsed to single spaces in over-budget paragraphs.
 * - No characters are dropped or duplicated: the word/character multiset of
 *   the input (modulo the whitespace collapse above) is preserved in order
 *   across the returned chunks.
 */

/**
 * Split narration text on blank lines (paragraph boundaries). Tolerates CRLF,
 * multiple consecutive blank lines, and blank lines that contain whitespace.
 * Trims each paragraph and drops empties. Returns [] for empty/whitespace-only
 * input. Never throws.
 */
export function splitParagraphs(text: string): string[] {
  if (!text || text.trim() === "") return [];
  const normalized = text.replace(/\r\n/g, "\n");
  const parts = normalized.split(/\n\s*\n/);
  const result: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length > 0) result.push(trimmed);
  }
  return result;
}

/**
 * Split narration text into model-safe chunks (≤ maxChars, default 400).
 *
 * 1. Split into paragraphs via {@link splitParagraphs} (blank-line boundary).
 * 2. A paragraph ≤ maxChars is emitted as-is.
 * 3. A paragraph > maxChars is split at sentence boundaries — punctuation
 *    `.` `!` `?` `…` followed by whitespace (punctuation stays with the
 *    sentence). The sentences are packed greedily into ≤ maxChars chunks
 *    (joined with a single space).
 * 4. A single sentence still > maxChars is split at word boundaries
 *    (whitespace) without dropping or duplicating characters. A word longer
 *    than maxChars is hard-split into maxChars slices.
 * Never emits empty or whitespace-only chunks. Pure and total.
 */
export function chunkNarrationText(text: string, opts?: { maxChars?: number }): string[] {
  const maxChars = opts?.maxChars ?? 400;
  if (!text || text.trim() === "") return [];
  const paragraphs = splitParagraphs(text);
  const result: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) {
      result.push(paragraph);
      continue;
    }

    const sentences = splitIntoSentences(paragraph);
    let current = "";

    for (const sentence of sentences) {
      if (sentence.length > maxChars) {
        if (current) {
          result.push(current);
          current = "";
        }
        const wordChunks = splitLongSentenceByWords(sentence, maxChars);
        for (const wc of wordChunks) result.push(wc);
        continue;
      }

      const candidate = current ? `${current} ${sentence}` : sentence;
      if (candidate.length <= maxChars) {
        current = candidate;
      } else {
        if (current) result.push(current);
        current = sentence;
      }
    }

    if (current) result.push(current);
  }

  return result;
}

function splitIntoSentences(paragraph: string): string[] {
  // Split on whitespace that follows sentence punctuation. The punctuation
  // remains attached to the preceding sentence.
  const parts = paragraph.split(/(?<=[.!?…])\s+/);
  const out: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (t.length > 0) out.push(t);
  }
  // If no sentence boundary was found the whole paragraph is one sentence.
  if (out.length === 0) return [paragraph.trim()].filter((s) => s.length > 0);
  return out;
}

function splitLongSentenceByWords(sentence: string, maxChars: number): string[] {
  const words = sentence.split(/\s+/).filter((w) => w.length > 0);
  const chunks: string[] = [];
  let cur = "";

  for (const word of words) {
    if (word.length > maxChars) {
      if (cur) {
        chunks.push(cur);
        cur = "";
      }
      for (let i = 0; i < word.length; i += maxChars) {
        chunks.push(word.slice(i, i + maxChars));
      }
      continue;
    }

    const cand = cur ? `${cur} ${word}` : word;
    if (cand.length <= maxChars) {
      cur = cand;
    } else {
      if (cur) chunks.push(cur);
      cur = word;
    }
  }

  if (cur) chunks.push(cur);
  return chunks;
}
