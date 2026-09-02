/**
 * DictationButton DOM tests (STT_PLAN ST-4b): the opt-in gate (hidden unless
 * enabled AND a profile resolves), the three transcript modes, and ESC cancel
 * — with the transcriber + recorder faked through the button's test seams.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import React from "react";
import { render, act, waitFor } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

// user-event binds `document` at setup() — import AFTER the DOM env exists
// (the static import binds before GlobalRegistrator runs; house pattern from
// provider-modal.test.ts).
const { default: userEvent } = await import("@testing-library/user-event");

import { listAllSttProfiles, type SttProfileRecord } from "../../api/stt-api.js";
import { useDictationStore } from "../../stores/dictation-store.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import type { VoiceRecorder } from "../../lib/stt/voice-recorder.js";
import { DictationButton } from "./DictationButton.js";

// SAFE mock.module (gotcha pattern): capture the real module first, spread,
// override only listAllSttProfiles.
const realSttApi = await import("../../api/stt-api.js");
const listAll = mock(async () => [profile()]);
mock.module("../../api/stt-api.js", () => ({
  ...realSttApi,
  listAllSttProfiles: listAll,
}));

// House i18n test pattern (SttSection.test.tsx): raw keys render as-is.
const realI18n = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && typeof params === "object" && "mode" in params
        ? `${key}:${String(params.mode)}`
        : key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: () => {},
    ready: true,
  }),
}));

const { TooltipProvider } = await import("../shared/Tooltip.js");

function profile(overrides: Partial<SttProfileRecord> = {}): SttProfileRecord {
  return {
    id: "stt-1",
    name: "Whisper",
    backend: "whisper-browser",
    config: { model: "onnx-community/whisper-base" },
    hasStoredApiKey: false,
    autoKeyProviderName: null,
    emotionAnnotation: false,
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeRecorderFactory() {
  let active = false;
  return {
    async start() {
      active = true;
    },
    stop() {
      active = false;
      return Promise.resolve(new Blob(["x"], { type: "audio/webm" }));
    },
    cancel() {
      active = false;
    },
    isActive() {
      return active;
    },
  } satisfies VoiceRecorder;
}

function renderButton(
  props: Partial<Parameters<typeof DictationButton>[0]> = {},
): { setDraft: ReturnType<typeof mock>; send: ReturnType<typeof mock>; view: ReturnType<typeof render> } {
  const setDraft = mock((value: string) => {
    draftValue = value;
  });
  const send = mock(() => {});
  const view = render(
    <TooltipProvider>
      <DictationButton
        draft={draftValue}
        setDraft={(value: string) => setDraft(value)}
        send={() => send()}
        canSend={true}
        transcriber={async () => "привет мир"}
        recorderFactory={fakeRecorderFactory}
        {...props}
      />
    </TooltipProvider>,
  );
  return { setDraft, send, view };
}

function uiSettings(overrides: Record<string, unknown> = {}): ReturnType<typeof makeUiSettings> {
  const value = makeUiSettings();
  return Object.assign(value, overrides);
}

function makeUiSettings() {
  return {
    id: "ui",
    theme: "dark",
    chatFontSize: 17,
    uiFontSize: 17,
    messageWidth: 820,
    language: "en",
    activePromptPresetId: null,
    aiAssistantProviderId: null,
    aiAssistantModelName: null,
    coauthorProviderId: null,
    coauthorModelName: null,
    activeDictationProfileId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

let draftValue = "";

beforeEach(() => {
  draftValue = "";
  useDictationStore.setState({ enabled: false, mode: "append" });
  useBootstrapStore.setState({ data: null });
  listAll.mockImplementation(async () => [profile()]);
});

describe("DictationButton opt-in gate", () => {
  test("hidden by default (enable off)", () => {
    const { view } = renderButton();
    expect(view.queryByTestId("dictation-mic")).toBeNull();
  });

  test("hidden when enabled but no profile resolves", async () => {
    useDictationStore.setState({ enabled: true });
    listAll.mockImplementation(async () => []);
    const { view } = renderButton();
    await act(async () => {});
    expect(view.queryByTestId("dictation-mic")).toBeNull();
  });

  test("visible when enabled and the default profile resolves; pointer wins over default", async () => {
    useDictationStore.setState({ enabled: true });
    useBootstrapStore.setState({
      data: {
        initialChatId: null,
        snapshot: null,
        isFirstRun: false,
        allCharacters: [],
        promptPresets: [],
        uiSettings: uiSettings({ activeDictationProfileId: "stt-2" }),
        isArmServer: false,
      },
    });
    listAll.mockImplementation(async () => [profile(), profile({ id: "stt-2", name: "Server", isDefault: false })]);
    const { view } = renderButton();
    await waitFor(() => {
      expect(view.getByTestId("dictation-mic")).toBeTruthy();
    });
  });
});

describe("DictationButton transcript modes", () => {
  async function recordAndStop(view: ReturnType<typeof render> extends infer R ? R extends { getByTestId: Function } ? R : never : never): Promise<void> {
    const user = userEvent.setup();
    // The profile list loads in an effect — wait for the mic to appear first.
    await waitFor(() => {
      expect(view.getByTestId("dictation-mic")).toBeTruthy();
    });
    await act(async () => {
      await user.click(view.getByTestId("dictation-mic"));
    });
    await waitFor(() => {
      expect(view.getByTestId("dictation-mic").dataset.status).toBe("recording");
    });
    await act(async () => {
      await user.click(view.getByTestId("dictation-mic"));
    });
    // The transcriber promise chain resolves outside the click's act scope —
    // flush it inside act so the status transitions land wrapped.
    await act(async () => {
      await Bun.sleep(5);
    });
    await waitFor(() => {
      expect(view.getByTestId("dictation-mic").dataset.status).toBe("idle");
    });
  }

  test("append joins onto the draft", async () => {
    useDictationStore.setState({ enabled: true, mode: "append" });
    draftValue = "уже";
    const { setDraft, view } = renderButton();
    await recordAndStop(view);
    await waitFor(() => {
      expect(setDraft).toHaveBeenCalledWith("уже привет мир");
    });
  });

  test("replace swaps the draft", async () => {
    useDictationStore.setState({ enabled: true, mode: "replace" });
    draftValue = "старое";
    const { setDraft, view } = renderButton();
    await recordAndStop(view);
    await waitFor(() => {
      expect(setDraft).toHaveBeenCalledWith("привет мир");
    });
  });

  test("auto-send replaces then fires send", async () => {
    useDictationStore.setState({ enabled: true, mode: "auto-send" });
    draftValue = "старое";
    const { setDraft, send, view } = renderButton();
    await recordAndStop(view);
    await waitFor(() => {
      expect(setDraft).toHaveBeenCalledWith("привет мир");
    });
    await waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  test("auto-send with canSend=false does NOT fire send (text preserved, not lost)", async () => {
    useDictationStore.setState({ enabled: true, mode: "auto-send" });
    const { setDraft, send, view } = renderButton({ canSend: false });
    await recordAndStop(view);
    await waitFor(() => {
      expect(setDraft).toHaveBeenCalledWith("привет мир");
    });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("DictationButton cancel", () => {
  test("ESC during recording discards (no transcription, back to idle)", async () => {
    useDictationStore.setState({ enabled: true });
    const { setDraft, view } = renderButton();
    const user = userEvent.setup();
    await waitFor(() => {
      expect(view.getByTestId("dictation-mic")).toBeTruthy();
    });
    await user.click(view.getByTestId("dictation-mic"));
    await waitFor(() => {
      expect(view.getByTestId("dictation-mic").dataset.status).toBe("recording");
    });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(view.getByTestId("dictation-mic").dataset.status).toBe("idle");
    });
    expect(setDraft).not.toHaveBeenCalled();
  });
});
