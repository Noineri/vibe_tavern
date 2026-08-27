import { describe, expect, test } from "bun:test";
import {
  KOKORO_LANGS,
  KOKORO_VOICES,
  KOKORO_VOICES_BY_ID,
  listKokoroVoices,
  resolveKokoroVoice,
  tryResolveKokoroVoice,
} from "./kokoro-voices.js";
import { KokoroVoiceNotFoundError } from "./kokoro/kokoro-errors.js";

describe("kokoro-voices manifest", () => {
  test("has exactly 54 voices", () => {
    expect(KOKORO_VOICES).toHaveLength(54);
  });

  test("all ids are unique", () => {
    const ids = KOKORO_VOICES.map((v) => v.id);
    expect(new Set(ids).size).toBe(54);
  });

  test("every lang code in KOKORO_LANGS has at least one voice", () => {
    for (const code of Object.keys(KOKORO_LANGS) as Array<keyof typeof KOKORO_LANGS>) {
      const voices = listKokoroVoices(code);
      expect(voices.length).toBeGreaterThan(0);
    }
  });

  test("resolveKokoroVoice returns correct voice for known id", () => {
    const heart = resolveKokoroVoice("af_heart");
    expect(heart.id).toBe("af_heart");
    expect(heart.lang).toBe("a");
    expect(heart.grade).toBe("A");
    expect(heart.gender).toBe("female");
  });

  test("af_bella grade is A-", () => {
    expect(resolveKokoroVoice("af_bella").grade).toBe("A-");
  });

  test("resolveKokoroVoice throws KokoroVoiceNotFoundError for unknown id", () => {
    expect(() => resolveKokoroVoice("af_nope")).toThrow(KokoroVoiceNotFoundError);
    try {
      resolveKokoroVoice("af_nope");
    } catch (e) {
      expect(e).toBeInstanceOf(KokoroVoiceNotFoundError);
      expect((e as KokoroVoiceNotFoundError).voiceId).toBe("af_nope");
    }
  });

  test("tryResolveKokoroVoice returns null for unknown id", () => {
    expect(tryResolveKokoroVoice("nope")).toBeNull();
  });

  test("tryResolveKokoroVoice returns voice for known id", () => {
    const v = tryResolveKokoroVoice("bf_emma");
    expect(v?.id).toBe("bf_emma");
    expect(v?.lang).toBe("b");
  });

  test("listKokoroVoices('b') returns exactly 8 British voices, all lang b", () => {
    const british = listKokoroVoices("b");
    expect(british).toHaveLength(8);
    for (const v of british) expect(v.lang).toBe("b");
  });

  test("KOKORO_VOICES_BY_ID is consistent with KOKORO_VOICES", () => {
    expect(KOKORO_VOICES_BY_ID.size).toBe(54);
    for (const v of KOKORO_VOICES) {
      expect(KOKORO_VOICES_BY_ID.get(v.id)).toEqual(v);
    }
  });

  test("listKokoroVoices() without filter returns stable manifest order copy", () => {
    const all = listKokoroVoices();
    expect(all).toHaveLength(54);
    expect(all[0]?.id).toBe(KOKORO_VOICES[0]?.id);
    // Shallow copy — mutating the returned array must not affect the manifest.
    all.pop();
    expect(KOKORO_VOICES).toHaveLength(54);
  });
});
