import { afterEach, describe, expect, mock, test } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

// House i18n test pattern (SttSection.test.tsx): raw keys render as-is.
const realI18n = await import("../../../../i18n/context.js");
mock.module("../../../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

const { render, act, cleanup } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
const { SttLocalServerPanel } = await import("./SttLocalServerPanel.js");
const { __setSttDiscoveryDepsForTests } = await import("./use-stt-discovery.js");
const { STT_BACKENDS } = await import("@vibe-tavern/domain");
import type { DiscoveredServer, ProbeOutcome } from "@vibe-tavern/domain";
import type { SttProfileForm } from "./use-stt-profiles.js";

function openaiForm(): SttProfileForm {
  return {
    id: null,
    name: "",
    backend: STT_BACKENDS.OpenAiCompat,
    config: { endpoint: "", model: "" },
    apiKey: "",
    autoKeyProviderName: null,
    hasStoredApiKey: false,
      emotionAnnotation: false,
  };
}

function whisperForm(): SttProfileForm {
  return {
    id: null,
    name: "",
    backend: STT_BACKENDS.WhisperBrowser,
    config: { model: "onnx-community/whisper-base" },
    apiKey: "",
    autoKeyProviderName: null,
    hasStoredApiKey: false,
      emotionAnnotation: false,
  };
}

function whisperCppForm(): SttProfileForm {
  return {
    id: null,
    name: "",
    backend: STT_BACKENDS.WhisperCpp,
    config: { endpoint: "" },
    apiKey: "",
    autoKeyProviderName: null,
    hasStoredApiKey: false,
      emotionAnnotation: false,
  };
}

function foundServer(port: number, modelIds: string[]): DiscoveredServer {
  return { port, baseUrl: `http://127.0.0.1:${port}`, kind: "openai-compatible", voiceIds: [], modelIds };
}

function renderPanel(form: SttProfileForm, setForm: (p: Partial<SttProfileForm>) => void) {
  return render(React.createElement(SttLocalServerPanel, { form, stt: { setForm } }));
}

afterEach(() => {
  __setSttDiscoveryDepsForTests(null);
  cleanup();
});

describe("SttLocalServerPanel", () => {
  test("renders for both local rows (compat + whisper.cpp), null for whisper-browser", () => {
    const view = renderPanel(openaiForm(), mock(() => {}));
    expect(view.queryByTestId("stt-local-server-panel")).not.toBeNull();

    cleanup();
    const viewCpp = renderPanel(whisperCppForm(), mock(() => {}));
    expect(viewCpp.queryByTestId("stt-local-server-panel")).not.toBeNull();

    cleanup();
    const view2 = renderPanel(whisperForm(), mock(() => {}));
    expect(view2.queryByTestId("stt-local-server-panel")).toBeNull();
  });

  test("scan with injected discovery deps → server rows appear", async () => {
    const outcomes: ProbeOutcome[] = [
      { port: 8000, status: "found", server: foundServer(8000, ["Systran/faster-whisper-base"]) },
      { port: 7851, status: "refused" },
    ];
    __setSttDiscoveryDepsForTests({ discover: mock(async () => outcomes) });

    const view = renderPanel(openaiForm(), mock(() => {}));
    await act(async () => {
      await userEvent.click(view.getByTestId("stt-local-scan"));
    });

    expect(view.queryByTestId("stt-discover-result-8000")).not.toBeNull();
    expect(view.queryByTestId("stt-discover-result-7851")).toBeNull();
    // model preview line shows the whisper model id
    expect(view.getByTestId("stt-discover-result-8000").textContent).toContain("Systran/faster-whisper-base");
  });

  test("adopting a server fills endpoint (+/v1) and a whisper model", async () => {
    const outcomes: ProbeOutcome[] = [
      { port: 8000, status: "found", server: foundServer(8000, ["Systran/faster-whisper-base"]) },
    ];
    __setSttDiscoveryDepsForTests({ discover: mock(async () => outcomes) });

    const setForm = mock((_p: Partial<SttProfileForm>) => {});
    const view = renderPanel(openaiForm(), setForm);
    await act(async () => {
      await userEvent.click(view.getByTestId("stt-local-scan"));
    });

    await act(async () => {
      await userEvent.click(view.getByTestId("stt-discover-adopt-8000"));
    });

    // Atomic merged write: one setForm({config}) carrying endpoint AND model.
    expect(setForm.mock.calls.length).toBe(1);
    const patch = setForm.mock.calls[0]?.[0] as { config: Record<string, unknown> };
    expect(patch.config.endpoint).toBe("http://127.0.0.1:8000/v1");
    expect(patch.config.model).toBe("Systran/faster-whisper-base");
  });

  test("the stale whisper.cpp exclusion note is gone (SPE-10)", () => {
    const view = renderPanel(openaiForm(), mock(() => {}));
    expect(view.queryByTestId("stt-local-whisper-cpp-note")).toBeNull();
  });

  test("setup help renders all six server guide cards (SPE-10)", async () => {
    const view = renderPanel(openaiForm(), mock(() => {}));
    await act(async () => {
      await userEvent.click(view.getByTestId("stt-setup-help-toggle"));
    });
    expect(view.getByText("Speaches")).not.toBeNull();
    expect(view.getByText("whisper.cpp")).not.toBeNull();
    expect(view.getByText("Whisperfile")).not.toBeNull();
    expect(view.getByText("LocalAI")).not.toBeNull();
    expect(view.getByText("vLLM")).not.toBeNull();
    expect(view.getByText("NVIDIA Riva NIM")).not.toBeNull();
  });

  test("wire mismatch: whisper.cpp guide in the compat row shows a pointer, not the adopt button", async () => {
    const view = renderPanel(openaiForm(), mock(() => {}));
    await act(async () => {
      await userEvent.click(view.getByTestId("stt-setup-help-toggle"));
    });
    // default guide = speaches (openai wire, matches the row) → adopt present
    expect(view.queryByTestId("stt-help-use-speaches")).not.toBeNull();

    await act(async () => {
      await userEvent.click(view.getByTestId("stt-help-choice-whisper-cpp"));
    });
    expect(view.queryByTestId("stt-help-use-whisper-cpp")).toBeNull();
    expect(view.queryByTestId("stt-help-wire-mismatch")).not.toBeNull();
    expect(view.getByTestId("stt-help-wire-mismatch").textContent).toBe("stt_local_wire_needs_whisper_cpp");
  });

  test("whisper.cpp row: adopt works for whisper-wire guides, compat guides get the mirror pointer", async () => {
    const view = renderPanel(whisperCppForm(), mock(() => {}));
    await act(async () => {
      await userEvent.click(view.getByTestId("stt-setup-help-toggle"));
    });
    // scan is compat-only — no probe in the whisper.cpp row
    expect(view.queryByTestId("stt-local-scan")).toBeNull();

    await act(async () => {
      await userEvent.click(view.getByTestId("stt-help-choice-whisper-cpp"));
    });
    expect(view.queryByTestId("stt-help-use-whisper-cpp")).not.toBeNull();

    await act(async () => {
      await userEvent.click(view.getByTestId("stt-help-choice-speaches"));
    });
    expect(view.queryByTestId("stt-help-use-speaches")).toBeNull();
    expect(view.getByTestId("stt-help-wire-mismatch").textContent).toBe("stt_local_wire_needs_compat");
  });
});
