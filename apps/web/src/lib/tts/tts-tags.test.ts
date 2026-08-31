import { describe, expect, test } from "bun:test";

import {
  TTS_ANNOTATION_TAGS,
  extractTtsTags,
  mapTtsTagsForDialect,
  reinsertTtsTags,
  ttsTagDialectForProfile,
  ttsTagToken,
} from "./tts-tags.js";

describe("tts-tags — canonical set", () => {
  test("the owner-spec 8-tag set, stable order", () => {
    expect([...TTS_ANNOTATION_TAGS]).toEqual([
      "laugh",
      "sigh",
      "chuckle",
      "cough",
      "sniffle",
      "groan",
      "yawn",
      "gasp",
    ]);
    expect(ttsTagToken("laugh")).toBe("[laugh]");
  });
});

describe("tts-tags — extract / reinsert", () => {
  test("extraction records tags with their next-word anchors and strips tokens", () => {
    const { text, tags } = extractTtsTags('She [laugh] softly. "Wait," he [sigh] said.');
    expect(text).toBe('She  softly. "Wait," he  said.');
    expect(tags).toEqual([
      { tag: "laugh", anchor: "softly" },
      { tag: "sigh", anchor: "said" },
    ]);
  });

  test("trailing tag has no anchor and re-attaches at the end", () => {
    const { text, tags } = extractTtsTags("Hello there [gasp]");
    expect(tags).toEqual([{ tag: "gasp", anchor: null }]);
    expect(reinsertTtsTags(text.trim(), tags)).toBe("Hello there [gasp]");
  });

  test("reinsertion before anchors keeps tag order and spacing clean", () => {
    const out = reinsertTtsTags("She said softly he said", [
      { tag: "laugh", anchor: "softly" },
      { tag: "sigh", anchor: "said" },
    ]);
    // Each tag lands immediately before its anchor word — the word the sound
    // colored in the original — regardless of other identical words earlier
    // in the text (cursor advances past matched anchors).
    expect(out).toBe("She said [laugh] softly he [sigh] said");
  });

  test("anchor dropped by a filter → tag falls to the end, order kept", () => {
    const out = reinsertTtsTags("Only quoted text survives", [
      { tag: "laugh", anchor: "dropped" },
      { tag: "gasp", anchor: "gone" },
    ]);
    expect(out).toBe("Only quoted text survives [laugh] [gasp]");
  });

  test("non-canonical brackets are left alone (not tags)", () => {
    const { text, tags } = extractTtsTags("Stage direction [opens the door] stays.");
    expect(tags).toEqual([]);
    expect(text).toBe("Stage direction [opens the door] stays.");
  });

  test("uppercase variants are NOT canonical (prompt contract says lowercase)", () => {
    const { tags } = extractTtsTags("No [LAUGH] here");
    expect(tags).toEqual([]);
  });
});

describe("tts-tags — dialect mapping", () => {
  test("orpheus: bracket tokens become angle-bracket inline tags", () => {
    expect(mapTtsTagsForDialect("Well [laugh] I never [sigh]", "orpheus")).toBe(
      "Well <laugh> I never <sigh>",
    );
  });

  test("chatterbox: canonical brackets are already its native form (verbatim)", () => {
    expect(mapTtsTagsForDialect("Well [laugh] I never", "chatterbox")).toBe("Well [laugh] I never");
  });

  test("strip: tokens removed entirely — never spoken as words, punctuation stays attached", () => {
    expect(mapTtsTagsForDialect("Well [laugh] I never [sigh]...", "strip")).toBe("Well I never...");
  });

  test("inworld: documented non-verbals pass verbatim, chuckle→laugh, undocumented tags strip", () => {
    // [laugh] [sigh] [cough] [yawn] are documented steering non-verbals.
    expect(mapTtsTagsForDialect("Well [laugh] I never [sigh]", "inworld")).toBe("Well [laugh] I never [sigh]");
    expect(mapTtsTagsForDialect("[cough] Ahem. [yawn] Tired.", "inworld")).toBe("[cough] Ahem. [yawn] Tired.");
    // chuckle maps to the nearest documented non-verbal.
    expect(mapTtsTagsForDialect("He [chuckle] nodded", "inworld")).toBe("He [laugh] nodded");
    // sniffle/groan/gasp have no documented equivalent — stripped, never spoken.
    expect(mapTtsTagsForDialect("She [sniffle] [groan] sat [gasp] down", "inworld")).toBe("She sat down");
    expect(mapTtsTagsForDialect("Ugh [gasp]!", "inworld")).toBe("Ugh!");
  });
});

describe("tts-tags — dialect resolution is fact-based", () => {
  test("openai-compatible + orpheus model → orpheus dialect", () => {
    expect(
      ttsTagDialectForProfile({ backend: "openai-compatible", config: { model: "orpheus-3b-0.1-ft" } }),
    ).toBe("orpheus");
  });

  test("openai-compatible + chatterbox model → chatterbox dialect (live field-test id)", () => {
    expect(
      ttsTagDialectForProfile({ backend: "openai-compatible", config: { model: "chatterbox-tts-1" } }),
    ).toBe("chatterbox");
  });

  test("openai-compatible + unknown model → strip (no documented tag engine)", () => {
    expect(ttsTagDialectForProfile({ backend: "openai-compatible", config: { model: "tts-1" } })).toBe("strip");
    expect(ttsTagDialectForProfile({ backend: "openai-compatible", config: {} })).toBe("strip");
  });

  test("every other backend strips (kokoro / elevenlabs / gemini)", () => {
    expect(ttsTagDialectForProfile({ backend: "kokoro", config: {} })).toBe("strip");
    expect(ttsTagDialectForProfile({ backend: "elevenlabs", config: {} })).toBe("strip");
    expect(ttsTagDialectForProfile({ backend: "gemini", config: {} })).toBe("strip");
  });

  test("inworld: the dialect is gated to the tts-2 model family (steering is fully supported there only)", () => {
    expect(ttsTagDialectForProfile({ backend: "inworld", config: { modelId: "inworld-tts-2" } })).toBe("inworld");
    expect(ttsTagDialectForProfile({ backend: "inworld", config: { modelId: "inworld-tts-1.5-max" } })).toBe("strip");
    expect(ttsTagDialectForProfile({ backend: "inworld", config: { modelId: "inworld-tts-1" } })).toBe("strip");
    expect(ttsTagDialectForProfile({ backend: "inworld", config: {} })).toBe("strip");
  });
});
