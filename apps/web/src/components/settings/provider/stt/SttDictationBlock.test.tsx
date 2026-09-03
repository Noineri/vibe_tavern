/**
 * SttDictationBlock DOM tests (P6): the footer-inline dictation controls —
 * the enable switch drives the local store, picking a profile writes the
 * server pointer via patchUiSettingsAction (mocked — no network), and the
 * mode dropdown persists the choice. Same boundaries the deleted
 * SttDictationPanel.test pinned; the mode control moved from a segmented
 * control to a DropdownSelect (cmdk pick pattern from
 * TtsNarrationModeBlock.test.tsx).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import React from "react";
import { render, act } from "@testing-library/react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

// user-event binds `document` at setup() — import AFTER the DOM env exists
// (house pattern; the static import binds before GlobalRegistrator runs).
const { default: userEvent } = await import("@testing-library/user-event");
const { waitFor } = await import("@testing-library/react");

// SAFE mock.module (gotcha pattern): keep the real store module, override
// only the patch action the block calls.
const realBootstrap = await import("../../../../stores/api-actions/bootstrap-actions.js");
const patch = mock(async () => {
  throw new Error("not configured");
});
mock.module("../../../../stores/api-actions/bootstrap-actions.js", () => ({
  ...realBootstrap,
  patchUiSettingsAction: patch,
}));

import { useDictationStore } from "../../../../stores/dictation-store.js";

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

const { TooltipProvider } = await import("../../../shared/Tooltip.js");
const { SttDictationBlock } = await import("./SttDictationBlock.js");

const PROFILES = [
  {
    id: "stt-1",
    name: "Whisper in browser",
    backend: "whisper-browser",
    config: {},
    hasStoredApiKey: false,
    autoKeyProviderName: null,
    emotionAnnotation: false,
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "stt-2",
    name: "OpenAI",
    backend: "openai-compat",
    config: {},
    hasStoredApiKey: true,
    autoKeyProviderName: null,
    emotionAnnotation: false,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

beforeEach(() => {
  useDictationStore.setState({ enabled: false, mode: "append" });
  patch.mockReset();
});

function mount(profiles: typeof PROFILES = PROFILES) {
  return render(
    <TooltipProvider>
      <SttDictationBlock profiles={profiles} />
    </TooltipProvider>,
  );
}

/** Open the mode dropdown and pick the item whose text contains
 * `optionText` — the cmdk-portal pattern from TtsNarrationModeBlock.test.tsx
 * (raw i18n keys render as the option texts). */
async function pickMode(view: { container: HTMLElement; baseElement: HTMLElement }, optionText: string): Promise<void> {
  const trigger = view.container.querySelector('[data-testid="dictation-mode-select"]');
  if (!(trigger instanceof HTMLButtonElement)) throw new Error("mode select trigger missing");
  await act(async () => {
    userEvent.click(trigger);
  });
  await waitFor(() => expect(view.baseElement.querySelector("[cmdk-list]")).toBeTruthy());
  const items = [...view.baseElement.querySelectorAll("[cmdk-item]")];
  if (items.length !== 3) throw new Error(`expected 3 mode items, got ${items.length}`);
  const item = items.find((i) => (i.textContent ?? "").includes(optionText));
  if (!item) throw new Error(`no cmdk item containing "${optionText}"`);
  await act(async () => {
    userEvent.click(item);
  });
  await waitFor(() => expect(view.baseElement.querySelector("[cmdk-list]")).toBeNull());
}

describe("SttDictationBlock (P6, footer-inline)", () => {
  test("enable switch flips the dictation store (mic gate opens)", async () => {
    const view = mount();
    expect(useDictationStore.getState().enabled).toBe(false);
    const user = userEvent.setup();
    await user.click(view.getByRole("switch"));
    expect(useDictationStore.getState().enabled).toBe(true);
  });

  test("mode dropdown persists the choice", async () => {
    const view = mount();
    useDictationStore.setState({ enabled: true });
    await pickMode(view, "dictation_mode_auto_send");
    expect(useDictationStore.getState().mode).toBe("auto-send");
  });

  test("profile dropdown selection writes the server pointer", async () => {
    const view = mount();
    const user = userEvent.setup();
    // The dropdown is gated on enabled — flip the dictation switch first
    // (a disabled trigger has a real `disabled` attribute now; the old test
    // clicked through the grayed control via the no-Tailwind hole).
    await user.click(view.getByRole("switch"));
    await user.click(view.getByTestId("dictation-profile-select"));
    await user.click(await view.findByText("OpenAI"));
    await act(async () => {});
    expect(patch).toHaveBeenCalledWith({ activeDictationProfileId: "stt-2" });
  });

  test("the fallback row clears the pointer", async () => {
    const view = mount();
    const user = userEvent.setup();
    // Enable first — same gate as above.
    await user.click(view.getByRole("switch"));
    await user.click(view.getByTestId("dictation-profile-select"));
    // The trigger ALSO shows the fallback label — click the popup row (the
    // last match in DOM order), not the trigger.
    const rows = await view.findAllByText("dictation_profile_default_fallback");
    await user.click(rows[rows.length - 1]);
    await act(async () => {});
    expect(patch).toHaveBeenCalledWith({ activeDictationProfileId: null });
  });

  test("NO-PROFILES PIN (owner 2026-09-05): the whole setting goes gray — the switch is disabled and cannot be flipped on", async () => {
    const view = mount([]);
    const user = userEvent.setup();
    const sw = view.getByRole("switch") as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    // Graying: the toggle dims (shared-primitive disabled classes) and the
    // label follows at reduced opacity.
    expect(sw.className).toContain("opacity-40");
    expect(view.getByTestId("stt-dictation-block").textContent).toContain("dictation_panel_title");
    // Clicking the disabled switch does NOT open the mic gate.
    await user.click(sw);
    expect(useDictationStore.getState().enabled).toBe(false);
    // Both dropdowns are disabled as well (mode included — nothing to
    // dictate with zero profiles).
    for (const id of ["dictation-profile-select", "dictation-mode-select"]) {
      const trigger = view.getByTestId(id);
      expect(trigger.className).toContain("opacity-40");
      await user.click(trigger);
      await act(async () => {});
      expect(view.baseElement.querySelector("[cmdk-list]")).toBeNull();
    }
  });
});
