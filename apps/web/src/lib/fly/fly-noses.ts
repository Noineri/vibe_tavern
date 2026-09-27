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
 * Four variants live here:
 * - `createStyleNose` — interpretable style/structure features, one channel
 *   per feature, directly targeting the declared defect classes (verbosity,
 *   inner monologue instead of a reply, duplication, tag leakage, dialogue
 *   collapse). Registry entries carry human-readable feature ids, so verdict
 *   evidence from this nose names features, not opaque hashes.
 * - `createPrecomputedVectorNose` — adapter over pre-computed embedding
 *   vectors (e.g. a local MiniLM run offline by the calibration harness).
 *   The engine's evaluate() is synchronous, so the async embedder runs once
 *   per corpus beforehand and this nose looks vectors up by exact text.
 * - `createCharHashNose` (candidate E, 2026-09-27 external consultation) —
 *   character 3–5-gram hash: encodes the surface layer (punctuation,
 *   whitespace, leaked tags, truncation, morphology) that word tokens
 *   collapse away; absolute `log` calibration by default.
 * - `createMultiViewNose` (candidate F) — char family + word family + style
 *   features in one channel vector, each family normalized WITHIN itself so
 *   a strong family cannot erase another's evidence (no cross-family max).
 */

import {
  applyFlyHashNormalization,
  encodeHashStimulus,
  hashNgram,
  tokenizeFlyText,
  type FlyHashNormalization,
  type FlyNgramRegistryEntry,
  type FlyNose,
  type FlyStimulusEncoding,
} from "./fly-engine-core.js";

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

export const FLY_STYLE_BUCKET_THRESHOLDS = [0.05, 0.15, 0.35] as const;

/** Total style-view channels: one raw channel per feature + one thermometer
 * bucket per (feature, threshold). Layout is [raw 22 | buckets 66] so the
 * first 22 channels keep their v1 meaning and ordering. */
export const FLY_STYLE_NOSE_CHANNEL_COUNT =
  FLY_STYLE_FEATURES.length * (1 + FLY_STYLE_BUCKET_THRESHOLDS.length);

/**
 * Interpretable style/structure nose. Unlike the hash nose there is NO
 * max-normalization: every feature is individually squashed to [0, 1], so a
 * monologue ratio of 0.9 stays 0.9 regardless of what other features fire —
 * absolute calibration is the point of this representation.
 *
 * v2 (FT-18R, 2026-09-27 code-sensitivity diagnosis): every feature also
 * drives threshold bucket channels (1.0 when the squashed value crosses the
 * threshold). A single feature jumping (e.g. paragraph duplication 0→0.16)
 * moves only its ONE cohort's KCs in the WTA and the code barely shifts
 * (measured 93.7% same-batch overlap, accuracy 0.557 despite the feature
 * separating 344/344 pairs); crossing thresholds lights up ADDITIONAL PN
 * cohorts, so the KC code actually moves. Bucket channels are binary and
 * appended after the raw block.
 */
export function createStyleNose(): FlyNose {
  return {
    channelCount: FLY_STYLE_NOSE_CHANNEL_COUNT,
    encode: (text: string): FlyStimulusEncoding => encodeStyleView(text),
  };
}

/**
 * Style-feature core shared by `createStyleNose` and the multi-view nose's
 * style family. Blank texts encode to silence (hash-nose semantics: no
 * tokens, no KCs) — a whitespace-only message must not drive a WTA code off
 * its length.
 */
function encodeStyleView(text: string): FlyStimulusEncoding {
  const channels = new Float32Array(FLY_STYLE_NOSE_CHANNEL_COUNT);
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
  const registry: FlyNgramRegistryEntry[] = [];
  for (let channel = 0; channel < FLY_STYLE_FEATURES.length; channel += 1) {
    const feature = FLY_STYLE_FEATURES[channel]!;
    const raw = feature.measure(text, tokens);
    const activation = feature.squash(raw);
    channels[channel] = activation;
    registry.push({ ngram: feature.id, channel, count: Math.round(raw * 10_000) / 10_000, activation });
    for (let bucket = 0; bucket < FLY_STYLE_BUCKET_THRESHOLDS.length; bucket += 1) {
      const threshold = FLY_STYLE_BUCKET_THRESHOLDS[bucket]!;
      const bucketChannel = FLY_STYLE_FEATURES.length + channel * FLY_STYLE_BUCKET_THRESHOLDS.length + bucket;
      const crossed = activation >= threshold ? 1 : 0;
      channels[bucketChannel] = crossed;
      if (crossed === 1) {
        registry.push({
          ngram: `${feature.id}@ge${Math.round(threshold * 100)}`,
          channel: bucketChannel,
          count: 1,
          activation: crossed,
        });
      }
    }
  }
  return { channels, registry };
}

// ─── Character n-gram hash nose (candidate E) ──────────────────────────────

/**
 * Character 3–5-gram source: lowercase text with whitespace runs collapsed
 * to single spaces (platform-stable: CRLF and LF collapse identically), so
 * grams span word boundaries, punctuation, tags, and morphology — exactly
 * the surface differences that word tokens discard.
 */
export function extractCharGrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  for (let width = 3; width <= 5; width += 1) {
    for (let start = 0; start + width <= normalized.length; start += 1) {
      const gram = normalized.slice(start, start + width);
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Hash one gram family into channels: √-damped mass per channel plus the
 * sorted entry list (shared by the char nose and the multi-view char family).
 */
function encodeHashGramFamily(
  gramCounts: ReadonlyMap<string, number>,
  channelCount: number,
  normalization: FlyHashNormalization,
): { channels: Float32Array; entries: Array<{ gram: string; count: number; channel: number }> } {
  const rawChannels = new Float32Array(channelCount);
  const entries = [...gramCounts.entries()]
    .map(([gram, count]) => ({ gram, count, channel: hashNgram(gram) % channelCount }))
    .sort((a, b) => a.gram.localeCompare(b.gram));
  for (const entry of entries) {
    rawChannels[entry.channel] += Math.sqrt(entry.count);
  }
  return { channels: applyFlyHashNormalization(rawChannels, normalization), entries };
}

export interface FlyCharHashNoseOptions {
  /** Hash channels for the char-gram family; default 256. */
  channelCount?: number;
  /** Family normalization; default `log` (absolute calibration). */
  normalization?: FlyHashNormalization;
}

/**
 * Candidate E (FT-18R, external consultation 2026-09-27): character 3–5-gram
 * hash nose. Separates punctuation/whitespace/tag/truncation edits that the
 * word hash provably maps to identical vectors.
 */
export function createCharHashNose(options: FlyCharHashNoseOptions = {}): FlyNose {
  const channelCount = options.channelCount ?? 256;
  const normalization = options.normalization ?? "log";
  assertNoseChannelCount(channelCount, "char hash nose");
  return {
    channelCount,
    encode: (text: string): FlyStimulusEncoding => {
      const family = encodeHashGramFamily(extractCharGrams(text), channelCount, normalization);
      return {
        channels: family.channels,
        registry: family.entries.map((entry) => ({
          ngram: `char:${entry.gram}`,
          channel: entry.channel,
          count: entry.count,
          activation: family.channels[entry.channel]!,
        })),
      };
    },
  };
}

// ─── Multi-view nose (candidate F) ───────────────────────────────────────────

export interface FlyMultiViewNoseOptions {
  /** Char-family hash channels; default 256. */
  charChannels?: number;
  /** Word-family hash channels; default 256. */
  wordChannels?: number;
  /** Normalization for both hash families; default `log`. The style family
   *  is always its own absolute [0, 1] squash. */
  normalization?: FlyHashNormalization;
  /** Family output multipliers (post-normalization); default 1 each. */
  charWeight?: number;
  wordWeight?: number;
  styleWeight?: number;
}

function assertNoseChannelCount(channelCount: number, label: string): void {
  if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > 100_000) {
    throw new Error(`Fly ${label} channel count must be an integer in [1, 100000].`);
  }
}

function assertFamilyWeight(weight: number, label: string): void {
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new Error(`Fly multi-view ${label} weight must be a positive finite number.`);
  }
}

/**
 * Candidate F (FT-18R, external consultation 2026-09-27): the recommended
 * "first practical nose" — char 3–5-grams + word 1–3-grams + the style
 * features in one channel vector, every family scaled WITHIN itself. Channel
 * layout: [char family | word family | style features]; registry entries are
 * prefixed `char:` / `word:` / `style:` so verdict evidence names its family.
 */
export function createMultiViewNose(options: FlyMultiViewNoseOptions = {}): FlyNose {
  const charChannels = options.charChannels ?? 256;
  const wordChannels = options.wordChannels ?? 256;
  const normalization = options.normalization ?? "log";
  const charWeight = options.charWeight ?? 1;
  const wordWeight = options.wordWeight ?? 1;
  const styleWeight = options.styleWeight ?? 1;
  assertNoseChannelCount(charChannels, "multi-view char channels");
  assertNoseChannelCount(wordChannels, "multi-view word channels");
  assertFamilyWeight(charWeight, "char");
  assertFamilyWeight(wordWeight, "word");
  assertFamilyWeight(styleWeight, "style");
  const wordOffset = charChannels;
  const styleOffset = charChannels + wordChannels;
  const channelCount = styleOffset + FLY_STYLE_NOSE_CHANNEL_COUNT;
  return {
    channelCount,
    encode: (text: string): FlyStimulusEncoding => {
      const channels = new Float32Array(channelCount);
      const registry: FlyNgramRegistryEntry[] = [];

      const charFamily = encodeHashGramFamily(extractCharGrams(text), charChannels, normalization);
      for (let channel = 0; channel < charChannels; channel += 1) {
        channels[channel] = charFamily.channels[channel]! * charWeight;
      }
      for (const entry of charFamily.entries) {
        registry.push({
          ngram: `char:${entry.gram}`,
          channel: entry.channel,
          count: entry.count,
          activation: channels[entry.channel]!,
        });
      }

      const wordFamily = encodeHashStimulus(text, wordChannels, normalization);
      for (let channel = 0; channel < wordChannels; channel += 1) {
        channels[wordOffset + channel] = wordFamily.channels[channel]! * wordWeight;
      }
      for (const entry of wordFamily.registry) {
        registry.push({
          ngram: `word:${entry.ngram}`,
          channel: wordOffset + entry.channel,
          count: entry.count,
          activation: channels[wordOffset + entry.channel]!,
        });
      }

      const styleView = encodeStyleView(text);
      for (let channel = 0; channel < FLY_STYLE_NOSE_CHANNEL_COUNT; channel += 1) {
        channels[styleOffset + channel] = styleView.channels[channel]! * styleWeight;
      }
      for (const entry of styleView.registry) {
        registry.push({
          ngram: `style:${entry.ngram}`,
          channel: styleOffset + entry.channel,
          count: entry.count,
          activation: channels[styleOffset + entry.channel]!,
        });
      }

      return { channels, registry };
    },
  };
}

// ─── Style + embedder hybrid nose (candidate G) ──────────────────────────

export interface FlyStyleEmbedNoseOptions {
  /** Family output multipliers (post-normalization); default 1 each. */
  styleWeight?: number;
  vectorWeight?: number;
}

/**
 * Candidate G (owner 2026-09-27, «можно и то и другое включить»): the style
 * features + precomputed embedding dims in one channel vector. Each family
 * is L1-normalized to unit activation mass per text, so at weight 1 both
 * families contribute equally regardless of channel count; weights
 * rebalance. Layout: [style features | embedding dims]; registry entries are
 * prefixed `style:` / `emb:`. A text without a precomputed vector encodes the
 * style family only — the vector family stays silent, never fabricated.
 */
export function createStyleEmbedNose(
  vectors: ReadonlyMap<string, readonly number[]>,
  dims: number,
  options: FlyStyleEmbedNoseOptions = {},
): FlyNose {
  const styleWeight = options.styleWeight ?? 1;
  const vectorWeight = options.vectorWeight ?? 1;
  assertFamilyWeight(styleWeight, "style");
  assertFamilyWeight(vectorWeight, "vector");
  if (!Number.isInteger(dims) || dims < 1 || dims > 100_000) {
    throw new Error("Fly style+embed nose dims must be an integer in [1, 100000].");
  }
  const channelCount = FLY_STYLE_NOSE_CHANNEL_COUNT + dims;
  return {
    channelCount,
    encode: (text: string): FlyStimulusEncoding => {
      const channels = new Float32Array(channelCount);
      const registry: FlyNgramRegistryEntry[] = [];

      const styleView = encodeStyleView(text);
      let styleMass = 0;
      for (let channel = 0; channel < FLY_STYLE_NOSE_CHANNEL_COUNT; channel += 1) {
        styleMass += Math.abs(styleView.channels[channel]!);
      }
      const styleScale = styleMass > 0 ? 1 / styleMass : 0;
      for (let channel = 0; channel < FLY_STYLE_NOSE_CHANNEL_COUNT; channel += 1) {
        channels[channel] = styleView.channels[channel]! * styleScale * styleWeight;
      }
      for (const entry of styleView.registry) {
        registry.push({
          ngram: `style:${entry.ngram}`,
          channel: entry.channel,
          count: entry.count,
          activation: channels[entry.channel]!,
        });
      }

      const vector = vectors.get(text);
      if (vector !== undefined) {
        const offset = FLY_STYLE_NOSE_CHANNEL_COUNT;
        let vectorMass = 0;
        for (const value of vector) vectorMass += Math.abs(value);
        const vectorScale = vectorMass > 0 ? 1 / vectorMass : 0;
        for (let index = 0; index < dims; index += 1) {
          channels[offset + index] = vector[index]! * vectorScale * vectorWeight;
        }
        for (let index = 0; index < dims; index += 1) {
          const value = channels[offset + index]!;
          if (value === 0) continue;
          registry.push({ ngram: `emb:${index}`, channel: offset + index, count: vector[index]!, activation: value });
        }
      }

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
