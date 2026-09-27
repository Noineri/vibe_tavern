import { describe, expect, test } from "bun:test";
import {
  createPrecomputedVectorNose,
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
    expect(first.registry).toHaveLength(FLY_STYLE_NOSE_CHANNEL_COUNT);
    for (const value of first.channels) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
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
    expect(encoding.registry).toHaveLength(FLY_STYLE_NOSE_CHANNEL_COUNT);
    expect(encoding.registry.every((entry) => entry.activation === 0)).toBe(true);
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
