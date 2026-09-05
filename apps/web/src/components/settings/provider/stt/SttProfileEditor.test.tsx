import { describe, expect, it, afterEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";
import { __setWhisperLaneProbeForTests } from "../../../../lib/stt/whisper-client-instance.js";

useDomEnv();

const realI18n = await import("../../../../i18n/context.js");
mock.module("../../../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && typeof params === "object" && "name" in params
        ? `${key}:${String(params.name)}`
        : key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

// Live model discovery (P8): safe mock.module pattern — real module first,
// spread, override ONLY the draft-models fetch. The editor effect debounces
// 400 ms, so tests waitFor the picker state.
const realSttApi = await import("../../../../api/stt-api.js");
const listSttDraftModelsMock = mock(async (_body: {
  backend: string;
  config: Record<string, unknown>;
  profileId?: string;
}) => [
  { id: "whisper-1", label: "Whisper v1" },
  { id: "gpt-4o-transcribe", label: "GPT-4o Transcribe", isFree: true },
]);
mock.module("../../../../api/stt-api.js", () => ({
  ...realSttApi,
  listSttDraftModels: listSttDraftModelsMock,
}));

const { act, cleanup, waitFor, render } = await import("@testing-library/react");
const { SttProfileEditor } = await import("./SttProfileEditor.js");
const { DEFAULT_WHISPER_MODEL_ID } = await import("@vibe-tavern/domain");

type SttRecord = import("../../../../api/stt-api.js").SttProfileRecord;

function makeRecord(overrides: Partial<SttRecord> = {}): SttRecord {
  return {
    id: "p1",
    name: "Dictation",
    backend: "openai-compat",
    config: { endpoint: "https://api.openai.com/v1", model: "whisper-1" },
    hasStoredApiKey: false,
    autoKeyProviderName: null,
    emotionAnnotation: false,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Hydrate a form from a record the way useSttProfiles.select does — the
 *  editor under test is decoupled from the hook, so a plain object with the
 *  same shape is enough. */
function makeForm(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    name: "Dictation",
    backend: "openai-compat",
    config: { endpoint: "https://api.openai.com/v1", model: "whisper-1" },
    apiKey: "",
    autoKeyProviderName: null,
    hasStoredApiKey: false,
    ...overrides,
  };
}

function makeStt(overrides: Record<string, unknown> = {}) {
  const setForm = mock((patch: Record<string, unknown>) => {});
  return {
    profiles: [makeRecord()] as SttRecord[],
    loading: false,
    editingId: "p1",
    form: makeForm(),
    dirty: false,
    error: null,
    saving: false,
    headerMode: "view",
    startEdit: mock(() => {}),
    setDefault: mock(async () => {}),
    select: mock(() => {}),
    startCreate: mock(() => {}),
    setForm,
    save: mock(async () => {}),
    remove: mock(async () => {}),
    cancelEdit: mock(() => {}),
    reload: mock(async () => {}),
    ...overrides,
  };
}

afterEach(async () => {
  await act(async () => {});
  cleanup();
  listSttDraftModelsMock.mockClear();
});

describe("SttProfileEditor — view mode (level-2 recognition settings)", () => {
  it("renders the base card with the profile name; model picker + language below, NO endpoint field (connection-level)", async () => {
    const stt = makeStt();
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-base-card")).toBeTruthy());
    expect(view.getByTestId("stt-base-card-name").textContent).toBe("Dictation");
    // The fetched picker trigger (openai-compat → fetch mode).
    await waitFor(() => expect(view.getByTestId("stt-field-model").textContent).toBe("Whisper v1"), { timeout: 2000 });
    // Language field is optional — present for openai-compat.
    expect(view.getByTestId("stt-field-language")).toBeTruthy();
    // P8 governing rule: the endpoint is connection-level — view mode shows
    // it ONLY as the base-card host label, never as an editable field.
    expect(view.queryByTestId("stt-field-endpoint")).toBeNull();
    // No browser badge for an openai-compat profile.
    expect(view.queryByTestId("stt-backend-browser-note")).toBeNull();
    // The fetch rode the draft route with backend + profileId.
    expect(listSttDraftModelsMock).toHaveBeenCalled();
    const call = listSttDraftModelsMock.mock.calls[0][0];
    expect(call.backend).toBe("openai-compat");
    expect(call.profileId).toBe("p1");
  });

  it("whisper-browser view hides the API key + shows the roster dropdown (no fetch)", async () => {
    const stt = makeStt({
      form: makeForm({ backend: "whisper-browser", config: { model: DEFAULT_WHISPER_MODEL_ID } }),
      profiles: [makeRecord({ backend: "whisper-browser", config: { model: DEFAULT_WHISPER_MODEL_ID } })],
    });
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-whisper-model-select")).toBeTruthy());
    // No key field for a browser profile.
    expect(view.queryByTestId("stt-field-api-key")).toBeNull();
    // Browser note (runs in browser) is shown.
    expect(view.getByTestId("stt-backend-browser-note")).toBeTruthy();
    // Fixed local roster — the draft-models route is never called.
    expect(listSttDraftModelsMock).not.toHaveBeenCalled();
  });

  it("language field hides for English-only whisper models", async () => {
    const stt = makeStt({
      form: makeForm({
        backend: "whisper-browser",
        config: { model: "onnx-community/whisper-tiny.en" },
      }),
      profiles: [
        makeRecord({
          backend: "whisper-browser",
          config: { model: "onnx-community/whisper-tiny.en" },
        }),
      ],
    });
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-whisper-model-select")).toBeTruthy());
    expect(view.queryByTestId("stt-field-language")).toBeNull();
  });

  it("an empty model settles on the first fetched entry (D20 rule, the TTS twin)", async () => {
    const stt = makeStt({
      form: makeForm({ config: { endpoint: "https://api.openai.com/v1" } }),
    });
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-field-model")).toBeTruthy());
    await waitFor(
      () => {
        const calls = (stt.setForm.mock.calls as unknown[][]).map((c) => c[0] as Record<string, unknown>);
        const settled = calls.some(
          (patch) =>
            patch !== undefined &&
            typeof patch === "object" &&
            "config" in patch &&
            (patch["config"] as Record<string, unknown>)["model"] === "whisper-1",
        );
        expect(settled).toBe(true);
      },
      { timeout: 2000 },
    );
  });

  it("refresh button re-runs the fetch on demand", async () => {
    const stt = makeStt();
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-field-model").textContent).toBe("Whisper v1"), { timeout: 2000 });
    const before = listSttDraftModelsMock.mock.calls.length;
    await act(async () => {
      view.getByTestId("stt-models-refresh").click();
    });
    await waitFor(() => expect(listSttDraftModelsMock.mock.calls.length).toBeGreaterThan(before));
  });
});

describe("SttProfileEditor — edit mode (level-1 connection card)", () => {
  it("renders the connection form (health: exposes test card)", async () => {
    const stt = makeStt({ headerMode: "edit", dirty: false });
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-profile-name-input")).toBeTruthy());
    // A saved + clean openai-compat profile gets the test connection card.
    expect(view.getByTestId("stt-test-card")).toBeTruthy();
    expect(view.getByTestId("stt-test-connection-btn")).toBeTruthy();
    // The connection-level endpoint input renders for openai-compat.
    expect(view.getByTestId("stt-field-endpoint")).toBeTruthy();
  });

  it("GOVERNING-RULE PIN: no model / language / emotion inside the connection form", async () => {
    const stt = makeStt({ headerMode: "edit", dirty: true });
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-profile-name-input")).toBeTruthy());
    expect(view.queryByTestId("stt-field-model")).toBeNull();
    expect(view.queryByTestId("stt-field-language")).toBeNull();
    expect(view.queryByTestId("stt-emotion-toggle-block")).toBeNull();
    // Edit mode never fires the model fetch (view-mode-gated).
    expect(listSttDraftModelsMock).not.toHaveBeenCalled();
  });

  it("P10 PIN: a dirty/unsaved draft gets the probe button (TTS parity — no save-first)", async () => {
    const stt = makeStt({ headerMode: "edit", dirty: true, form: makeForm({ id: null }) });
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-profile-name-input")).toBeTruthy());
    expect(view.queryByTestId("stt-test-dot-save-first")).toBeNull();
    expect(view.getByTestId("stt-test-connection-btn")).toBeTruthy();
  });

  it("P10: the test button probes the catalog via the draft-models route (key rides inside the draft config)", async () => {
    const stt = makeStt({
      headerMode: "edit",
      form: makeForm({ apiKey: "sk-live", config: { endpoint: "https://api.openai.com/v1", model: "whisper-1" } }),
    });
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-test-connection-btn")).toBeTruthy());
    await act(async () => {
      view.getByTestId("stt-test-connection-btn").click();
    });
    await waitFor(() => expect(view.getByTestId("stt-test-success")).toBeTruthy());
    const call = listSttDraftModelsMock.mock.calls.at(-1)?.[0];
    expect(call?.backend).toBe("openai-compat");
    expect(call?.profileId).toBe("p1");
    expect(call?.config["apiKey"]).toBe("sk-live");
  });

  it("P10: a rejected probe shows the failure badge (probe semantics, no transcription)", async () => {
    const stt = makeStt({ headerMode: "edit" });
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-test-connection-btn")).toBeTruthy());
    listSttDraftModelsMock.mockImplementationOnce(() => Promise.reject(new Error("probe failed: 502")));
    await act(async () => {
      view.getByTestId("stt-test-connection-btn").click();
    });
    await waitFor(() => expect(view.getByTestId("stt-test-failure")).toBeTruthy());
  });

  it("SPE-8 gating: the preset dropdown renders for cloud + native, never for custom/local/browser", async () => {
    // Cloud (endpoint-matched openai row) → offered.
    const cloud = makeStt({ headerMode: "edit" });
    const cloudView = render(React.createElement(SttProfileEditor, { stt: cloud as never }));
    await waitFor(() => expect(cloudView.getByTestId("stt-backend-select").textContent).toContain("Cloud"));
    expect(cloudView.getByTestId("stt-quickstart-select")).toBeTruthy();
    // The cloud arm never shows the local panel (TTS localHelpers twin).
    expect(cloudView.queryByTestId("stt-local-server-panel")).toBeNull();
    cleanup();
    // Custom (bare endpoint, no row match) → hidden, endpoint editable.
    const custom = makeStt({
      headerMode: "edit",
      form: makeForm({ config: { endpoint: "https://custom.example/v1", model: "whisper-1" } }),
    });
    const customView = render(React.createElement(SttProfileEditor, { stt: custom as never }));
    await waitFor(() => expect(customView.getByTestId("stt-backend-select").textContent).toContain("custom"));
    expect(customView.queryByTestId("stt-quickstart-select")).toBeNull();
    expect(customView.getByTestId("stt-field-endpoint")).toBeTruthy();
    cleanup();
    // Local (localServer flag) → named local rows (SPE-9), endpoint editable, panel shown.
    const local = makeStt({
      headerMode: "edit",
      form: makeForm({ config: { localServer: true, endpoint: "http://127.0.0.1:8000/v1", model: "whisper-1" } }),
    });
    const localView = render(React.createElement(SttProfileEditor, { stt: local as never }));
    await waitFor(() =>
      expect(localView.getByTestId("stt-backend-select").textContent).toContain("stt_segment_local"),
    );
    // SPE-9: the Local segment carries its named rows — no longer a bare
    // segment without a dropdown. The generic row never auto-detects
    // (empty baseUrl — TTS preset rule), so the trigger shows the
    // placeholder while the OPENED list offers both local rows.
    expect(localView.getByTestId("stt-quickstart-select")).toBeTruthy();
    await act(async () => {
      localView.getByTestId("stt-quickstart-select").click();
    });
    await waitFor(() => {
      const body = document.body.textContent ?? "";
      expect(body).toContain("stt_preset_local");
      expect(body).toContain("stt_preset_whisper_cpp");
    });
    expect(localView.getByTestId("stt-field-endpoint")).toBeTruthy();
    expect(localView.getByTestId("stt-local-server-panel")).toBeTruthy();
    cleanup();
  });

  it("cloud preset apply fills endpoint + default model (openrouter)", async () => {
    const stt = makeStt({ headerMode: "edit" });
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-quickstart-select")).toBeTruthy());
    await act(async () => {
      view.getByTestId("stt-quickstart-select").click();
    });
    const option = await waitFor(() => {
      const el = Array.from(document.body.querySelectorAll("[cmdk-item]")).find(
        (n) => n.textContent?.trim() === "stt_preset_openrouter",
      );
      expect(el).toBeTruthy();
      return el!;
    });
    await act(async () => {
      (option as HTMLElement).click();
    });
    const calls = (stt.setForm.mock.calls as unknown[][]).map((c) => c[0] as Record<string, unknown>);
    const applied = calls.find(
      (patch) =>
        typeof patch["config"] === "object" &&
        patch["config"] !== null &&
        (patch["config"] as Record<string, unknown>)["endpoint"] === "https://openrouter.ai/api/v1",
    );
    expect(applied).toBeTruthy();
    expect((applied!["config"] as Record<string, unknown>)["model"]).toBe("openai/whisper-large-v3");
  });
});

describe("SttProfileEditor — Gemini backend + emotion toggle (ST-7, level-2 since P8)", () => {
  function geminiStt(emotion = false, headerMode: "view" | "edit" = "view") {
    const form = makeForm({
      backend: "gemini",
      config: { model: "gemini-3.8-flash" },
      emotionAnnotation: emotion,
    });
    return makeStt({
      form,
      headerMode,
      profiles: [makeRecord({ backend: "gemini", config: { model: "gemini-3.8-flash" }, emotionAnnotation: emotion })],
    });
  }

  it("gemini view: picker + language + key-less base card — and the emotion toggle renders", async () => {
    const stt = geminiStt();
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-emotion-toggle-block")).toBeTruthy());
    // Fixed endpoint: no endpoint input even as a connection field in view.
    expect(view.queryByTestId("stt-field-endpoint")).toBeNull();
    // Fetched picker + language field render (level 2).
    expect(view.getByTestId("stt-field-model")).toBeTruthy();
    expect(view.getByTestId("stt-field-language")).toBeTruthy();
    // The catalog fetch went out with the gemini backend slug.
    await waitFor(() => expect(listSttDraftModelsMock).toHaveBeenCalled(), { timeout: 2000 });
    expect(listSttDraftModelsMock.mock.calls[0][0].backend).toBe("gemini");
  });

  it("gemini edit form: Native segment — connection only, preset dropdown offers the native rows", async () => {
    const stt = geminiStt(false, "edit");
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-profile-editor")).toBeTruthy());
    // SPE-8: gemini is a native preset row — the segment reads Native.
    expect(view.getByTestId("stt-backend-select").textContent).toContain("Native");
    expect(view.queryByTestId("stt-field-endpoint")).toBeNull();
    expect(view.queryByTestId("stt-field-model")).toBeNull();
    expect(view.queryByTestId("stt-field-language")).toBeNull();
    expect(view.queryByTestId("stt-emotion-toggle-block")).toBeNull();
    // The native preset dropdown shows the backing row selected.
    expect(view.getByTestId("stt-quickstart-select").textContent).toContain("stt_preset_gemini");
    // Server backend → the key field renders.
    expect(view.getByTestId("stt-field-api-key")).toBeTruthy();
  });

  it("emotion toggle is hidden for whisper-browser and openai-compat (pure-ASR backends)", async () => {
    for (const backend of ["whisper-browser", "openai-compat"] as const) {
      const config =
        backend === "whisper-browser"
          ? { model: DEFAULT_WHISPER_MODEL_ID }
          : { endpoint: "https://api.openai.com/v1", model: "whisper-1" };
      const stt = makeStt({
        form: makeForm({ backend, config, emotionAnnotation: false }),
        profiles: [makeRecord({ backend, config })],
      });
      const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
      await waitFor(() => expect(view.getByTestId("stt-profile-editor")).toBeTruthy());
      expect(view.queryByTestId("stt-emotion-toggle-block")).toBeNull();
      cleanup();
    }
  });

  it("clicking the toggle flips the form flag through setForm", async () => {
    const stt = geminiStt();
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-emotion-toggle")).toBeTruthy());
    expect(view.getByTestId("stt-emotion-toggle").getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      view.getByTestId("stt-emotion-toggle").click();
    });
    expect(stt.setForm).toHaveBeenCalledWith({ emotionAnnotation: true });
  });
});

describe("SttProfileEditor — P12 language dropdown", () => {
  function whisperView(config: Record<string, unknown>) {
    return makeStt({
      form: makeForm({ backend: "whisper-browser", config, apiKey: "" }),
      profiles: [makeRecord({ backend: "whisper-browser", config })],
    });
  }

  afterEach(() => {
    __setWhisperLaneProbeForTests(null);
  });

  it("empty language shows the pinned interface entry in the trigger", async () => {
    const stt = whisperView({ model: "onnx-community/whisper-small" });
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-field-language")).toBeTruthy());
    // The mocked t() returns the key — the trigger shows the entry label.
    expect(view.getByTestId("stt-field-language").textContent).toContain("stt_field_language_interface");
  });

  it("a stored code renders the matching human label", async () => {
    const stt = whisperView({ model: "onnx-community/whisper-small", language: "ru" });
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-field-language")).toBeTruthy());
    expect(view.getByTestId("stt-field-language").textContent).toContain("Russian (ru)");
  });

  it("level-2 model detail follows the lane (cpu q8, gpu fp32+q4)", async () => {
    const stt = whisperView({ model: "onnx-community/whisper-small" });
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-whisper-model-select")).toBeTruthy());
    expect(view.getByTestId("stt-whisper-model-select").textContent).toContain("250 MB");
    cleanup();
    __setWhisperLaneProbeForTests(() => "webgpu");
    const gpu = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(gpu.getByTestId("stt-whisper-model-select")).toBeTruthy());
    expect(gpu.getByTestId("stt-whisper-model-select").textContent).toContain("570 MB");
  });
});


describe('SttProfileEditor — native backends (SPE-4..6, SPE-7 picker)', () => {
  function nativeStt(backend: string, model: string, headerMode: 'view' | 'edit' = 'view') {
    const form = makeForm({ backend, config: { model }, emotionAnnotation: false });
    return makeStt({
      form,
      headerMode,
      profiles: [makeRecord({ backend, config: { model } })],
    });
  }

  it('edit form: SPE-8 group taxonomy — segment offers browser/Cloud/Native/Local/Custom; the native preset dropdown offers the native rows', async () => {
    const stt = nativeStt('nvidia', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', 'edit');
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId('stt-backend-select')).toBeTruthy());
    // The closed segment trigger shows the SELECTED segment (literal).
    expect(view.getByTestId('stt-backend-select').textContent).toContain('Native');
    await act(async () => {
      view.getByTestId('stt-backend-select').click();
    });
    // Open the segment list to pin the taxonomy (cmdk items render into
    // the body portal) — backends are NOT segment options anymore.
    await waitFor(() => {
      const body = document.body.textContent ?? '';
      expect(body).toContain('stt_segment_whisper');
      expect(body).toContain('Cloud');
      expect(body).toContain('Native');
      expect(body).toContain('stt_segment_local');
      expect(body).not.toContain('stt_segment_nvidia');
    });
    // The native preset dropdown shows the backing row selected; open it
    // to pin the native offering (gemini joined the rows in SPE-8).
    expect(view.getByTestId('stt-quickstart-select').textContent).toContain('stt_preset_nvidia');
    await act(async () => {
      view.getByTestId('stt-quickstart-select').click();
    });
    await waitFor(() => {
      const body = document.body.textContent ?? '';
      expect(body).toContain('stt_preset_gemini');
      expect(body).toContain('stt_preset_deepgram');
      expect(body).toContain('stt_preset_elevenlabs');
      expect(body).toContain('stt_preset_nvidia');
      expect(body).not.toContain('stt_preset_openai');
    });
    // The mocked t() echoes the key — the EN-only warning is data-driven
    // (englishOnly flag on the nvidia preset row).
    expect(view.getByTestId('stt-nvidia-en-only-hint').textContent).toContain('stt_nvidia_en_only');
    expect(view.queryByTestId('stt-deepgram-ru-note')).toBeNull();
    // Fixed-endpoint natives show no endpoint field.
    expect(view.queryByTestId('stt-field-endpoint')).toBeNull();
  });

  it('edit form: native preset apply switches the backend slug (nvidia → gemini)', async () => {
    const stt = nativeStt('nvidia', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', 'edit');
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId('stt-quickstart-select')).toBeTruthy());
    await act(async () => {
      view.getByTestId('stt-quickstart-select').click();
    });
    const option = await waitFor(() => {
      const el = Array.from(document.body.querySelectorAll('[cmdk-item]')).find(
        (n) => n.textContent?.trim() === 'stt_preset_gemini',
      );
      expect(el).toBeTruthy();
      return el!;
    });
    await act(async () => {
      (option as HTMLElement).click();
    });
    // The hook's backend-switch branch owns the reset + default prefill.
    const calls = (stt.setForm.mock.calls as unknown[][]).map((c) => c[0] as Record<string, unknown>);
    expect(calls.some((patch) => patch['backend'] === 'gemini')).toBe(true);
  });

  it('edit form: segment switch to Local stamps the flag + port suggestion; to Custom wipes the config', async () => {
    const stt = makeStt({ headerMode: 'edit' });
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId('stt-backend-select')).toBeTruthy());
    async function pickSegment(label: string) {
      await act(async () => {
        view.getByTestId('stt-backend-select').click();
      });
      const option = await waitFor(() => {
        const el = Array.from(document.body.querySelectorAll('[cmdk-item]')).find((n) =>
          (n.textContent ?? '').includes(label),
        );
        expect(el).toBeTruthy();
        return el!;
      });
      await act(async () => {
        (option as HTMLElement).click();
      });
    }
    await pickSegment('stt_segment_local');
    const calls = (stt.setForm.mock.calls as unknown[][]).map((c) => c[0] as Record<string, unknown>);
    const localed = calls.find(
      (patch) =>
        typeof patch['config'] === 'object' &&
        patch['config'] !== null &&
        (patch['config'] as Record<string, unknown>)['localServer'] === true,
    );
    expect(localed).toBeTruthy();
    expect((localed!['config'] as Record<string, unknown>)['endpoint']).toBe('http://127.0.0.1:8000/v1');
    await pickSegment('custom');
    const wiped = (stt.setForm.mock.calls as unknown[][])
      .map((c) => c[0] as Record<string, unknown>)
      .some((patch) => {
        const cfg = patch['config'] as Record<string, unknown> | undefined;
        return cfg !== undefined && Object.keys(cfg).length === 0;
      });
    expect(wiped).toBe(true);
  });

  // RTL binds queries to document.body (baseElement), so a second render in
  // the SAME test would see the first form's DOM — one render per test.
  it('edit form: deepgram renders the RU note, not the EN-only warning', async () => {
    const stt = nativeStt('deepgram', 'nova-3', 'edit');
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId('stt-deepgram-ru-note')).toBeTruthy());
    expect(view.queryByTestId('stt-nvidia-en-only-hint')).toBeNull();
  });

  it('edit form: natives get the key field + probe button + native preset dropdown, no endpoint field', async () => {
    const stt = nativeStt('elevenlabs', 'scribe_v2', 'edit');
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId('stt-test-connection-btn')).toBeTruthy());
    expect(view.getByTestId('stt-field-api-key')).toBeTruthy();
    expect(view.queryByTestId('stt-field-endpoint')).toBeNull();
    // SPE-8: natives are preset rows — the dropdown offers them.
    expect(view.getByTestId('stt-quickstart-select').textContent).toContain('stt_preset_elevenlabs');
  });

  it('elevenlabs view: the STATIC Scribe roster feeds the picker, refresh hidden, language kept', async () => {
    const stt = nativeStt('elevenlabs', 'scribe_v2');
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId('stt-field-model')).toBeTruthy());
    // No draft-models call — the roster is preset data, not a fetch.
    expect(listSttDraftModelsMock).not.toHaveBeenCalled();
    expect(view.queryByTestId('stt-models-refresh')).toBeNull();
    // language_code is a real elevenlabs field — the picker stays.
    expect(view.getByTestId('stt-field-language')).toBeTruthy();
    // Base card labels the fixed-endpoint native by name.
    expect(view.getByTestId('stt-base-card-status').textContent).toContain('ElevenLabs');
  });

  it('nvidia view: static roster, language hidden (adapter ignores it — EN-only)', async () => {
    const stt = nativeStt('nvidia', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning');
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId('stt-field-model')).toBeTruthy());
    expect(listSttDraftModelsMock).not.toHaveBeenCalled();
    expect(view.queryByTestId('stt-field-language')).toBeNull();
  });

  it('deepgram view: FETCHED picker (live /v1/models catalog)', async () => {
    const stt = nativeStt('deepgram', 'nova-3');
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(listSttDraftModelsMock).toHaveBeenCalled(), { timeout: 2000 });
    expect(listSttDraftModelsMock.mock.calls[0][0].backend).toBe('deepgram');
    expect(view.getByTestId('stt-models-refresh')).toBeTruthy();
    // The RU note is an EDIT-form element (under the segment dropdown) —
    // view mode shows the base card, never the connection form.
    expect(view.queryByTestId('stt-deepgram-ru-note')).toBeNull();
  });
});

describe('SttProfileEditor — whisper.cpp own-wire local backend (SPE-9)', () => {
  function whisperCppStt(headerMode: 'view' | 'edit') {
    const form = makeForm({
      backend: 'whisper-cpp',
      config: { endpoint: 'http://127.0.0.1:8080' },
      emotionAnnotation: false,
    });
    return makeStt({
      form,
      headerMode,
      profiles: [makeRecord({ backend: 'whisper-cpp', config: { endpoint: 'http://127.0.0.1:8080' } })],
    });
  }

  it('edit form: resolves the LOCAL segment, offers the named local rows, editable endpoint, no key field', async () => {
    const stt = whisperCppStt('edit');
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId('stt-backend-select')).toBeTruthy());
    // Segment derivation: the own-wire local backend resolves LOCAL, never
    // native (the sttProviderSegmentOf whisper-cpp branch).
    expect(view.getByTestId('stt-backend-select').textContent).toContain('stt_segment_local');
    // The Local preset dropdown carries the named rows (generic server +
    // whisper.cpp — the LLM-tab local-group shape).
    expect(view.getByTestId('stt-quickstart-select').textContent).toContain('stt_preset_whisper_cpp');
    await act(async () => {
      view.getByTestId('stt-quickstart-select').click();
    });
    await waitFor(() => {
      const body = document.body.textContent ?? '';
      expect(body).toContain('stt_preset_local');
      expect(body).toContain('stt_preset_whisper_cpp');
      expect(body).not.toContain('stt_preset_openai');
    });
    // The endpoint is a PREFILL, not fixed — editable local address.
    expect(view.getByTestId('stt-field-endpoint')).toBeTruthy();
    expect((view.getByTestId('stt-field-endpoint') as HTMLInputElement).value).toBe('http://127.0.0.1:8080');
    // Keyless server — no key field (the server checks no auth).
    expect(view.queryByTestId('stt-field-api-key')).toBeNull();
    // The probe/Test button stays (probe fallback — the health route).
    expect(view.getByTestId('stt-test-connection-btn')).toBeTruthy();
  });

  it('view mode: server-bound model — the picker is replaced by the server-flags hint; language stays', async () => {
    const stt = whisperCppStt('view');
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId('stt-whispercpp-server-model-hint')).toBeTruthy());
    // No model picker and no fetch — the model is bound at server start.
    expect(view.queryByTestId('stt-field-model')).toBeNull();
    expect(listSttDraftModelsMock).not.toHaveBeenCalled();
    // The server accepts a per-request `language` multipart field — the
    // hint stays.
    expect(view.getByTestId('stt-field-language')).toBeTruthy();
    // Base card labels the own-wire local backend.
    expect(view.getByTestId('stt-base-card-status').textContent).toContain('whisper.cpp');
  });

  it('edit form: applying the whisper.cpp row from the generic local server stamps the backend slug + endpoint prefill', async () => {
    const form = makeForm({
      backend: 'openai-compat',
      config: { localServer: true, endpoint: 'http://127.0.0.1:8000/v1', model: 'whisper-1' },
      emotionAnnotation: false,
    });
    const stt = makeStt({ headerMode: 'edit', form });
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId('stt-quickstart-select')).toBeTruthy());
    await act(async () => {
      view.getByTestId('stt-quickstart-select').click();
    });
    const option = await waitFor(() => {
      const el = Array.from(document.body.querySelectorAll('[cmdk-item]')).find(
        (n) => n.textContent?.trim() === 'stt_preset_whisper_cpp',
      );
      expect(el).toBeTruthy();
      return el!;
    });
    await act(async () => {
      (option as HTMLElement).click();
    });
    const calls = (stt.setForm.mock.calls as unknown[][]).map((c) => c[0] as Record<string, unknown>);
    const slugSwitch = calls.find((patch) => patch['backend'] === 'whisper-cpp');
    expect(slugSwitch).toBeTruthy();
    const configPatch = calls.find(
      (patch) =>
        typeof patch['config'] === 'object' &&
        patch['config'] !== null &&
        (patch['config'] as Record<string, unknown>)['endpoint'] === 'http://127.0.0.1:8080',
    );
    expect(configPatch).toBeTruthy();
    expect((configPatch!['config'] as Record<string, unknown>)['localServer']).toBe(true);
    // No model key rides the apply — the model is server-bound.
    expect((configPatch!['config'] as Record<string, unknown>)['model']).toBeUndefined();
  });
});
