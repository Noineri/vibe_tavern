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
  test("has exactly 8 entries with unique ids", () => {
    expect(TTS_PRESETS.length).toBe(8);
    const ids = TTS_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(8);
    expect(ids).toEqual(["openai", "openrouter", "groq", "siliconflow", "nanogpt", "electronhub", "gemini", "elevenlabs"]);
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

  test("static voice counts: openai 11, groq 12, siliconflow 8", () => {
    const openai = TTS_PRESETS.find((p) => p.id === "openai");
    expect(openai?.staticVoices?.length).toBe(11);
    const groq = TTS_PRESETS.find((p) => p.id === "groq");
    expect(groq?.staticVoices?.length).toBe(12);
    const siliconflow = TTS_PRESETS.find((p) => p.id === "siliconflow");
    expect(siliconflow?.staticVoices?.length).toBe(8);
  });

  test("every siliconflow static voice id starts with fishaudio/fish-speech-1.5:", () => {
    const siliconflow = TTS_PRESETS.find((p) => p.id === "siliconflow");
    expect(siliconflow).toBeDefined();
    for (const v of siliconflow!.staticVoices!) {
      expect(v.id.startsWith("fishaudio/fish-speech-1.5:")).toBe(true);
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
    expect(visible.length).toBe(8);
    expect(visible.every((p) => p.group === "cloud")).toBe(true);

    const visibleWithFlag = getVisibleTtsPresets(true);
    expect(visibleWithFlag.length).toBe(8);
    expect(getVisibleProviderPresets(false).length).toBe(8);

    const groups = getVisibleTtsPresetGroups();
    expect(groups.length).toBe(1);
    expect(groups[0]?.id).toBe("cloud");
    expect(getVisiblePresetGroups(true).length).toBe(1);
    expect(getVisibleTtsPresetGroups(false).length).toBe(1);
  });

  test("modelFilter and voiceMode values are within the declared unions", () => {
    const allowedFilters = new Set(["modality", "audio-models", "name-heuristic", "none"]);
    const allowedVoiceModes = new Set(["static", "fetch", "manual"]);
    for (const p of TTS_PRESETS) {
      expect(allowedFilters.has(p.modelFilter)).toBe(true);
      expect(allowedVoiceModes.has(p.voiceMode)).toBe(true);
    }
    expect(TTS_PRESETS.find((p) => p.id === "openrouter")?.modelFilter).toBe("modality");
    // D23: NanoGPT discovery comes from /audio-models, not the chat catalog.
    expect(TTS_PRESETS.find((p) => p.id === "nanogpt")?.modelFilter).toBe("audio-models");
    expect(TTS_PRESETS.find((p) => p.id === "gemini")?.modelFilter).toBe("none");
    expect(TTS_PRESETS.find((p) => p.id === "openai")?.voiceMode).toBe("static");
    expect(TTS_PRESETS.find((p) => p.id === "gemini")?.voiceMode).toBe("fetch");
    expect(TTS_PRESETS.find((p) => p.id === "openrouter")?.voiceMode).toBe("manual");
  });

  test("static voice gender stays DATA (never baked into display label)", () => {
    // Genders are raw "female"/"male" — UI translates via kokoroVoiceLabel pattern.
    for (const p of TTS_PRESETS) {
      for (const v of p.staticVoices ?? []) {
        expect(v.gender === "female" || v.gender === "male").toBe(true);
      }
    }
  });
});
