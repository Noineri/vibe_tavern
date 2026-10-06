import { describe, expect, test } from "bun:test";
import { COAUTHOR_TRANSPORT_CAPABILITIES, type ProviderPresetId } from "@vibe-tavern/domain";
import { PROVIDER_PRESETS, IMAGE_GEN_PROVIDER_PRESETS } from "./provider-presets.js";

describe("provider preset transport classifications", () => {
  test("the actual preset registry and domain capability map are exhaustive peers", () => {
    const registryIds = PROVIDER_PRESETS.map((preset) => preset.id).sort();
    expect(new Set(registryIds).size).toBe(registryIds.length);
    // Keys are ProviderPresetId per the map's `satisfies` contract; Object.keys widens to string[].
    const capabilityIds = (Object.keys(COAUTHOR_TRANSPORT_CAPABILITIES) as ProviderPresetId[]).sort();
    expect(registryIds).toEqual(capabilityIds);
  });

  test("LM Studio is the ninth local preset — localhost pass-through, no API key (B4)", () => {
    const lmstudio = PROVIDER_PRESETS.find((preset) => preset.id === "lmstudio");
    expect(lmstudio).toBeDefined();
    expect(lmstudio!.type).toBe("openai_compat");
    expect(lmstudio!.baseUrl).toBe("http://localhost:1234/v1");
    expect(lmstudio!.group).toBe("local");
    expect(lmstudio!.noApiKey).toBe(true);
  });

  test("NovelAI (/oa/v1) rides the cloud group and requires a key for its model list (NAI-2a)", () => {
    const novelai = PROVIDER_PRESETS.find((preset) => preset.id === "novelai_oa");
    expect(novelai).toBeDefined();
    expect(novelai!.label).toBe("NovelAI");
    expect(novelai!.type).toBe("openai_compat");
    expect(novelai!.baseUrl).toBe("https://text.novelai.net/oa/v1");
    expect(novelai!.group).toBe("cloud");
    expect(novelai!.requiresAuthForModels).toBe(true);
  });

  test("NovelAI (native) rides the cloud group, requires a key for its model list, and defaults to 150 max tokens (NAI-3c)", () => {
    const novelai = PROVIDER_PRESETS.find((preset) => preset.id === "novelai");
    expect(novelai).toBeDefined();
    expect(novelai!.label).toBe("NovelAI (native)");
    expect(novelai!.type).toBe("novelai");
    expect(novelai!.baseUrl).toBe("https://text.novelai.net");
    expect(novelai!.group).toBe("cloud");
    expect(novelai!.requiresAuthForModels).toBe(true);
    expect(novelai!.defaultMaxTokens).toBe(150);
  });

  test("defaultMaxTokens is carried only by the native NovelAI preset (NAI-3c)", () => {
    const carriers = PROVIDER_PRESETS.filter((preset) => preset.defaultMaxTokens !== undefined);
    expect(carriers.map((preset) => preset.id)).toEqual(["novelai"]);
  });
});

describe("image-gen preset segments (MR-6 — the four-segment split; boundary = the app-wide protocol canon, owner 2026-09-18)", () => {
  test("native = the sixteen proprietary-wire rows; cloud = every OpenAI-compatible surface (the images-dialect family + the chat-completions transports) incl. the OpenAI reference row; free stays inside cloud; local unchanged", () => {
    const nativeIds = IMAGE_GEN_PROVIDER_PRESETS.filter((p) => p.group === "native").map((p) => p.id).sort();
    expect(nativeIds).toEqual(
      ["bfl", "chutes", "cloudflare", "dashscope", "fal", "google", "hf", "ideogram", "krea", "leonardo", "luma", "minimax", "nim", "novita", "replicate", "stability"].sort(),
    );
    // The OpenAI-images dialect family rides cloud — including the OpenAI
    // reference row (the LLM-tab twin: the LLM openai row sits in cloud) and
    // the PE-1 family members recraft/zai/volcengine.
    for (const dialectId of ["openai", "togetherai", "siliconflow", "nanogpt", "electronhub", "deepinfra", "recraft", "zai", "volcengine"]) {
      expect(IMAGE_GEN_PROVIDER_PRESETS.find((p) => p.id === dialectId)!.group).toBe("cloud");
    }
    // OpenRouter's image transport rides chat/completions + modalities —
    // the OpenAI chat-compat surface. The canon classifies by the WIRE, not
    // by whether a dedicated adapter executes it, so the row rides cloud
    // (the LLM-tab twin). It initially sat in native under a
    // "dedicated adapter = own wire" misreading; the owner audit caught it.
    expect(IMAGE_GEN_PROVIDER_PRESETS.find((p) => p.id === "openrouter")!.group).toBe("cloud");
    // Free tiers stay INSIDE the cloud segment with their labels (owner
    // 2026-09-18) — no separate free segment.
    for (const freeId of ["pollinations_free", "aihorde"]) {
      const row = IMAGE_GEN_PROVIDER_PRESETS.find((p) => p.id === freeId);
      expect(row).toBeDefined();
      expect(row!.group).toBe("cloud");
      expect(row!.label.toLowerCase()).toContain("free");
    }
    // The two local rows are exactly a1111 + comfyui.
    expect(IMAGE_GEN_PROVIDER_PRESETS.filter((p) => p.group === "local").map((p) => p.id).sort()).toEqual(["a1111", "comfyui"]);
    // Every row belongs to a segment (the sum check — no orphans).
    const total = IMAGE_GEN_PROVIDER_PRESETS.length;
    const grouped = IMAGE_GEN_PROVIDER_PRESETS.filter((p) => p.group === "cloud" || p.group === "native" || p.group === "local").length;
    expect(grouped).toBe(total);
    // The endpoint-hint carrier set: cloudflare is the roster's only one
    // (the <ACCOUNT_ID> URL placeholder); every other row carries none.
    const hintCarriers = IMAGE_GEN_PROVIDER_PRESETS.filter((p) => p.endpointHintKey !== undefined);
    expect(hintCarriers.map((p) => p.id)).toEqual(["cloudflare"]);
    expect(hintCarriers[0]!.endpointHintKey).toBe("image_gen_endpoint_hint_cloudflare");
  });
});
