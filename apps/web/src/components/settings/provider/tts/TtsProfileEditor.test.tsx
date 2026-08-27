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

  it("Save is disabled when not dirty and enabled when dirty with a name", async () => {
    const ttsClean = makeTts({ dirty: false, form: { id: "p1", name: "Alpha", backend: TTS_BACKEND.Kokoro as never, config: {}, voiceId: "" } as never });
    const view1 = render(React.createElement(TtsProfileEditor as never, { tts: ttsClean } as never));
    // SaveBar's save button is disabled when not dirty — find by aria-label tts key? The button label is t("save_btn") -> "save_btn" via mock.
    // The SaveButton renders with disabled prop when !dirty, so the button should be disabled.
    const saveBtn1 = view1.getByRole("button", { name: /save_btn|saving|saved/ });
    expect((saveBtn1 as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    const ttsDirty = makeTts({ dirty: true, form: { id: "p1", name: "Beta", backend: TTS_BACKEND.Gemini as never, config: {}, voiceId: "" } as never });
    const view2 = render(React.createElement(TtsProfileEditor as never, { tts: ttsDirty } as never));
    const saveBtn2 = view2.getByRole("button", { name: /save_btn|saving|saved/ });
    expect((saveBtn2 as HTMLButtonElement).disabled).toBe(false);
  });

  it("clicking Save calls tts.save", async () => {
    const save = mock(async () => {});
    const tts = makeTts({ dirty: true, saving: false, save, form: { id: "p1", name: "Alpha", backend: TTS_BACKEND.Kokoro as never, config: {}, voiceId: "" } as never });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    const btn = view.getByRole("button", { name: /save_btn|saving|saved/ });
    fireEvent.click(btn);
    expect(save).toHaveBeenCalled();
  });

  it("delete button disabled for unsaved form and opens confirm modal for saved form", async () => {
    // Unsaved
    const ttsUnsaved = makeTts({ form: { id: null, name: "", backend: TTS_BACKEND.Kokoro as never, config: {}, voiceId: "" } as never });
    const view1 = render(React.createElement(TtsProfileEditor as never, { tts: ttsUnsaved } as never));
    const del1 = view1.getByTestId("tts-delete-btn") as HTMLButtonElement;
    expect(del1.disabled).toBe(true);
    cleanup();

    // Saved form
    const remove = mock(async () => {});
    const ttsSaved = makeTts({ form: { id: "p1", name: "Alpha", backend: TTS_BACKEND.Kokoro as never, config: {}, voiceId: "" } as never, remove });
    const view2 = render(React.createElement(TtsProfileEditor as never, { tts: ttsSaved } as never));
    const del2 = view2.getByTestId("tts-delete-btn") as HTMLButtonElement;
    expect(del2.disabled).toBe(false);
    fireEvent.click(del2);
    // Confirm modal should appear with title key
    await waitFor(() => expect(view2.getByText("tts_profile_delete_confirm_title")).toBeTruthy());
    const confirmBtn = view2.getByText("delete_btn");
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(remove).toHaveBeenCalled());
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
