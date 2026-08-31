import { describe, expect, test } from "bun:test";

import {
  getPresetGroup,
  getTtsPresetGroup,
  getVisiblePresetGroups,
  getVisibleProviderPresets,
  getVisibleTtsPresetGroups,
  getVisibleTtsPresets,
  TTS_PRESETS,
} from "./tts-presets.js";

describe("tts-presets", () => {
  test("has exactly 12 entries with unique ids", () => {
    expect(TTS_PRESETS.length).toBe(12);
    const ids = TTS_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(12);
    expect(ids).toEqual(["openai", "openrouter", "groq", "siliconflow", "nanogpt", "electronhub", "gemini", "elevenlabs", "cartesia", "inworld", "lmnt", "minimax"]);
  });

  test("every openai-compat entry has a baseUrl", () => {
    const compat = TTS_PRESETS.filter((p) => p.backend === "openai-compat");
    expect(compat.length).toBe(6);
    for (const p of compat) {
      expect(p.baseUrl).toBeDefined();
      expect(p.baseUrl!.length).toBeGreaterThan(0);
      expect(p.baseUrl!.startsWith("https://")).toBe(true);
    }
  });

  test("backend distribution is 6 openai-compat + 1 gemini + 1 elevenlabs", () => {
    const counts = { compat: 0, gemini: 0, elevenlabs: 0 };
    for (const p of TTS_PRESETS) {
      if (p.backend === "openai-compat") counts.compat++;
      else if (p.backend === "gemini") counts.gemini++;
      else if (p.backend === "elevenlabs") counts.elevenlabs++;
    }
    expect(counts.compat).toBe(6);
    expect(counts.gemini).toBe(1);
    expect(counts.elevenlabs).toBe(1);
  });

  test("no preset carries static voice data (D20: fetched lists are the only source)", () => {
    for (const p of TTS_PRESETS) {
      expect(Object.hasOwn(p, "staticVoices")).toBe(false);
      expect(Object.hasOwn(p, "voiceMode")).toBe(false);
      expect(JSON.stringify(p)).not.toContain("alloy");
    }
  });

  test("group-filtering helper behaves like provider-presets counterpart", () => {
    // All 8 presets are in group "cloud" — filtering by that group yields the same set.
    expect(getTtsPresetGroup("openai")).toBe("cloud");
    expect(getTtsPresetGroup("gemini")).toBe("cloud");
    expect(getTtsPresetGroup("unknown")).toBeNull();
    // Alias parity
    expect(getPresetGroup("openai")).toBe("cloud");
    expect(getPresetGroup("unknown")).toBeNull();

    const visible = getVisibleTtsPresets();
    expect(visible.length).toBe(12);
    expect(visible.every((p) => p.group === "cloud")).toBe(true);

    const visibleWithFlag = getVisibleTtsPresets(true);
    expect(visibleWithFlag.length).toBe(12);
    expect(getVisibleProviderPresets(false).length).toBe(12);

    const groups = getVisibleTtsPresetGroups();
    expect(groups.length).toBe(1);
    expect(groups[0]?.id).toBe("cloud");
    expect(getVisiblePresetGroups(true).length).toBe(1);
    expect(getVisibleTtsPresetGroups(false).length).toBe(1);
  });

  test("modelFilter values are within the declared union", () => {
    // F8: name-heuristic REMOVED; known presets stamp documented/audio-type.
    const allowedFilters = new Set(["modality", "audio-models", "audio-type", "documented", "none"]);
    for (const p of TTS_PRESETS) {
      expect(allowedFilters.has(p.modelFilter)).toBe(true);
      expect(p.modelFilter).not.toBe("name-heuristic");
    }
    expect(TTS_PRESETS.find((p) => p.id === "openrouter")?.modelFilter).toBe("modality");
    // D23: NanoGPT discovery comes from /audio-models, not the chat catalog.
    expect(TTS_PRESETS.find((p) => p.id === "nanogpt")?.modelFilter).toBe("audio-models");
    expect(TTS_PRESETS.find((p) => p.id === "gemini")?.modelFilter).toBe("none");
    // F8 documented static catalogs (server-side table, no network discovery):
    // openai (+marin/cedar rosters), groq (orpheus 6+6), electronhub (10 models).
    expect(TTS_PRESETS.find((p) => p.id === "openai")?.modelFilter).toBe("documented");
    expect(TTS_PRESETS.find((p) => p.id === "groq")?.modelFilter).toBe("documented");
    expect(TTS_PRESETS.find((p) => p.id === "electronhub")?.modelFilter).toBe("documented");
    // F8 audio-type: SiliconFlow's documented server-side ?type=audio filter.
    expect(TTS_PRESETS.find((p) => p.id === "siliconflow")?.modelFilter).toBe("audio-type");
  });
});
