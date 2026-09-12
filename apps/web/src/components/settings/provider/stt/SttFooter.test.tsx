import { describe, expect, it, mock, beforeAll, beforeEach, afterEach } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

import { STT_BACKENDS } from "@vibe-tavern/domain";
import type { SttProfileRecord } from "../../../../api/stt-api.js";
import type { useSttProfiles } from "./use-stt-profiles.js";

// ── Mobile mock (mutable-flag convention, MasterDetailModal.test.tsx) ────
// Registered BEFORE the footer module loads (dynamic import in beforeAll).
// Default false = the original tests keep exercising the DESKTOP branch.
const realUseMobile = await import("../../../../hooks/use-mobile.js");
let isMobile = false;
mock.module("../../../../hooks/use-mobile.js", () => ({
  ...realUseMobile,
  useIsMobile: () => isMobile,
}));

const { act, cleanup, fireEvent, render } = await import("@testing-library/react");

let SttFooter: typeof import("./SttFooter.js").SttFooter;
beforeAll(async () => {
  ({ SttFooter } = await import("./SttFooter.js"));
});

type SttHook = ReturnType<typeof useSttProfiles>;

function makeStt(overrides: Partial<SttHook> = {}): SttHook {
  const form = {
    id: "stt1",
    name: "Dictation",
    backend: STT_BACKENDS.OpenAiCompat,
    config: { endpoint: "https://api.openai.com/v1", model: "whisper-1" },
    hasStoredApiKey: false,
      emotionAnnotation: false,
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
    draftAutoKeyProviderName: null,
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

/** MUI W7 (owner-approved design variant A, dispatch MUI_W7_PROVIDER_FOOTER_TASK):
 *  structural mirror of the TtsAudioFooter W7 pins — mobile = two definite
 *  footer rows (Delete icon + Cancel + icon-mode Save on row 1; the
 *  dictation block on a full-width `mobileBottomRow` below), desktop keeps
 *  the pre-W7 DOM (settings inline in the right slot, text SaveButton, no
 *  second row). The dictation block mounts for REAL here (store defaults
 *  render fine in happy-dom — the original suite already mounts it). */
describe("SttFooter — MUI W7 two-row mobile layout", () => {
  it("mobile: settings on a full-width row below; delete + cancel + icon-save on row 1", () => {
    isMobile = true;
    const view = render(React.createElement(SttFooter, { stt: makeStt() }));
    const bar = view.container.firstElementChild as HTMLElement;
    const rightGroup = bar.querySelector(":scope > div.ml-auto") as HTMLElement;
    const bottomRow = bar.querySelector(":scope > div.w-full") as HTMLElement;

    // Row 2 exists and carries the settings block — exactly one mounted copy.
    expect(bottomRow).toBeTruthy();
    expect(bottomRow.querySelectorAll('[data-testid="stt-dictation-block"]')).toHaveLength(1);
    // The settings block is NOT inside the atomic right line.
    expect(rightGroup.querySelector('[data-testid="stt-dictation-block"]')).toBeNull();

    // Row 1: delete icon first, then the right-aligned group with Cancel+Save.
    const kids = Array.from(bar.children);
    const deleteBtn = bar.querySelector(":scope > button.h-9.w-9") as HTMLElement;
    expect(kids[0]).toBe(deleteBtn);
    expect(kids[0]?.getAttribute("aria-label")).toBe("delete");
    expect(kids[1]).toBe(rightGroup);
    expect(kids[2]).toBe(bottomRow);
    expect(rightGroup.querySelector('[data-testid="stt-cancel-btn"]')).toBeTruthy();

    // SaveButton in icon mode: 36px square, no text layers, state via aria.
    const save = rightGroup.querySelector("button.h-9.w-9") as HTMLElement;
    expect(save).toBeTruthy();
    expect(save.getAttribute("aria-label")).toBe("save_btn");
    expect(save.textContent).toBe("");
    expect(save.className).not.toContain("min-w-[124px]");
  });

  it("desktop: settings inline in the right slot, text SaveButton, no second row", () => {
    isMobile = false;
    const view = render(React.createElement(SttFooter, { stt: makeStt() }));
    const bar = view.container.firstElementChild as HTMLElement;
    const rightGroup = bar.querySelector(":scope > div.ml-auto") as HTMLElement;

    // No mobile bottom row at all.
    expect(bar.querySelector(":scope > div.w-full")).toBeNull();
    // The settings block sits INLINE, before Cancel.
    expect(rightGroup.querySelector('[data-testid="stt-dictation-block"]')).toBeTruthy();
    expect(rightGroup.textContent?.indexOf("cancel_btn")).toBeGreaterThan(-1);
    // SaveButton in text mode.
    const save = Array.from(rightGroup.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("save_btn"),
    ) as HTMLElement;
    expect(save).toBeTruthy();
    expect(save.className).toContain("min-w-[124px]");
  });
});
