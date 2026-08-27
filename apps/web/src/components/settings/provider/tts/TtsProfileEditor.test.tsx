import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";
import { KOKORO_VOICES } from "../../../../lib/tts/kokoro-voices.js";

useDomEnv();

const realI18n = await import("../../../../i18n/context.js");
mock.module("../../../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params && typeof params === "object" && "name" in params) {
        return `${key}:${String(params.name)}`;
      }
      return key;
    },
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

const { act, cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
const { TtsProfileEditor } = await import("./TtsProfileEditor.js");
const { TTS_BACKEND } = await import("@vibe-tavern/domain");

function makeTts(overrides: Partial<ReturnType<typeof import("./use-tts-profiles.js").useTtsProfiles>> = {}) {
  const base = {
    profiles: [],
    loading: false,
    editingId: "p1",
    form: { id: "p1", name: "Alpha", backend: TTS_BACKEND.Kokoro as string, config: {}, voiceId: "" } as never,
    dirty: false,
    error: null as string | null,
    saving: false,
    select: () => {},
    startCreate: () => {},
    setForm: mock(() => {}),
    save: mock(async () => {}),
    remove: mock(async () => {}),
    cancelEdit: mock(() => {}),
    reload: mock(async () => {}),
  };
  return { ...base, ...overrides } as unknown as ReturnType<typeof import("./use-tts-profiles.js").useTtsProfiles>;
}

afterEach(async () => {
  await act(async () => {});
  cleanup();
});

describe("TtsProfileEditor", () => {
  it("typing a name calls setForm and marks dirty", async () => {
    const setForm = mock(() => {});
    const tts = makeTts({ form: { id: "p1", name: "Alpha", backend: TTS_BACKEND.Kokoro as never, config: {}, voiceId: "" } as never, setForm, dirty: false });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    const input = view.getByTestId("tts-profile-name-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Alpha-2" } });
    expect(setForm).toHaveBeenCalled();
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { name: string };
    expect(patch.name).toBe("Alpha-2");
  });

  it("save/delete controls live in the modal FOOTER, not inline in the editor (audio-tab pattern fix)", async () => {
    // The master-detail house pattern (regex/service tabs precedent): the
    // detail pane has NO inline SaveBar/delete — they render in
    // MasterDetailFooter (pinned in provider-modal.test.ts). If this test
    // fails, someone reintroduced an inline control.
    const tts = makeTts({ dirty: true, form: { id: "p1", name: "Alpha", backend: TTS_BACKEND.Kokoro as never, config: {}, voiceId: "" } as never });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    expect(view.queryAllByRole("button", { name: /save_btn|saving|saved/ })).toHaveLength(0);
    expect(view.queryByTestId("tts-delete-btn")).toBeNull();
  });

  it("delete confirm flow lives in the modal footer (moved to ProviderModal; see provider-modal.test.ts)", async () => {
    // The editor pane no longer owns delete — nothing to click here. The full
    // trash→confirm→remove flow is pinned end-to-end in provider-modal.test.ts.
    const remove = mock(async () => {});
    const ttsSaved = makeTts({ form: { id: "p1", name: "Alpha", backend: TTS_BACKEND.Kokoro as never, config: {}, voiceId: "" } as never, remove });
    const view = render(React.createElement(TtsProfileEditor as never, { tts: ttsSaved } as never));
    expect(view.queryByTestId("tts-delete-btn")).toBeNull();
    expect(view.queryByText("tts_profile_delete_confirm_title")).toBeNull();
  });

  it("tier-gating: kokoro shows voice + speed only", async () => {
    const tts = makeTts({
      form: { id: null, name: "Koko", backend: TTS_BACKEND.Kokoro as never, config: {}, voiceId: "af_heart" } as never,
    });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    expect(view.queryByText("tts_field_voice")).toBeTruthy();
    expect(view.queryByText("tts_field_speed")).toBeTruthy();
    expect(view.queryByTestId("tts-field-endpoint")).toBeNull();
    expect(view.queryByTestId("tts-field-api-key")).toBeNull();
    expect(view.queryByTestId("tts-field-model")).toBeNull();
    expect(view.queryByTestId("tts-field-response-format")).toBeNull();
    expect(view.queryByText("tts_field_style_instructions")).toBeNull();
    expect(view.queryByTestId("tts-field-model-id")).toBeNull();
    expect(view.queryByText("tts_field_stability")).toBeNull();
    cleanup();
  });

  it("tier-gating: openai-compatible shows endpoint/apiKey/model/format/speed/voice", async () => {
    const tts = makeTts({
      form: {
        id: null,
        name: "Open",
        backend: TTS_BACKEND.OpenAiCompatible as never,
        config: { endpoint: "https://x", apiKey: "k", model: "m", responseFormat: "mp3", speed: 1 },
        voiceId: "",
      } as never,
    });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    expect(view.getByTestId("tts-field-endpoint")).toBeTruthy();
    expect(view.getByTestId("tts-field-api-key")).toBeTruthy();
    expect(view.getByTestId("tts-field-model")).toBeTruthy();
    expect(view.getByTestId("tts-field-response-format")).toBeTruthy();
    expect(view.queryByText("tts_field_speed")).toBeTruthy();
    expect(view.queryByText("tts_field_voice")).toBeTruthy();
    expect(view.queryByText("tts_field_style_instructions")).toBeNull();
    expect(view.queryByTestId("tts-field-model-id")).toBeNull();
    expect(view.queryByText("tts_field_stability")).toBeNull();
    cleanup();
  });

  it("tier-gating: gemini shows apiKey/model/styleInstructions/voice and NO speed", async () => {
    const tts = makeTts({
      form: {
        id: null,
        name: "Gem",
        backend: TTS_BACKEND.Gemini as never,
        config: { apiKey: "k", model: "m", styleInstructions: "warm" },
        voiceId: "",
      } as never,
    });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    expect(view.getByTestId("tts-field-api-key")).toBeTruthy();
    expect(view.getByTestId("tts-field-model")).toBeTruthy();
    expect(view.getByTestId("tts-field-style-instructions")).toBeTruthy();
    expect(view.queryByText("tts_field_voice")).toBeTruthy();
    expect(view.queryByText("tts_field_speed")).toBeNull();
    expect(view.queryByTestId("tts-field-endpoint")).toBeNull();
    expect(view.queryByTestId("tts-field-response-format")).toBeNull();
    expect(view.queryByTestId("tts-field-model-id")).toBeNull();
    expect(view.queryByText("tts_field_stability")).toBeNull();
    cleanup();
  });

  it("tier-gating: elevenlabs shows apiKey/modelId/3 sliders/toggle/speed/voice", async () => {
    const tts = makeTts({
      form: {
        id: null,
        name: "EL",
        backend: TTS_BACKEND.ElevenLabs as never,
        config: { apiKey: "k", modelId: "m", stability: 0.5, similarityBoost: 0.7, style: 0.2, useSpeakerBoost: true, speed: 1 },
        voiceId: "",
      } as never,
    });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    expect(view.getByTestId("tts-field-api-key")).toBeTruthy();
    expect(view.getByTestId("tts-field-model-id")).toBeTruthy();
    expect(view.queryByText("tts_field_stability")).toBeTruthy();
    expect(view.queryByText("tts_field_similarity")).toBeTruthy();
    // style label appears as tts_field_style (distinct from styleInstructions)
    const styleLabels = view.queryAllByText("tts_field_style");
    expect(styleLabels.length).toBeGreaterThanOrEqual(1);
    expect(view.queryByText("tts_field_speaker_boost")).toBeTruthy();
    expect(view.queryByText("tts_field_speed")).toBeTruthy();
    expect(view.queryByText("tts_field_voice")).toBeTruthy();
    expect(view.queryByTestId("tts-field-endpoint")).toBeNull();
    expect(view.queryByTestId("tts-field-response-format")).toBeNull();
    expect(view.queryByText("tts_field_style_instructions")).toBeNull();
    cleanup();
  });

  it("kokoro voice picker lists only English voices", async () => {
    const tts = makeTts({
      form: { id: null, name: "Koko", backend: TTS_BACKEND.Kokoro as never, config: {}, voiceId: "af_heart" } as never,
    });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    const trigger = view.getByTestId("tts-voice-select") as HTMLElement;
    fireEvent.click(trigger);
    await waitFor(() => {
      // Dropdown portal renders options into body
      const bodyText = document.body.textContent ?? "";
      expect(bodyText).toContain("af_heart");
    });
    // Derive a Japanese id from the manifest to avoid blind hardcoding
    const japanese = KOKORO_VOICES.find((v) => v.lang === "j");
    if (japanese) {
      const bodyText = document.body.textContent ?? "";
      expect(bodyText).not.toContain(japanese.id);
    }
    cleanup();
    // Clean portal leftovers
    document.body.innerHTML = "";
    await act(async () => {});
  });
});
