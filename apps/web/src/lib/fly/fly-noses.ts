/**
 * Fly Tribunal — experimental stimulus encoders ("noses"), FT-18R program
 * step 0 (see vibe_tavern_plan/reports/FLY_TRIBUNAL_LEARNABILITY_RESEARCH.md).
 *
 * Calibration-first: nothing here is wired into the product path. The live
 * wiring keeps the FT-7 default hash nose (engine default); the calibration
 * matrix builds engines with these noses to test whether the stimulus
 * representation — not the labels or the learning rule — explains the FT-18
 * chance-level result.
 *
 * Two variants live here:
 * - `createStyleNose` — interpretable style/structure features, one channel
 *   per feature, directly targeting the declared defect classes (verbosity,
 *   inner monologue instead of a reply, duplication, tag leakage, dialogue
 *   collapse). Registry entries carry human-readable feature ids, so verdict
 *   evidence from this nose names features, not opaque hashes.
 * - `createPrecomputedVectorNose` — adapter over pre-computed embedding
 *   vectors (e.g. a local MiniLM run offline by the calibration harness).
 *   The engine's evaluate() is synchronous, so the async embedder runs once
 *   per corpus beforehand and this nose looks vectors up by exact text.
 */

import { tokenizeFlyText, type FlyNose, type FlyStimulusEncoding } from "./fly-engine-core.js";

// ─── Style/structure feature nose ────────────────────────────────────────────

interface FlyStyleFeature {
  /** Stable human-readable id — also the registry/evidence label. */
  readonly id: string;
  /** Unbounded raw measurement. */
  readonly measure: (text: string, tokens: readonly string[]) => number;
  /** Monotone squash of the raw value into [0, 1]. */
  readonly squash: (raw: number) => number;
}

const clamp01 = (value: number): number => (value <= 0 ? 0 : value >= 1 ? 1 : value);
const capAt = (scale: number): ((raw: number) => number) => (raw) => clamp01(raw / scale);

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function splitSentences(text: string): string[] {
  return text
    .split(/[.!?…]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function splitLines(text: string): string[] {
  return text
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Share of the text's characters covered by the given regex matches. */
function matchCharShare(text: string, pattern: RegExp): number {
  if (text.length === 0) return 0;
  let covered = 0;
  for (const match of text.matchAll(pattern)) covered += match[0].length;
  return clamp01(covered / text.length);
}

/** Share of tokens covered by 5-grams that occur more than once. */
function repeatedFiveGramShare(tokens: readonly string[]): number {
  if (tokens.length < 10) return 0;
  const counts = new Map<string, number>();
  for (let start = 0; start + 5 <= tokens.length; start += 1) {
    const gram = tokens.slice(start, start + 5).join(" ");
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let repeatedTokens = 0;
  for (const [gram, count] of counts) {
    if (count < 2) continue;
    repeatedTokens += count * gram.split(" ").length;
  }
  return clamp01(repeatedTokens / tokens.length);
}

/** Share of characters in paragraphs that appear (normalized) more than once. */
function duplicatedParagraphShare(text: string): number {
  if (text.length === 0) return 0;
  const groups = new Map<string, { length: number; count: number }>();
  for (const paragraph of splitParagraphs(text)) {
    const key = paragraph.toLowerCase().replace(/\s+/g, " ");
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { length: paragraph.length, count: 1 });
    else group.count += 1;
  }
  let duplicated = 0;
  for (const group of groups.values()) {
    if (group.count > 1) duplicated += (group.count - 1) * group.length;
  }
  return clamp01(duplicated / text.length);
}

/** Letter-script and case profile over all Unicode letters. */
function letterProfile(text: string): { cyrillic: number; latin: number; uppercase: number } {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return { cyrillic: 0, latin: 0, uppercase: 0 };
  let cyrillic = 0;
  let latin = 0;
  let uppercase = 0;
  for (const letter of letters) {
    if (/[а-яё]/i.test(letter)) cyrillic += 1;
    else if (/[a-z]/i.test(letter)) latin += 1;
    if (letter !== letter.toLowerCase()) uppercase += 1;
  }
  return { cyrillic: cyrillic / letters.length, latin: latin / letters.length, uppercase: uppercase / letters.length };
}

/**
 * The feature list IS the channel layout: index = channel. The order is part
 * of the encoding contract — appending is safe, reordering breaks persisted
 * comparability between calibration runs.
 */
const FLY_STYLE_FEATURES: readonly FlyStyleFeature[] = [
  { id: "length:chars", measure: (text) => text.length, squash: capAt(6000) },
  { id: "length:tokens", measure: (_text, tokens) => tokens.length, squash: capAt(1200) },
  { id: "structure:paragraphs", measure: (text) => splitParagraphs(text).length, squash: capAt(40) },
  { id: "structure:sentences", measure: (text) => splitSentences(text).length, squash: capAt(60) },
  {
    id: "structure:mean-sentence-tokens",
    measure: (text, tokens) => {
      const sentences = splitSentences(text);
      return sentences.length === 0 ? 0 : tokens.length / sentences.length;
    },
    squash: capAt(60),
  },
  { id: "structure:newline-density", measure: (text) => (text.match(/\n/g) ?? []).length / Math.max(1, text.length), squash: capAt(0.2) },
  { id: "structure:unterminated-tail", measure: (text) => {
    const trimmed = text.trimEnd();
    if (trimmed.length === 0) return 0;
    return /[.!?…"'»”]/.test(trimmed.at(-1)!) ? 0 : 1;
  }, squash: clamp01 },
  { id: "dialogue:quote-ratio", measure: (text) => matchCharShare(text, /"[^"\n]*"|«[^»\n]*»|“[^”\n]*”/g), squash: clamp01 },
  { id: "dialogue:dash-line-ratio", measure: (text) => {
    if (text.length === 0) return 0;
    const lines = splitLines(text);
    if (lines.length === 0) return 0;
    const dialogue = lines.filter((line) => /^[—–]\s/.test(line));
    return clamp01(dialogue.reduce((total, line) => total + line.length, 0) / text.length);
  }, squash: clamp01 },
  { id: "monologue:italic-ratio", measure: (text) => matchCharShare(text, /\*[^*\n]+\*|_[^_\n]+_/g), squash: clamp01 },
  { id: "monologue:paren-ratio", measure: (text) => matchCharShare(text, /\([^)\n]*\)/g), squash: clamp01 },
  { id: "repetition:five-gram-share", measure: (_text, tokens) => repeatedFiveGramShare(tokens), squash: clamp01 },
  {
    id: "repetition:distinct-token-ratio",
    measure: (_text, tokens) => (tokens.length === 0 ? 0 : new Set(tokens).size / tokens.length),
    squash: clamp01,
  },
  { id: "repetition:paragraph-duplicate", measure: (text) => duplicatedParagraphShare(text), squash: clamp01 },
  { id: "technical:tag-leak", measure: (text) => matchCharShare(text, /<\/?[a-z_][\w-]*|\[[^\]\n]{0,40}\]/gi), squash: clamp01 },
  {
    id: "technical:markdown-line-ratio",
    measure: (text) => {
      const lines = splitLines(text);
      if (lines.length === 0) return 0;
      const structured = lines.filter((line) => /^\s*(?:#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s)/.test(line));
      return structured.length / lines.length;
    },
    squash: clamp01,
  },
  { id: "punctuation:ellipsis-per-sentence", measure: (text) => {
    const sentences = splitSentences(text);
    return sentences.length === 0 ? 0 : (text.match(/…|\.\.\./g) ?? []).length / sentences.length;
  }, squash: capAt(3) },
  { id: "punctuation:exclaim-per-sentence", measure: (text) => {
    const sentences = splitSentences(text);
    return sentences.length === 0 ? 0 : (text.match(/!/g) ?? []).length / sentences.length;
  }, squash: capAt(3) },
  { id: "punctuation:question-per-sentence", measure: (text) => {
    const sentences = splitSentences(text);
    return sentences.length === 0 ? 0 : (text.match(/\?/g) ?? []).length / sentences.length;
  }, squash: capAt(3) },
  { id: "script:cyrillic-ratio", measure: (text) => letterProfile(text).cyrillic, squash: clamp01 },
  { id: "script:latin-ratio", measure: (text) => letterProfile(text).latin, squash: clamp01 },
  { id: "script:uppercase-ratio", measure: (text) => letterProfile(text).uppercase, squash: clamp01 },
];

export const FLY_STYLE_NOSE_CHANNEL_COUNT = FLY_STYLE_FEATURES.length;

/**
 * Interpretable style/structure nose. Unlike the hash nose there is NO
 * max-normalization: every feature is individually squashed to [0, 1], so a
 * monologue ratio of 0.9 stays 0.9 regardless of what other features fire —
 * absolute calibration is the point of this representation.
 */
export function createStyleNose(): FlyNose {
  return {
    channelCount: FLY_STYLE_NOSE_CHANNEL_COUNT,
    encode(text: string): FlyStimulusEncoding {
      const channels = new Float32Array(FLY_STYLE_NOSE_CHANNEL_COUNT);
      // Blank texts encode to silence (hash-nose semantics: no tokens, no KCs) —
      // a whitespace-only message must not drive a WTA code off its length.
      if (text.trim().length === 0) {
        return {
          channels,
          registry: FLY_STYLE_FEATURES.map((feature, channel) => ({
            ngram: feature.id,
            channel,
            count: 0,
            activation: 0,
          })),
        };
      }
      const tokens = tokenizeFlyText(text);
      const registry = FLY_STYLE_FEATURES.map((feature, channel) => {
        const raw = feature.measure(text, tokens);
        const activation = feature.squash(raw);
        channels[channel] = activation;
        return { ngram: feature.id, channel, count: Math.round(raw * 10_000) / 10_000, activation };
      });
      return { channels, registry };
    },
  };
}

// ─── Pre-computed embedding-vector nose ─────────────────────────────────────

/**
 * Adapter over vectors computed in advance (the engine's evaluate() is
 * synchronous, so an async local embedder runs once per corpus and this nose
 * looks results up by exact text). Unknown texts encode to silence — zero
 * channels, empty registry — never a fabricated vector.
 */
export function createPrecomputedVectorNose(
  vectors: ReadonlyMap<string, readonly number[]>,
  channelCount: number,
): FlyNose {
  if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > 100_000) {
    throw new Error("Fly vector nose channel count must be an integer in [1, 100000].");
  }
  for (const [text, vector] of vectors) {
    if (vector.length !== channelCount) {
      throw new Error(`Fly vector nose vector for text length ${text.length} has ${vector.length} dims, expected ${channelCount}.`);
    }
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new Error("Fly vector nose vectors must be finite.");
    }
  }
  return {
    channelCount,
    encode(text: string): FlyStimulusEncoding {
      const channels = new Float32Array(channelCount);
      const vector = vectors.get(text);
      if (vector === undefined) return { channels, registry: [] };
      let norm = 0;
      for (const value of vector) norm += value * value;
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let index = 0; index < channelCount; index += 1) {
          channels[index] = vector[index]! / norm;
        }
      }
      const registry = [];
      for (let index = 0; index < channelCount; index += 1) {
        const value = channels[index]!;
        if (value === 0) continue;
        registry.push({ ngram: `dim:${index}`, channel: index, count: vector[index]!, activation: value });
      }
      return { channels, registry };
    },
  };
}
