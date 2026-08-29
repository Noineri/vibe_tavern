import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

import { TTS_BACKEND } from "@vibe-tavern/domain";
import type { TtsProfileRecord } from "../../../../api/tts-api.js";
import { TtsAudioFooter } from "./TtsAudioFooter.js";
import type { useTtsProfiles } from "./use-tts-profiles.js";

const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");

type TtsHook = ReturnType<typeof useTtsProfiles>;

function makeTts(overrides: Partial<TtsHook> = {}): TtsHook {
  const form = {
    id: "tts1",
    name: "Kokoro voice",
    backend: TTS_BACKEND.Kokoro,
    config: {},
    voiceId: "af_heart",
    narratorVoiceId: "",
    hasStoredApiKey: false,
    providerRef: null,
    autoKeyProviderName: null,
    apiKey: "",
    lang: "en",
    sortOrder: 0,
    isDefault: false,
    createdAt: "",
    updatedAt: "",
  };
  return {
    profiles: [] as TtsProfileRecord[],
    loading: false,
    editingId: "tts1",
    form,
    dirty: true,
    error: null,
    saving: false,
    headerMode: "view",
    startEdit: () => {},
    setDefault: async () => {},
    select: () => {},
    startCreate: () => {},
    setForm: () => {},
    save: async () => {},
    remove: async () => {},
    cancelEdit: () => {},
    reload: async () => {},
    ...overrides,
  };
}

beforeEach(async () => {
  await act(async () => {});
});

afterEach(async () => {
  await act(async () => {});
  cleanup();
});

describe("TtsAudioFooter — audio-tab footer controls (moved out of the editor pane)", () => {
  it("dirty form: enabled Save + Cancel; Save click calls tts.save", async () => {
    const save = mock(async () => {});
    const view = render(React.createElement(TtsAudioFooter, { tts: makeTts({ save }) }));
    const saveBtn = view.getByRole("button", { name: /save_btn|saving|saved/ }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    expect(view.getByText("cancel_btn")).toBeTruthy();
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    expect(save).toHaveBeenCalled();
  });

  it("clean form: Save disabled, but Cancel STAYS (owner 2026-08-29 — a clean editor must have an exit)", async () => {
    const cancelEdit = mock(() => {});
    const view = render(React.createElement(TtsAudioFooter, { tts: makeTts({ dirty: false, cancelEdit }) }));
    const saveBtn = view.getByRole("button", { name: /save_btn|saving|saved/ }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    const cancel = view.getByTestId("tts-cancel-btn");
    fireEvent.click(cancel);
    expect(cancelEdit).toHaveBeenCalled();
  });

  it("Cancel click calls tts.cancelEdit and the form resets are the hook's business", async () => {
    const cancelEdit = mock(() => {});
    const view = render(React.createElement(TtsAudioFooter, { tts: makeTts({ cancelEdit }) }));
    await act(async () => {
      fireEvent.click(view.getByText("cancel_btn"));
    });
    expect(cancelEdit).toHaveBeenCalled();
  });

  it("trash action opens the confirm modal; confirming calls tts.remove", async () => {
    const remove = mock(async () => {});
    const view = render(React.createElement(TtsAudioFooter, { tts: makeTts({ remove }) }));
    await act(async () => {
      fireEvent.click(view.getByText("delete"));
    });
    await waitFor(() => expect(view.getByText("tts_profile_delete_confirm_title")).toBeTruthy());
    await act(async () => {
      fireEvent.click(view.getByText("delete_btn"));
    });
    await waitFor(() => expect(remove).toHaveBeenCalled());
  });

  it("unsaved profile (id null): no trash action", async () => {
    const tts = makeTts();
    tts.form = { ...tts.form, id: null } as TtsHook["form"];
    const view = render(React.createElement(TtsAudioFooter, { tts }));
    expect(view.queryByText("delete")).toBeNull();
  });
});
