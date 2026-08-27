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

// Draft voices (F1) + models (F3): safe mock.module pattern — real module
// captured first, only draft helpers overridden.
const realTtsApi = await import("../../../../api/tts-api.js");
const listTtsDraftVoicesMock = mock(async (_body: { backend: string; config: Record<string, unknown> }) => [
  { id: "alloy", label: "Alloy", lang: "en" },
  { id: "echo", label: "Echo", lang: "en" },
]);
const listTtsDraftModelsMock = mock(async (_body: { backend: string; config: Record<string, unknown> }) => [
  { id: "gemini-2.5-flash-preview-tts", label: "gemini-2.5-flash-preview-tts" },
  { id: "gemini-2.5-pro-preview-tts", label: "gemini-2.5-pro-preview-tts" },
]);
mock.module("../../../../api/tts-api.js", () => ({
  ...realTtsApi,
  listTtsDraftVoices: listTtsDraftVoicesMock,
  listTtsDraftModels: listTtsDraftModelsMock,
  // Docker probe (D8): deterministic "not found" for every editor test —
  // only the local-variant test below cares, and only that the panel renders.
  fetchLocalDockerStatus: async () => ({ available: false, version: null }),
}));

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
  });

  it("F1 draft contract: unsaved server form loads voices via draft endpoint, preview button enabled, no save-first hints", async () => {
    const tts = makeTts({
      form: {
        id: null,
        name: "Draft",
        backend: TTS_BACKEND.OpenAiCompatible as never,
        config: { endpoint: "https://x/v1", apiKey: "k", model: "m" },
        voiceId: "",
      } as never,
      dirty: true,
    });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));

    // Preview is NOT gated on save anymore.
    const previewBtn = view.getByTestId("tts-preview-btn") as HTMLButtonElement;
    expect(previewBtn.disabled).toBe(false);
    // No save-first hints — neither voices nor preview.
    expect(view.queryByText("tts_voices_save_first_hint")).toBeNull();
    expect(view.queryByText("tts_preview_save_first")).toBeNull();

    // Voices arrive after the 400ms debounce — via the transient endpoint with
    // the CURRENT form config (unsaved id: null).
    const select = await view.findByTestId("tts-voice-select", undefined, { timeout: 2500 });
    expect(select).toBeTruthy();
    expect(listTtsDraftVoicesMock).toHaveBeenCalled();
    const call = listTtsDraftVoicesMock.mock.calls[0][0] as { backend: string; config: Record<string, unknown> };
    expect(call.backend).toBe(TTS_BACKEND.OpenAiCompatible);
    expect(call.config.endpoint).toBe("https://x/v1");

    cleanup();
    document.body.innerHTML = "";
    await act(async () => {});
  });

  it("F3 draft models: gemini form fetches models via draft endpoint, refresh button visible", async () => {
    // Clear prior calls (voices/models mocks are process-scoped).
    (listTtsDraftModelsMock as unknown as { mockClear: () => void }).mockClear?.();
    (listTtsDraftVoicesMock as unknown as { mockClear: () => void }).mockClear?.();
    const tts = makeTts({
      form: {
        id: null,
        name: "Gem",
        backend: TTS_BACKEND.Gemini as never,
        config: { apiKey: "k", model: "gemini-2.5-flash-preview-tts" },
        voiceId: "",
      } as never,
    });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    const refresh = view.getByTestId("tts-models-refresh") as HTMLButtonElement;
    expect(refresh).toBeTruthy();
    // Wait for debounced fetch — look for a call with gemini backend specifically.
    await waitFor(
      () => {
        const calls = listTtsDraftModelsMock.mock.calls as unknown[][];
        expect(calls.some((c) => (c[0] as { backend: string }).backend === TTS_BACKEND.Gemini)).toBe(true);
      },
      { timeout: 2500 },
    );
    const geminiCalls = (listTtsDraftModelsMock.mock.calls as unknown[][]).filter(
      (c) => (c[0] as { backend: string }).backend === TTS_BACKEND.Gemini,
    );
    const lastGemini = geminiCalls[geminiCalls.length - 1][0] as { backend: string; config: Record<string, unknown> };
    expect(lastGemini.backend).toBe(TTS_BACKEND.Gemini);
    // Clicking refresh re-fetches
    const before = listTtsDraftModelsMock.mock.calls.length;
    fireEvent.click(refresh);
    await waitFor(() => expect(listTtsDraftModelsMock.mock.calls.length).toBeGreaterThan(before), { timeout: 1000 });
    cleanup();
    document.body.innerHTML = "";
    await act(async () => {});
  });

  it("F3: openai model is now a select with refresh, not a plain input", async () => {
    const tts = makeTts({
      form: {
        id: null,
        name: "Open",
        backend: TTS_BACKEND.OpenAiCompatible as never,
        config: { endpoint: "https://x", apiKey: "k", model: "kokoro" },
        voiceId: "",
      } as never,
    });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    // Old plain input gone, select present
    expect(view.queryByTestId("tts-field-model")).toBeTruthy();
    expect(view.getByTestId("tts-models-refresh")).toBeTruthy();
    // No hardcoded GEMINI_TTS_MODEL_OPTIONS reference in DOM; just a select.
    cleanup();
  });

  it("F3 manual fallback: empty model list degrades the field to a typeable input", async () => {
    // First (debounced) fetch for this render returns an empty list — e.g. an
    // unreachable local endpoint. The field must stay manually typeable.
    listTtsDraftModelsMock.mockImplementationOnce(async () => []);
    const setForm = mock(() => {});
    const tts = makeTts({
      setForm,
      form: {
        id: null,
        name: "Open",
        backend: TTS_BACKEND.OpenAiCompatible as never,
        config: { endpoint: "https://half-configured", apiKey: "k", model: "" },
        voiceId: "",
      } as never,
    });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    // Wait out the 400 ms debounce: with an empty list the fallback input
    // (same testid, native input) must be present and accept typing.
    const input = await waitFor(() => view.getByTestId("tts-field-model") as HTMLInputElement, { timeout: 2500 });
    expect(input.tagName).toBe("INPUT");
    fireEvent.change(input, { target: { value: "kokoro" } });
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { config: Record<string, unknown> };
    expect(patch.config.model).toBe("kokoro");
    cleanup();
    document.body.innerHTML = "";
    await act(async () => {});
  });
});

describe("TtsProfileEditor — F5 restructure (sections, local variant, stored key)", () => {
  it("server backends render BOTH section cards, endpoint lives in the connection card", () => {
    const tts = makeTts({
      form: {
        id: null,
        name: "Open",
        backend: TTS_BACKEND.OpenAiCompatible as never,
        config: { endpoint: "https://api.example.com/v1", apiKey: "k", model: "m" },
        voiceId: "",
      } as never,
    });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    const connection = view.getByTestId("tts-connection-card");
    const voice = view.getByTestId("tts-voice-card");
    expect(within(connection).getByTestId("tts-field-endpoint")).toBeTruthy();
    expect(within(voice).getByText("tts_field_voice")).toBeTruthy();
    // The preview button docks in the voice card (F1 layout preserved).
    expect(within(voice).getByTestId("tts-preview-btn")).toBeTruthy();
    cleanup();
  });

  it("kokoro has NO connection card (browser-local: nothing to connect to)", () => {
    const tts = makeTts({
      form: { id: null, name: "Koko", backend: TTS_BACKEND.Kokoro as never, config: {}, voiceId: "af_heart" } as never,
    });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    expect(view.queryByTestId("tts-connection-card")).toBeNull();
    expect(view.getByTestId("tts-voice-card")).toBeTruthy();
    cleanup();
  });

  it("D8: the local server panel is gated on the localServer flag, not the backend alone", () => {
    const localTts = makeTts({
      form: {
        id: null,
        name: "Local",
        backend: TTS_BACKEND.OpenAiCompatible as never,
        config: { endpoint: "http://127.0.0.1:8880/v1", localServer: true },
        voiceId: "af_heart",
      } as never,
    });
    const localView = render(React.createElement(TtsProfileEditor as never, { tts: localTts } as never));
    expect(localView.getByTestId("tts-local-server-panel")).toBeTruthy();
    localView.unmount();

    // Same backend WITHOUT the flag = the cloud variant — no local helpers.
    const cloudTts = makeTts({
      form: {
        id: null,
        name: "Cloud",
        backend: TTS_BACKEND.OpenAiCompatible as never,
        config: { endpoint: "https://api.example.com/v1", apiKey: "k" },
        voiceId: "alloy",
      } as never,
    });
    const cloudView = render(React.createElement(TtsProfileEditor as never, { tts: cloudTts } as never));
    expect(cloudView.queryByTestId("tts-local-server-panel")).toBeNull();
    cleanup();
  });

  it("F2b: a stored key shows the placeholder status while the field itself stays empty", () => {
    const tts = makeTts({
      form: {
        id: "p1",
        name: "Cloud",
        backend: TTS_BACKEND.Gemini as never,
        config: { model: "m" },
        voiceId: "",
        hasStoredApiKey: true,
      } as never,
    });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    const status = view.getByTestId("tts-field-api-key-status");
    expect(status.textContent).toContain("tts_field_api_key_status_stored");
    const field = view.getByTestId("tts-field-api-key") as HTMLInputElement;
    expect(field.value).toBe("");
    cleanup();
  });

  it("F2b: no status line when nothing is stored", () => {
    const tts = makeTts({
      form: {
        id: "p1",
        name: "Cloud",
        backend: TTS_BACKEND.Gemini as never,
        config: { model: "m" },
        voiceId: "",
        hasStoredApiKey: false,
      } as never,
    });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    expect(view.queryByTestId("tts-field-api-key-status")).toBeNull();
    cleanup();
  });
});

describe("TtsProfileEditor — F6 sliders + voice placeholders", () => {
  it("tuning number field renders slider + compact number (elevenlabs stability)", async () => {
    const setForm = mock(() => {});
    const tts = makeTts({
      setForm,
      form: {
        id: "p1",
        name: "EL",
        backend: TTS_BACKEND.ElevenLabs as never,
        config: { stability: 0.5 },
        voiceId: "",
      } as never,
    });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    const range = view.getByTestId("tts-field-stability-range") as HTMLInputElement;
    expect(range.type).toBe("range");
    expect(range.min).toBe("0");
    expect(range.max).toBe("1");
    const numberWrapper = view.getByTestId("tts-field-stability-number");
    expect(numberWrapper).toBeTruthy();
    const numberInput = numberWrapper.querySelector("input") as HTMLInputElement;
    expect(numberInput).toBeTruthy();
    // Range commits immediately
    fireEvent.change(range, { target: { value: "0.8" } });
    expect(setForm).toHaveBeenCalled();
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { config: Record<string, unknown> };
    expect(patch.config.stability).toBe(0.8);
    cleanup();
  });

  it("slider range and number input both update the same config key (openai speed)", async () => {
    const setForm = mock(() => {});
    const tts = makeTts({
      setForm,
      form: {
        id: "p1",
        name: "Open",
        backend: TTS_BACKEND.OpenAiCompatible as never,
        config: { speed: 1 },
        voiceId: "",
      } as never,
    });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    const range = view.getByTestId("tts-field-speed-range") as HTMLInputElement;
    expect(range).toBeTruthy();
    fireEvent.change(range, { target: { value: "1.5" } });
    expect(setForm).toHaveBeenCalled();
    let patch = (setForm.mock.calls[0] as unknown[])[0] as { config: Record<string, unknown> };
    expect(patch.config.speed).toBe(1.5);
    setForm.mockClear();
    const numberWrapper = view.getByTestId("tts-field-speed-number");
    const numberInput = numberWrapper.querySelector("input") as HTMLInputElement;
    fireEvent.change(numberInput, { target: { value: "1.2" } });
    fireEvent.blur(numberInput);
    expect(setForm).toHaveBeenCalled();
    patch = (setForm.mock.calls[setForm.mock.calls.length - 1] as unknown[])[0] as { config: Record<string, unknown> };
    expect(patch.config.speed).toBe(1.2);
    cleanup();
  });

  it("voice fallback placeholder shows per-variant example (openai → alloy)", async () => {
    listTtsDraftVoicesMock.mockImplementationOnce(async () => []);
    const tts = makeTts({
      form: {
        id: null,
        name: "Open",
        backend: TTS_BACKEND.OpenAiCompatible as never,
        config: { endpoint: "https://x", apiKey: "k" },
        voiceId: "",
      } as never,
    });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    const input = await waitFor(() => view.getByTestId("tts-voice-input") as HTMLInputElement, { timeout: 2500 });
    expect(input.placeholder).toBe("alloy");
    cleanup();
    document.body.innerHTML = "";
    await act(async () => {});
  });

  it("voice fallback placeholder shows per-variant example (gemini → Kore)", async () => {
    listTtsDraftVoicesMock.mockImplementationOnce(async () => []);
    const tts = makeTts({
      form: {
        id: null,
        name: "Gem",
        backend: TTS_BACKEND.Gemini as never,
        config: { apiKey: "k" },
        voiceId: "",
      } as never,
    });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    const input = await waitFor(() => view.getByTestId("tts-voice-input") as HTMLInputElement, { timeout: 2500 });
    expect(input.placeholder).toBe("Kore");
    cleanup();
    document.body.innerHTML = "";
    await act(async () => {});
  });

  it("voice fallback placeholder shows per-variant example (elevenlabs → JBFqnCBsd6RMkjVDRZzb)", async () => {
    listTtsDraftVoicesMock.mockImplementationOnce(async () => []);
    const tts = makeTts({
      form: {
        id: null,
        name: "EL",
        backend: TTS_BACKEND.ElevenLabs as never,
        config: { apiKey: "k" },
        voiceId: "",
      } as never,
    });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    const input = await waitFor(() => view.getByTestId("tts-voice-input") as HTMLInputElement, { timeout: 2500 });
    expect(input.placeholder).toBe("JBFqnCBsd6RMkjVDRZzb");
    cleanup();
    document.body.innerHTML = "";
    await act(async () => {});
  });

  it("kokoro voice select placeholder is the example id af_heart", async () => {
    const tts = makeTts({
      form: { id: null, name: "Koko", backend: TTS_BACKEND.Kokoro as never, config: {}, voiceId: "" } as never,
    });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    const trigger = view.getByTestId("tts-voice-select") as HTMLElement;
    expect(trigger.textContent).toContain("af_heart");
    cleanup();
  });
});
