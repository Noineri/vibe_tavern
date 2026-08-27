import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

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
    form: { id: "p1", name: "Alpha", backend: TTS_BACKEND.Kokoro as string } as never,
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
    const tts = makeTts({ form: { id: "p1", name: "Alpha", backend: TTS_BACKEND.Kokoro as never }, setForm, dirty: false });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    const input = view.getByTestId("tts-profile-name-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Alpha-2" } });
    expect(setForm).toHaveBeenCalled();
    const patch = (setForm.mock.calls[0] as unknown[])[0] as { name: string };
    expect(patch.name).toBe("Alpha-2");
  });

  it("Save is disabled when not dirty and enabled when dirty with a name", async () => {
    const ttsClean = makeTts({ dirty: false, form: { id: "p1", name: "Alpha", backend: TTS_BACKEND.Kokoro as never } });
    const view1 = render(React.createElement(TtsProfileEditor as never, { tts: ttsClean } as never));
    // SaveBar's save button is disabled when not dirty — find by aria-label tts key? The button label is t("save_btn") -> "save_btn" via mock.
    // The SaveButton renders with disabled prop when !dirty, so the button should be disabled.
    const saveBtn1 = view1.getByRole("button", { name: /save_btn|saving|saved/ });
    expect((saveBtn1 as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    const ttsDirty = makeTts({ dirty: true, form: { id: "p1", name: "Beta", backend: TTS_BACKEND.Gemini as never } });
    const view2 = render(React.createElement(TtsProfileEditor as never, { tts: ttsDirty } as never));
    const saveBtn2 = view2.getByRole("button", { name: /save_btn|saving|saved/ });
    expect((saveBtn2 as HTMLButtonElement).disabled).toBe(false);
  });

  it("clicking Save calls tts.save", async () => {
    const save = mock(async () => {});
    const tts = makeTts({ dirty: true, saving: false, save, form: { id: "p1", name: "Alpha", backend: TTS_BACKEND.Kokoro as never } });
    const view = render(React.createElement(TtsProfileEditor as never, { tts } as never));
    const btn = view.getByRole("button", { name: /save_btn|saving|saved/ });
    fireEvent.click(btn);
    expect(save).toHaveBeenCalled();
  });

  it("delete button disabled for unsaved form and opens confirm modal for saved form", async () => {
    // Unsaved
    const ttsUnsaved = makeTts({ form: { id: null, name: "", backend: TTS_BACKEND.Kokoro as never } });
    const view1 = render(React.createElement(TtsProfileEditor as never, { tts: ttsUnsaved } as never));
    const del1 = view1.getByTestId("tts-delete-btn") as HTMLButtonElement;
    expect(del1.disabled).toBe(true);
    cleanup();

    // Saved form
    const remove = mock(async () => {});
    const ttsSaved = makeTts({ form: { id: "p1", name: "Alpha", backend: TTS_BACKEND.Kokoro as never }, remove });
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
});
