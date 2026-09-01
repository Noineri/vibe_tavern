import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

import { STT_BACKENDS } from "@vibe-tavern/domain";
import type { SttProfileRecord } from "../../../../api/stt-api.js";
import { SttFooter } from "./SttFooter.js";
import type { useSttProfiles } from "./use-stt-profiles.js";

const { act, cleanup, fireEvent, render } = await import("@testing-library/react");

type SttHook = ReturnType<typeof useSttProfiles>;

function makeStt(overrides: Partial<SttHook> = {}): SttHook {
  const form = {
    id: "stt1",
    name: "Dictation",
    backend: STT_BACKENDS.OpenAiCompat,
    config: { endpoint: "https://api.openai.com/v1", model: "whisper-1" },
    hasStoredApiKey: false,
    autoKeyProviderName: null,
    apiKey: "",
  };
  return {
    profiles: [] as SttProfileRecord[],
    loading: false,
    editingId: "stt1",
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

describe("SttFooter — stt-tab footer controls (master-detail house pattern)", () => {
  it("dirty form: enabled Save + Cancel; Save click calls stt.save", async () => {
    const save = mock(async () => {});
    const view = render(React.createElement(SttFooter, { stt: makeStt({ save }) }));
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
    const view = render(
      React.createElement(SttFooter, { stt: makeStt({ dirty: false, cancelEdit }) }),
    );
    const saveBtn = view.getByRole("button", { name: /save_btn|saving|saved/ }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    expect(view.getByText("cancel_btn")).toBeTruthy();
    await act(async () => {
      fireEvent.click(view.getByText("cancel_btn"));
    });
    expect(cancelEdit).toHaveBeenCalled();
  });

  it("editing a saved profile shows the Delete action; delete opens the confirm modal and fires remove", async () => {
    const remove = mock(async () => {});
    const view = render(React.createElement(SttFooter, { stt: makeStt({ remove }) }));
    await act(async () => {
      fireEvent.click(view.getByText("delete"));
    });
    // Confirm modal key text rendered
    const confirm = view.getByText("stt_profile_delete_confirm_title");
    expect(confirm).toBeTruthy();
    await act(async () => {
      fireEvent.click(view.getByText("delete_btn"));
    });
    expect(remove).toHaveBeenCalled();
  });

  it("unsaved (new) form: no Delete action", () => {
    const stt = makeStt({ form: { ...makeStt().form!, id: null } });
    const view = render(React.createElement(SttFooter, { stt }));
    expect(view.queryByText("delete")).toBeNull();
  });
});