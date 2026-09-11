import { describe, expect, it, mock, beforeAll, beforeEach, afterEach } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

import { TTS_BACKEND } from "@vibe-tavern/domain";
import type { TtsProfileRecord } from "../../../../api/tts-api.js";
import type { useTtsProfiles } from "./use-tts-profiles.js";

// ── Mobile mock (mutable-flag convention, MasterDetailModal.test.tsx) ────
// Registered BEFORE the footer module loads (dynamic import in beforeAll).
// Default false = the original tests keep exercising the DESKTOP branch.
const realUseMobile = await import("../../../../hooks/use-mobile.js");
let isMobile = false;
mock.module("../../../../hooks/use-mobile.js", () => ({
  ...realUseMobile,
  useIsMobile: () => isMobile,
}));

const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");

let TtsAudioFooter: typeof import("./TtsAudioFooter.js").TtsAudioFooter;
beforeAll(async () => {
  ({ TtsAudioFooter } = await import("./TtsAudioFooter.js"));
});

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
draftAutoKeyProviderName: null,
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
  isMobile = false;
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

/** MUI W7 (owner-approved design variant A, dispatch MUI_W7_PROVIDER_FOOTER_TASK):
 *  mobile = two definite footer rows — row 1: Delete icon + Cancel +
 *  icon-mode Save (36px square, state text only via aria-label); row 2: the
 *  narration-mode block on a FULL-WIDTH row via MasterDetailFooter's
 *  `mobileBottomRow`, NOT inside the atomic `ml-auto` right line (step 18's
 *  wrap of that group overflowed the viewport). Desktop keeps the pre-W7 DOM:
 *  settings inline in the right slot, text SaveButton, no second row. */
describe("TtsAudioFooter — MUI W7 two-row mobile layout", () => {
  it("mobile: settings on a full-width row below; delete + cancel + icon-save on row 1", () => {
    isMobile = true;
    const view = render(React.createElement(TtsAudioFooter, { tts: makeTts() }));
    const bar = view.container.firstElementChild as HTMLElement;
    const rightGroup = bar.querySelector(":scope > div.ml-auto") as HTMLElement;
    const bottomRow = bar.querySelector(":scope > div.w-full") as HTMLElement;

    // Row 2 exists and carries the settings block — exactly one mounted copy.
    expect(bottomRow).toBeTruthy();
    expect(bottomRow.querySelectorAll('[data-testid="tts-narration-mode-block"]')).toHaveLength(1);
    // The settings block is NOT inside the atomic right line.
    expect(rightGroup.querySelector('[data-testid="tts-narration-mode-block"]')).toBeNull();

    // Row 1: delete icon first, then the right-aligned group with Cancel+Save.
    const kids = Array.from(bar.children);
    const deleteBtn = bar.querySelector(":scope > button.h-9.w-9") as HTMLElement;
    expect(kids[0]).toBe(deleteBtn);
    expect(kids[0]?.getAttribute("aria-label")).toBe("delete");
    expect(kids[1]).toBe(rightGroup);
    expect(kids[2]).toBe(bottomRow);
    expect(rightGroup.querySelector('[data-testid="tts-cancel-btn"]')).toBeTruthy();

    // SaveButton in icon mode: 36px square, no text layers, state via aria.
    const save = rightGroup.querySelector("button.h-9.w-9") as HTMLElement;
    expect(save).toBeTruthy();
    expect(save.getAttribute("aria-label")).toBe("save_btn");
    expect(save.textContent).toBe("");
    expect(save.className).not.toContain("min-w-[124px]");
  });

  it("desktop: settings inline in the right slot, text SaveButton, no second row", () => {
    isMobile = false;
    const view = render(React.createElement(TtsAudioFooter, { tts: makeTts() }));
    const bar = view.container.firstElementChild as HTMLElement;
    const rightGroup = bar.querySelector(":scope > div.ml-auto") as HTMLElement;

    // No mobile bottom row at all.
    expect(bar.querySelector(":scope > div.w-full")).toBeNull();
    // The settings block sits INLINE, before Cancel.
    const block = rightGroup.querySelector('[data-testid="tts-narration-mode-block"]');
    expect(block).toBeTruthy();
    expect(rightGroup.textContent?.indexOf("tts_narration_mode_label")).toBeLessThan(
      rightGroup.textContent?.indexOf("cancel_btn") ?? -1,
    );
    // SaveButton in text mode.
    const save = Array.from(rightGroup.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("save_btn"),
    ) as HTMLElement;
    expect(save).toBeTruthy();
    expect(save.className).toContain("min-w-[124px]");
  });
});
