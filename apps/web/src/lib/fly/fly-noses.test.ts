import { describe, expect, test } from "bun:test";
import { createHashNose, encodeFlyStimulus, encodeHashStimulus } from "./fly-engine-core.js";
import {
  createCharHashNose,
  createMultiViewNose,
  createPrecomputedVectorNose,
  createStyleEmbedNose,
  createStyleNose,
  FLY_STYLE_NOSE_CHANNEL_COUNT,
} from "./fly-noses.js";

/**
 * FT-18R experimental noses (see fly-noses.ts). Pure logic tests — no
 * connectome, no fixture build; the engine-side seam behavior lives in
 * fly-engine-core.test.ts.
 *
 * L1 checklist:
 * 1. Paths: none — pure functions only.
 * 2. Restores: no globals, registries, env, or mocks are touched.
 * 3. Determinism: every assertion reads a completed pure computation.
 * 4. Platform: no paths, separators, or OS assumptions.
 * 5. Shared worker pool: no module mocks or mutable global state.
 * 6. Stable state: assertions inspect returned encodings only.
 */

function featureActivation(encoding: { registry: Array<{ ngram: string; activation: number }> }, id: string): number {
  const entry = encoding.registry.find((candidate) => candidate.ngram === id);
  if (entry === undefined) throw new Error(`Style feature ${id} missing from the registry.`);
  return entry.activation;
}

describe("FT-18R style nose", () => {
  test("is deterministic, covers every feature channel, and stays in [0, 1]", () => {
    const nose = createStyleNose();
    const text = "— Привет, — сказала она, глядя в окно.\n\n*Он не ответил, продолжая писать.* Что-то здесь не так…";
    const first = nose.encode(text);
    const repeat = nose.encode(text);

    expect(nose.channelCount).toBe(FLY_STYLE_NOSE_CHANNEL_COUNT);
    expect(Array.from(first.channels)).toEqual(Array.from(repeat.channels));
    expect(first.registry.map((entry) => entry.ngram)).toEqual(repeat.registry.map((entry) => entry.ngram));
    expect(first.channels.length).toBe(FLY_STYLE_NOSE_CHANNEL_COUNT);
    // 22 raw feature entries + exactly one entry per crossed bucket channel.
    const rawCount = first.registry.filter((entry) => !entry.ngram.includes("@")).length;
    const bucketCount = first.registry.filter((entry) => entry.ngram.includes("@")).length;
    expect(rawCount).toBe(22);
    expect(bucketCount).toBe(
      Array.from(first.channels).slice(22).filter((value) => value === 1).length,
    );
    for (const value of first.channels) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  test("thermometer buckets fire on threshold crossings and keep raw layout stable", () => {
    const nose = createStyleNose();
    // The duplicated paragraph IS the longest (0.42 of the text) — all three
    // thresholds cross: @ge5, @ge15, @ge35 fire in order.
    const base = "One short paragraph.\n\nSecond paragraph with more words in it than the first one has.";
    const duplicated = `${base}\n\nSecond paragraph with more words in it than the first one has.`;
    const encoding = nose.encode(duplicated);
    const rawIndex = encoding.registry.findIndex((entry) => entry.ngram === "repetition:paragraph-duplicate");
    const rawValue = encoding.registry[rawIndex]!.activation;
    expect(rawValue).toBeGreaterThan(0.35);
    const bucketIds = encoding.registry
      .filter((entry) => entry.ngram.startsWith("repetition:paragraph-duplicate@"))
      .map((entry) => entry.ngram);
    expect(bucketIds).toEqual([
      "repetition:paragraph-duplicate@ge5",
      "repetition:paragraph-duplicate@ge15",
      "repetition:paragraph-duplicate@ge35",
    ]);
    // Clean text fires no repetition buckets at all.
    const clean = nose.encode(base);
    expect(clean.registry.some((entry) => entry.ngram.includes("repetition:paragraph-duplicate@"))).toBe(false);
    // v1 compatibility: the first 22 channels are the raw feature values.
    expect(clean.registry.filter((entry) => !entry.ngram.includes("@")).every((entry) => entry.channel < 22)).toBe(true);
  });

  test("separates a verbose italic-monologue wall from terse dash dialogue", () => {
    const nose = createStyleNose();
    const monologue = nose.encode(
      Array.from({ length: 6 }, () => "*Он долго и мучительно размышлял о смысле каждого сказанного слова, взвешивая всё*").join(" "),
    );
    const dialogue = nose.encode("— Да.\n\n— Нет.\n\n— Как знаешь.");

    expect(featureActivation(monologue, "monologue:italic-ratio")).toBeGreaterThan(0.5);
    expect(featureActivation(dialogue, "monologue:italic-ratio")).toBe(0);
    expect(featureActivation(dialogue, "dialogue:dash-line-ratio")).toBeGreaterThan(0.5);
    expect(featureActivation(monologue, "dialogue:dash-line-ratio")).toBe(0);
    expect(featureActivation(monologue, "length:chars")).toBeGreaterThan(featureActivation(dialogue, "length:chars"));
  });

  test("flags tag leakage, paragraph duplication, and unterminated tails", () => {
    const nose = createStyleNose();
    const leak = nose.encode("Она улыбнулась.\n</reasoning_\n[End of Response]");
    expect(featureActivation(leak, "technical:tag-leak")).toBeGreaterThan(0.1);

    const paragraph = "Дождь стучал по крыше, и свет в комнате дрожал.";
    const duplicated = nose.encode(`${paragraph}\n\n${paragraph}\n\n${paragraph}`);
    const nearMiss = nose.encode(`${paragraph}\n\n${paragraph.replace("дрожал", "мерцал")} и гас.`);
    const duplication = featureActivation(duplicated, "repetition:paragraph-duplicate");
    expect(duplication).toBeGreaterThan(0.4);
    expect(featureActivation(nearMiss, "repetition:paragraph-duplicate")).toBeLessThan(duplication);

    const truncated = nose.encode("Она подняла глаза и тихо сказ");
    expect(featureActivation(truncated, "structure:unterminated-tail")).toBe(1);
    expect(featureActivation(nose.encode("Она подняла глаза и тихо сказала."), "structure:unterminated-tail")).toBe(0);
  });

  test("empty text encodes to honest silence", () => {
    const encoding = createStyleNose().encode("   ");
    expect(Array.from(encoding.channels).every((value) => value === 0)).toBe(true);
    expect(encoding.registry.every((entry) => entry.activation === 0)).toBe(true);
    expect(encoding.registry.some((entry) => entry.ngram.includes("@"))).toBe(false);
  });
});

describe("FT-18R char hash nose (candidate E)", () => {
  test("is deterministic, honors channel count, and blanks to silence", () => {
    const nose = createCharHashNose({ channelCount: 128 });
    const text = "— Привет! Как твои дела? Хорошо…";
    const first = nose.encode(text);
    const repeat = nose.encode(text);

    expect(nose.channelCount).toBe(128);
    expect(first.channels.length).toBe(128);
    expect(Array.from(first.channels)).toEqual(Array.from(repeat.channels));
    expect(first.registry.length).toBeGreaterThan(0);
    expect(first.registry.every((entry) => entry.ngram.startsWith("char:"))).toBe(true);

    const silence = nose.encode("   ");
    expect(Array.from(silence.channels).every((value) => value === 0)).toBe(true);
    expect(silence.registry).toEqual([]);
  });

  test("separates punctuation-only edits the word nose maps to identical vectors", () => {
    const full = "Привет! Как дела?";
    const edited = "Привет!!  Как дела???";
    const wordFull = encodeFlyStimulus(full);
    const wordEdited = encodeFlyStimulus(edited);
    expect(Array.from(wordFull.channels)).toEqual(Array.from(wordEdited.channels));

    const nose = createCharHashNose({ channelCount: 64 });
    expect(Array.from(nose.encode(full).channels)).not.toEqual(Array.from(nose.encode(edited).channels));
  });

  test("log normalization is absolutely calibrated; max stretches per message", () => {
    const text = "abcdef";
    const log = createCharHashNose({ channelCount: 256, normalization: "log" }).encode(text);
    const max = createCharHashNose({ channelCount: 256, normalization: "max" }).encode(text);
    const logTop = Math.max(...Array.from(log.channels));
    expect(logTop).toBeGreaterThan(0);
    expect(logTop).toBeLessThan(1);
    expect(Math.max(...Array.from(max.channels))).toBe(1);
  });
});

describe("FT-18R multi-view nose (candidate F)", () => {
  const text = "— Стой, — сказал он. *Рука дрогнула, но он смолчал.*\n\n— Ну, говори.";

  test("concatenates families, each scaled within itself", () => {
    const nose = createMultiViewNose({ charChannels: 100, wordChannels: 80, normalization: "log" });
    expect(nose.channelCount).toBe(100 + 80 + FLY_STYLE_NOSE_CHANNEL_COUNT);
    const encoding = nose.encode(text);
    expect(encoding.channels.length).toBe(nose.channelCount);

    const pureChar = createCharHashNose({ channelCount: 100, normalization: "log" }).encode(text);
    expect(Array.from(encoding.channels.slice(0, 100))).toEqual(Array.from(pureChar.channels));

    const pureWord = encodeHashStimulus(text, 80, "log");
    expect(Array.from(encoding.channels.slice(100, 180))).toEqual(Array.from(pureWord.channels));

    const pureStyle = createStyleNose().encode(text);
    expect(Array.from(encoding.channels.slice(180))).toEqual(Array.from(pureStyle.channels));
  });

  test("registry names the family of every entry", () => {
    const registry = createMultiViewNose().encode(text).registry;
    expect(registry.some((entry) => entry.ngram.startsWith("char:"))).toBe(true);
    expect(registry.some((entry) => entry.ngram.startsWith("word:"))).toBe(true);
    expect(registry.some((entry) => entry.ngram.startsWith("style:"))).toBe(true);
    expect(registry.every((entry) => entry.ngram.startsWith("char:") || entry.ngram.startsWith("word:") || entry.ngram.startsWith("style:"))).toBe(true);
  });

  test("family weights scale their slices; blank text stays silent", () => {
    const doubled = createMultiViewNose({ charChannels: 50, wordChannels: 50, charWeight: 2, styleWeight: 0.5 });
    const plain = createMultiViewNose({ charChannels: 50, wordChannels: 50 });
    const weighted = doubled.encode(text);
    const baseline = plain.encode(text);
    for (let channel = 0; channel < 50; channel += 1) {
      expect(weighted.channels[channel]!).toBeCloseTo(baseline.channels[channel]! * 2, 6);
    }
    for (let channel = 100; channel < 100 + FLY_STYLE_NOSE_CHANNEL_COUNT; channel += 1) {
      expect(weighted.channels[channel]!).toBeCloseTo(baseline.channels[channel]! * 0.5, 6);
    }
    const blank = plain.encode("  ");
    expect(Array.from(blank.channels).every((value) => value === 0)).toBe(true);
  });

  test("rejects invalid options at creation", () => {
    expect(() => createMultiViewNose({ charChannels: 0 })).toThrow(/channel count/);
    expect(() => createMultiViewNose({ wordWeight: 0 })).toThrow(/weight/);
    expect(() => createCharHashNose({ channelCount: 1.5 })).toThrow(/channel count/);
  });
});

describe("FT-18R hash-nose normalization axis", () => {
  test("default stays max and bit-identical to the product encoder; modes differ", () => {
    const repeated = "Она молчала. Она молчала. Она молчала.";
    const defaultNose = createHashNose(64).encode(repeated);
    const explicitMax = createHashNose(64, "max").encode(repeated);
    expect(Array.from(defaultNose.channels)).toEqual(Array.from(explicitMax.channels));

    const fifty = createHashNose(50, "max").encode(repeated);
    expect(Array.from(fifty.channels)).toEqual(Array.from(encodeFlyStimulus(repeated).channels));

    const logEncoding = createHashNose(64, "log").encode(repeated);
    expect(Array.from(logEncoding.channels)).not.toEqual(Array.from(explicitMax.channels));

    const noneEncoding = createHashNose(64, "none").encode(repeated);
    expect(Math.max(...Array.from(noneEncoding.channels))).toBeGreaterThan(1);
  });
});

describe("FT-18R pre-computed vector nose", () => {
  test("L2-normalizes known vectors and reports their dims in the registry", () => {
    const nose = createPrecomputedVectorNose(new Map([["hello", [3, 4, 0]]]), 3);
    const encoding = nose.encode("hello");
    expect(encoding.channels[0]!).toBeCloseTo(0.6, 6);
    expect(encoding.channels[1]!).toBeCloseTo(0.8, 6);
    expect(encoding.channels[2]!).toBe(0);
    expect(encoding.registry.map((entry) => entry.ngram)).toEqual(["dim:0", "dim:1"]);
    expect(encoding.registry[0]!.activation).toBeCloseTo(0.6, 6);
  });

  test("unknown texts encode to zero channels and an empty registry", () => {
    const nose = createPrecomputedVectorNose(new Map([["known", [1, 0]]]), 2);
    const encoding = nose.encode("never smelled");
    expect(Array.from(encoding.channels)).toEqual([0, 0]);
    expect(encoding.registry).toEqual([]);
  });

  test("rejects dimension mismatches and non-finite vectors at creation", () => {
    expect(() => createPrecomputedVectorNose(new Map([["x", [1, 2]]]), 3)).toThrow(/dims/);
    expect(() => createPrecomputedVectorNose(new Map([["x", [1, Number.NaN]]]), 2)).toThrow(/finite/);
    expect(() => createPrecomputedVectorNose(new Map(), 0)).toThrow(/channel count/);
  });
});

describe("FT-18R style+embedder hybrid nose (candidate G)", () => {
  const text = "*He turned the phrase over once, then let it go — the harbor lights said the rest.* She stayed by the door.";
  const vectors = new Map([[text, [0.5, 0, -1.5]]]);

  function familyMasses(encoding: { channels: Float32Array }): { style: number; embed: number } {
    let style = 0;
    for (let index = 0; index < FLY_STYLE_NOSE_CHANNEL_COUNT; index += 1) style += Math.abs(encoding.channels[index]!);
    let embed = 0;
    for (let index = FLY_STYLE_NOSE_CHANNEL_COUNT; index < encoding.channels.length; index += 1) embed += Math.abs(encoding.channels[index]!);
    return { style, embed };
  }

  test("each family carries unit L1 mass at default weights; registry is prefixed", () => {
    const nose = createStyleEmbedNose(vectors, 3);
    expect(nose.channelCount).toBe(FLY_STYLE_NOSE_CHANNEL_COUNT + 3);
    const encoding = nose.encode(text);
    const masses = familyMasses(encoding);
    expect(masses.style).toBeCloseTo(1, 6);
    expect(masses.embed).toBeCloseTo(1, 6);
    // The vector family splits its mass over |0.5| + |1.5| = 2 → 0.25 / 0.75.
    expect(encoding.channels[FLY_STYLE_NOSE_CHANNEL_COUNT]!).toBeCloseTo(0.25, 6);
    expect(encoding.channels[FLY_STYLE_NOSE_CHANNEL_COUNT + 2]!).toBeCloseTo(-0.75, 6);
    const prefixes = new Set(encoding.registry.map((entry) => entry.ngram.split(":")[0]));
    expect(prefixes.has("style")).toBe(true);
    expect(prefixes.has("emb")).toBe(true);
  });

  test("weights rebalance family mass; unknown texts keep style and drop the vector family", () => {
    const balanced = createStyleEmbedNose(vectors, 3).encode(text);
    const styleHeavy = createStyleEmbedNose(vectors, 3, { styleWeight: 3 }).encode(text);
    const balancedMasses = familyMasses(balanced);
    const heavyMasses = familyMasses(styleHeavy);
    expect(heavyMasses.style).toBeCloseTo(3 * balancedMasses.style, 6);
    expect(heavyMasses.embed).toBeCloseTo(balancedMasses.embed, 6);

    const unknown = createStyleEmbedNose(vectors, 3).encode("a text with no precomputed vector");
    const unknownMasses = familyMasses(unknown);
    expect(unknownMasses.style).toBeCloseTo(1, 6);
    expect(unknownMasses.embed).toBe(0);
    expect(unknown.registry.every((entry) => entry.ngram.startsWith("style:"))).toBe(true);
  });

  test("rejects non-positive weights and invalid dims", () => {
    expect(() => createStyleEmbedNose(vectors, 3, { styleWeight: 0 })).toThrow(/weight/);
    expect(() => createStyleEmbedNose(vectors, 0)).toThrow(/dims/);
  });
});
