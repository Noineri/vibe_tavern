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
});

describe("image-gen preset segments (MR-6 — the four-segment split)", () => {
  test("native = the twelve vendors of their own models; aggregators (incl. free) stay cloud; local stays local", () => {
    const nativeIds = IMAGE_GEN_PROVIDER_PRESETS.filter((p) => p.group === "native").map((p) => p.id).sort();
    expect(nativeIds).toEqual(
      ["bfl", "dashscope", "google", "ideogram", "leonardo", "luma", "minimax", "openai", "recraft", "stability", "volcengine", "zai"].sort(),
    );
    // Free tiers stay INSIDE the cloud segment with their labels (owner
    // 2026-09-18: «оставляем внутри») — no separate free segment.
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
  });
});
