import { describe, expect, it, afterEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

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
});

describe("SttProfileEditor — view mode", () => {
  it("renders the base card with the profile name and the connection fields", async () => {
    const stt = makeStt();
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-base-card")).toBeTruthy());
    expect(view.getByTestId("stt-base-card-name").textContent).toBe("Dictation");
    // OpenAI-compat fields: endpoint + model inputs.
    expect(view.getByTestId("stt-field-endpoint")).toBeTruthy();
    expect(view.getByTestId("stt-field-model")).toBeTruthy();
    // Language field is optional — present for openai-compat.
    expect(view.getByTestId("stt-field-language")).toBeTruthy();
    // No browser badge for an openai-compat profile.
    expect(view.queryByTestId("stt-backend-browser-note")).toBeNull();
  });

  it("whisper-browser view hides the API key + shows the roster dropdown", async () => {
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

  it("edit mode renders the connection form (health: exposes test card)", async () => {
    const stt = makeStt({ headerMode: "edit", dirty: false });
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-profile-name-input")).toBeTruthy());
    // A saved + clean openai-compat profile gets the test connection card.
    expect(view.getByTestId("stt-test-card")).toBeTruthy();
    expect(view.getByTestId("stt-test-connection-btn")).toBeTruthy();
  });

  it("edit mode on an unsaved/dirty form disables the test (save-first hint)", async () => {
    const stt = makeStt({ headerMode: "edit", dirty: true });
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-profile-name-input")).toBeTruthy());
    expect(view.getByTestId("stt-test-dot-save-first")).toBeTruthy();
    expect(view.queryByTestId("stt-test-connection-btn")).toBeNull();
  });

  it("quickstart selection is only offered for openai-compat", async () => {
    const stt = makeStt({ headerMode: "edit" });
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-quickstart-select")).toBeTruthy());
  });
});

describe("SttProfileEditor — Gemini backend + emotion toggle (ST-7)", () => {
  function geminiStt(emotion = false) {
    const form = makeForm({
      backend: "gemini",
      config: { model: "gemini-3.8-flash" },
      emotionAnnotation: emotion,
    });
    return makeStt({
      form,
      headerMode: "edit",
      profiles: [makeRecord({ backend: "gemini", config: { model: "gemini-3.8-flash" }, emotionAnnotation: emotion })],
    });
  }

  it("gemini edit form: no endpoint/quickstart, free-text model, key field — and the emotion toggle renders", async () => {
    const stt = geminiStt();
    const view = render(React.createElement(SttProfileEditor, { stt: stt as never }));
    await waitFor(() => expect(view.getByTestId("stt-emotion-toggle-block")).toBeTruthy());
    // Fixed endpoint: no endpoint input, no quickstart select.
    expect(view.queryByTestId("stt-field-endpoint")).toBeNull();
    expect(view.queryByTestId("stt-quickstart-select")).toBeNull();
    // Free-text model + language field render.
    expect(view.getByTestId("stt-field-model")).toBeTruthy();
    expect(view.getByTestId("stt-field-language")).toBeTruthy();
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
        headerMode: "edit",
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
