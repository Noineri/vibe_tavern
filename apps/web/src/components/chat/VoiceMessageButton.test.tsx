/**
 * VoiceMessageButton DOM tests (STT_PLAN ST-6): the profile gate (hidden until
 * an STT profile resolves — pointer or default), record → stop → upload
 * landing (blob + durationMs forwarded, idempotent UI states), and ESC cancel
 * discarding the clip. Recorder faked through the button's test seam;
 * stt-api + i18n mocked with the SAFE module pattern (spread real first).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import React from "react";
import { render, act, waitFor } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const { default: userEvent } = await import("@testing-library/user-event");

import { listAllSttProfiles, type SttProfileRecord } from "../../api/stt-api.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import type { VoiceRecorder } from "../../lib/stt/voice-recorder.js";
import { VoiceMessageButton } from "./VoiceMessageButton.js";

// SAFE mock.module (gotcha pattern): capture the real module first, spread,
// override only listAllSttProfiles.
const realSttApi = await import("../../api/stt-api.js");
const listAll = mock(async () => [profile()]);
mock.module("../../api/stt-api.js", () => ({
  ...realSttApi,
  listAllSttProfiles: listAll,
}));

// House i18n test pattern: raw keys render as-is.
const realI18n = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({
    t: (key: string) => key,
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

function fakeRecorderFactory(blob: Blob = new Blob(["clip"], { type: "audio/webm" })) {
  let active = false;
  const recorder: VoiceRecorder = {
    async start() {
      active = true;
    },
    stop() {
      active = false;
      return Promise.resolve(blob);
    },
    cancel() {
      active = false;
    },
    isActive() {
      return active;
    },
  };
  return () => recorder;
}

function failingRecorderFactory() {
  return {
    async start() {
      throw new Error("mic boom");
    },
    stop() {
      return Promise.resolve(new Blob([], { type: "audio/webm" }));
    },
    cancel() {},
    isActive() {
      return false;
    },
  } satisfies VoiceRecorder;
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
    activeVoiceMessageProfileId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function uiSettings(overrides: Record<string, unknown> = {}): ReturnType<typeof makeUiSettings> {
  return Object.assign(makeUiSettings(), overrides);
}

const onRecorded = mock(async (_blob: Blob, _durationMs: number) => true);

function renderButton(
  props: Partial<Parameters<typeof VoiceMessageButton>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <VoiceMessageButton onRecorded={(blob, durationMs) => onRecorded(blob, durationMs)} {...props} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  useBootstrapStore.setState({ data: null });
  listAll.mockImplementation(async () => [profile()]);
  onRecorded.mockReset();
  onRecorded.mockImplementation(async () => true);
});

describe("VoiceMessageButton profile gate", () => {
  test("hidden while the profile list is loading / empty", async () => {
    listAll.mockImplementation(async () => []);
    const view = renderButton();
    await act(async () => {});
    expect(view.queryByTestId("voice-message-record")).toBeNull();
  });

  test("visible when the default profile resolves", async () => {
    const view = renderButton();
    await waitFor(() => {
      expect(view.getByTestId("voice-message-record")).toBeTruthy();
    });
  });

  test("dangling pointer falls back to the default profile (dictation semantics) → visible", async () => {
    useBootstrapStore.setState({
      data: {
        initialChatId: null,
        snapshot: null,
        isFirstRun: false,
        allCharacters: [],
        promptPresets: [],
        uiSettings: uiSettings({ activeVoiceMessageProfileId: "stt-9" }),
        isArmServer: false,
      },
    });
    // The pointed id is absent but a default exists → visible (fallback).
    listAll.mockImplementation(async () => [profile()]);
    const view = renderButton();
    await waitFor(() => {
      expect(view.getByTestId("voice-message-record")).toBeTruthy();
    });
  });

  test("no pointer match and no default profile → hidden", async () => {
    useBootstrapStore.setState({
      data: {
        initialChatId: null,
        snapshot: null,
        isFirstRun: false,
        allCharacters: [],
        promptPresets: [],
        uiSettings: uiSettings({ activeVoiceMessageProfileId: "stt-9" }),
        isArmServer: false,
      },
    });
    listAll.mockImplementation(async () => [profile({ isDefault: false })]);
    const view = renderButton();
    await act(async () => {});
    await act(async () => {});
    expect(view.queryByTestId("voice-message-record")).toBeNull();
  });
});

describe("VoiceMessageButton record flow", () => {
  test("click → recording; click → stop uploads the blob with durationMs", async () => {
    const user = userEvent.setup();
    const blob = new Blob(["clip-bytes"], { type: "audio/webm" });
    const landed: Array<{ blob: Blob; durationMs: number }> = [];
    const view = render(
      <TooltipProvider>
        <VoiceMessageButton
          onRecorded={async (b, d) => {
            landed.push({ blob: b, durationMs: d });
            return true;
          }}
          recorderFactory={fakeRecorderFactory(blob)}
        />
      </TooltipProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("voice-message-record")).toBeTruthy();
    });
    await act(async () => {
      await user.click(view.getByTestId("voice-message-record"));
    });
    await waitFor(() => {
      expect(view.getByTestId("voice-message-record").dataset.status).toBe("recording");
    });

    await act(async () => {
      await user.click(view.getByTestId("voice-message-record"));
    });
    await waitFor(() => {
      expect(view.getByTestId("voice-message-record").dataset.status).toBe("idle");
    });
    expect(landed).toHaveLength(1);
    expect(landed[0]!.blob).toBe(blob);
    expect(typeof landed[0]!.durationMs).toBe("number");
  });

  test("ESC cancels the recording without uploading", async () => {
    const user = userEvent.setup();
    const landed: Array<{ blob: Blob; durationMs: number }> = [];
    const view = render(
      <TooltipProvider>
        <VoiceMessageButton
          onRecorded={async (b, d) => {
            landed.push({ blob: b, durationMs: d });
            return true;
          }}
          recorderFactory={fakeRecorderFactory()}
        />
      </TooltipProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("voice-message-record")).toBeTruthy();
    });
    await act(async () => {
      await user.click(view.getByTestId("voice-message-record"));
    });
    await waitFor(() => {
      expect(view.getByTestId("voice-message-record").dataset.status).toBe("recording");
    });

    await act(async () => {
      userEvent.keyboard("{Escape}");
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(view.getByTestId("voice-message-record").dataset.status).toBe("idle");
    });
    expect(landed).toHaveLength(0);
  });

  test("recorder start failure keeps the button idle (no stuck recording state)", async () => {
    const user = userEvent.setup();
    const landed: Array<{ blob: Blob; durationMs: number }> = [];
    const view = render(
      <TooltipProvider>
        <VoiceMessageButton
          onRecorded={async (b, d) => {
            landed.push({ blob: b, durationMs: d });
            return true;
          }}
          recorderFactory={failingRecorderFactory}
        />
      </TooltipProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("voice-message-record")).toBeTruthy();
    });
    await act(async () => {
      await user.click(view.getByTestId("voice-message-record"));
    });
    await act(async () => {});
    expect(view.getByTestId("voice-message-record").dataset.status).toBe("idle");
    expect(landed).toHaveLength(0);
  });
});
