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

  it("quickstart selection is only offered for openai-compat", async () => {
    const stt = makeStt({ headerMode: "edit" });
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-quickstart-select")).toBeTruthy());
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

  it("gemini edit form: connection only — no endpoint/quickstart/model/language/emotion", async () => {
    const stt = geminiStt(false, "edit");
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-profile-editor")).toBeTruthy());
    expect(view.queryByTestId("stt-field-endpoint")).toBeNull();
    expect(view.queryByTestId("stt-quickstart-select")).toBeNull();
    expect(view.queryByTestId("stt-field-model")).toBeNull();
    expect(view.queryByTestId("stt-field-language")).toBeNull();
    expect(view.queryByTestId("stt-emotion-toggle-block")).toBeNull();
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
