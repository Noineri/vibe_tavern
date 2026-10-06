import { describe, expect, test } from "bun:test";
import {
  IMAGE_PROMPT_DEFAULT_FAMILY,
  IMAGE_PROMPT_FAMILIES,
  IMAGE_PROMPT_FAMILY_IDS,
  IMAGE_GENERATION_MODES,
  disambiguateSdxlFamily,
  imagePromptCanonFamily,
  matchImagePromptBaseModel,
} from "../src/index.js";

/** IPT Wave 0 — the checkpoint-family registry + the variant-resolution
 *  rule (pure data boundary: registry shape, membership, and the
 *  custom-tier-independent canon owner matrix). */
describe("image-prompt-families registry", () => {
  test("membership mirrors the authored canon (ten families — novelai's assets ship in NAI-6c/6d)", () => {
    expect([...IMAGE_PROMPT_FAMILY_IDS]).toEqual([
      "prose",
      "pony",
      "illustrious",
      "noobai",
      "anima",
      "novelai",
      "krea2",
      "qwen",
      "sdxl-realism",
      "hybrid",
    ]);
    expect(IMAGE_PROMPT_DEFAULT_FAMILY).toBe("prose");
  });

  test("grammars: tag families tags, prose-lineage prose, hybrid hybrid", () => {
    for (const id of ["pony", "illustrious", "noobai", "anima"] as const) {
      expect(IMAGE_PROMPT_FAMILIES[id].grammar).toBe("tags");
    }
    for (const id of ["prose", "krea2", "qwen", "sdxl-realism"] as const) {
      expect(IMAGE_PROMPT_FAMILIES[id].grammar).toBe("prose");
    }
    expect(IMAGE_PROMPT_FAMILIES.hybrid.grammar).toBe("hybrid");
  });

  test("canon footprint matches the authored asset set", () => {
    // Tag families author everything they can.
    for (const id of ["pony", "illustrious", "noobai", "anima"] as const) {
      const family = IMAGE_PROMPT_FAMILIES[id];
      expect(family.ownTemplates).toBeTrue();
      expect(family.ownNegative).toBeTrue();
      expect(family.ownQuality).toBeTrue();
    }
    // Prose authors templates + the shared negative, but no quality layer.
    expect(IMAGE_PROMPT_FAMILIES.prose.ownTemplates).toBeTrue();
    expect(IMAGE_PROMPT_FAMILIES.prose.ownNegative).toBeTrue();
    expect(IMAGE_PROMPT_FAMILIES.prose.ownQuality).toBeFalse();
    // krea2: assist-only (dead negatives on Turbo — inherits prose).
    expect(IMAGE_PROMPT_FAMILIES.krea2).toMatchObject({ ownTemplates: false, ownNegative: false, ownQuality: false });
    // qwen: prose templates + the 500-char negative, no quality layer.
    expect(IMAGE_PROMPT_FAMILIES.qwen).toMatchObject({ ownTemplates: false, ownNegative: true, ownQuality: false });
    // sdxl-realism: prose templates + own negative + quality layer.
    expect(IMAGE_PROMPT_FAMILIES["sdxl-realism"]).toMatchObject({ ownTemplates: false, ownNegative: true, ownQuality: true });
    // hybrid: assist-only.
    expect(IMAGE_PROMPT_FAMILIES.hybrid).toMatchObject({ ownTemplates: false, ownNegative: false, ownQuality: false });
    // novelai (NAI-6a): tag grammar, own templates + negative, but quality
    // rides NovelAI's server-side qualityToggle — no family quality layer.
    expect(IMAGE_PROMPT_FAMILIES.novelai).toMatchObject({ ownTemplates: true, ownNegative: true, ownQuality: false });
  });
});

describe("imagePromptCanonFamily — the variant-resolution rule", () => {
  test("authoring families own their mode templates", () => {
    expect(imagePromptCanonFamily("pony", "mode", IMAGE_GENERATION_MODES.Portrait)).toBe("pony");
    expect(imagePromptCanonFamily("prose", "mode", IMAGE_GENERATION_MODES.Portrait)).toBe("prose");
  });

  test("non-authoring families inherit the prose canon — documented, not silent", () => {
    expect(imagePromptCanonFamily("krea2", "mode", IMAGE_GENERATION_MODES.Portrait)).toBe("prose");
    expect(imagePromptCanonFamily("qwen", "mode", IMAGE_GENERATION_MODES.Selfie)).toBe("prose");
    expect(imagePromptCanonFamily("hybrid", "mode", IMAGE_GENERATION_MODES.Avatar)).toBe("prose");
  });

  test("negative: qwen owns its own, krea2/hybrid fall back to prose", () => {
    expect(imagePromptCanonFamily("qwen", "negative")).toBe("qwen");
    expect(imagePromptCanonFamily("krea2", "negative")).toBe("prose");
    expect(imagePromptCanonFamily("hybrid", "negative")).toBe("prose");
  });

  test("assist: every family owns its addendum", () => {
    for (const id of IMAGE_PROMPT_FAMILY_IDS) {
      expect(imagePromptCanonFamily(id, "assist")).toBe(id);
    }
  });

  test("quality has NO universal fallback — undefined off the authoring set", () => {
    expect(imagePromptCanonFamily("pony", "quality")).toBe("pony");
    expect(imagePromptCanonFamily("sdxl-realism", "quality")).toBe("sdxl-realism");
    expect(imagePromptCanonFamily("prose", "quality")).toBeUndefined();
    expect(imagePromptCanonFamily("krea2", "quality")).toBeUndefined();
    expect(imagePromptCanonFamily("qwen", "quality")).toBeUndefined();
    expect(imagePromptCanonFamily("hybrid", "quality")).toBeUndefined();
    // NAI-6a: NovelAI's quality comes from the server-side qualityToggle.
    expect(imagePromptCanonFamily("novelai", "quality")).toBeUndefined();
  });

  test("free mode is family-neutral — always prose", () => {
    expect(imagePromptCanonFamily("pony", "mode", IMAGE_GENERATION_MODES.Free)).toBe("prose");
    expect(imagePromptCanonFamily("krea2", "mode", IMAGE_GENERATION_MODES.Free)).toBe("prose");
  });
});

/** IPT Wave 3 — the authoritative base-model → family mapping (word-based,
 *  first rule wins; the SDXL class needs the tag corpus, unmapped labels
 *  stay honest misses). */
describe("matchImagePromptBaseModel — base-model → family mapping", () => {
  test("the plan's direct mappings hit across label dialects", () => {
    // Civitai baseModel vocabulary.
    expect(matchImagePromptBaseModel("Pony")).toEqual({ kind: "family", family: "pony" });
    expect(matchImagePromptBaseModel("Illustrious")).toEqual({ kind: "family", family: "illustrious" });
    expect(matchImagePromptBaseModel("NoobAI")).toEqual({ kind: "family", family: "noobai" });
    expect(matchImagePromptBaseModel("Anima")).toEqual({ kind: "family", family: "anima" });
    expect(matchImagePromptBaseModel("Qwen-Image")).toEqual({ kind: "family", family: "qwen" });
    // The exact Comfy BaseModel map is prefix-safe: Qwen and Qwen 2 both
    // project to one dialect but select different workflow templates.
    expect(matchImagePromptBaseModel("Qwen 2")).toEqual({ kind: "family", family: "qwen" });
    expect(matchImagePromptBaseModel("Qwen")).toEqual({ kind: "family", family: "qwen" });
    expect(matchImagePromptBaseModel("Flux.1 D")).toEqual({ kind: "family", family: "prose" });
    expect(matchImagePromptBaseModel("Flux.1 S")).toEqual({ kind: "family", family: "prose" });
    expect(matchImagePromptBaseModel("ZImageTurbo")).toEqual({ kind: "family", family: "qwen" });
    expect(matchImagePromptBaseModel("ZImageBase")).toEqual({ kind: "family", family: "qwen" });
    // Sidecar BaseModel / embedded-header dialects (separators + suffixes).
    expect(matchImagePromptBaseModel("Pony V6")).toEqual({ kind: "family", family: "pony" });
    expect(matchImagePromptBaseModel("NoobAI-XL VPred 0.6")).toEqual({ kind: "family", family: "noobai" });
    expect(matchImagePromptBaseModel("illustrious-xl")).toEqual({ kind: "family", family: "illustrious" });
    expect(matchImagePromptBaseModel("Krea 2")).toEqual({ kind: "family", family: "krea2" });
    expect(matchImagePromptBaseModel("Krea2")).toEqual({ kind: "family", family: "krea2" });
    // The prose group's vendor bases (registry description vocabulary).
    expect(matchImagePromptBaseModel("Seedream")).toEqual({ kind: "family", family: "prose" });
    expect(matchImagePromptBaseModel("gpt-image")).toEqual({ kind: "family", family: "prose" });
    expect(matchImagePromptBaseModel("Z-Image")).toEqual({ kind: "family", family: "qwen" });
    expect(matchImagePromptBaseModel("ZImage")).toEqual({ kind: "family", family: "qwen" });
  });

  test("word boundaries: a model NAME never leaks into the base label match", () => {
    // "Animagine" is a model name, not the Anima base — must NOT match.
    expect(matchImagePromptBaseModel("Animagine XL")).toEqual({ kind: "unmapped", label: "Animagine XL" });
    // "surrealism" is not the realism signal at mapping level either.
    expect(matchImagePromptBaseModel("Surrealism")).toEqual({ kind: "unmapped", label: "Surrealism" });
  });

  test("SDXL-class labels demand the tag corpus — never a direct family", () => {
    expect(matchImagePromptBaseModel("SDXL 1.0")).toEqual({ kind: "sdxl", label: "SDXL 1.0" });
    expect(matchImagePromptBaseModel("sd_xl_base")).toEqual({ kind: "sdxl", label: "sd_xl_base" });
    expect(matchImagePromptBaseModel("stable-diffusion-xl-v1-base")).toEqual({
      kind: "sdxl",
      label: "stable-diffusion-xl-v1-base",
    });
  });

  test("labels with no registry family stay unmapped (honest, user pins)", () => {
    expect(matchImagePromptBaseModel("SD 1.5")).toEqual({ kind: "unmapped", label: "SD 1.5" });
    expect(matchImagePromptBaseModel("Chroma")).toEqual({ kind: "unmapped", label: "Chroma" });
    expect(matchImagePromptBaseModel("")).toEqual({ kind: "unmapped", label: "" });
  });

  test("a label naming several DISTINCT families is ambiguous — never a precedence pick", () => {
    expect(matchImagePromptBaseModel("NoobAI Illustrious")).toEqual({
      kind: "ambiguous",
      label: "NoobAI Illustrious",
      families: ["noobai", "illustrious"],
    });
    expect(matchImagePromptBaseModel("Pony Anima")).toEqual({
      kind: "ambiguous",
      label: "Pony Anima",
      families: ["anima", "pony"],
    });
    // Separator/run dialects collapse to the same words.
    expect(matchImagePromptBaseModel("illustrious_x_noobai_merge").kind).toBe("ambiguous");
  });

  test("several keywords of the SAME family are still that one family", () => {
    expect(matchImagePromptBaseModel("Flux Seedream")).toEqual({ kind: "family", family: "prose" });
    expect(matchImagePromptBaseModel("gpt-image Z-Image")).toEqual({
      kind: "ambiguous",
      label: "gpt-image Z-Image",
      families: ["qwen", "prose"],
    });
    expect(matchImagePromptBaseModel("Krea2 Krea")).toEqual({ kind: "family", family: "krea2" });
  });
});

describe("disambiguateSdxlFamily — the author-tag-corpus rule", () => {
  test("realism/photoreal corpus → sdxl-realism", () => {
    expect(disambiguateSdxlFamily(["photorealistic", "portrait photography"]))
      .toBe("sdxl-realism");
    expect(disambiguateSdxlFamily(["realism", "woman", "photography"]))
      .toBe("sdxl-realism");
  });

  test("plain/anime/mixed corpora stay honestly ambiguous", () => {
    expect(disambiguateSdxlFamily(["anime", "style", "woman"])).toBeUndefined();
    expect(disambiguateSdxlFamily(["anime", "realism"])).toBeUndefined();
    expect(disambiguateSdxlFamily([])).toBeUndefined();
  });

  test("surrealism is not realism (word boundary)", () => {
    expect(disambiguateSdxlFamily(["surrealism"])).toBeUndefined();
  });
});
