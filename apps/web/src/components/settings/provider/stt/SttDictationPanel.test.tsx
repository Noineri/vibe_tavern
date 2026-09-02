/**
 * SttDictationPanel DOM tests (STT_PLAN ST-4b): the enable switch drives the
 * local store, and picking a profile writes the server pointer via
 * patchUiSettingsAction (mocked — no network).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import React from "react";
import { render, act } from "@testing-library/react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

// user-event binds `document` at setup() — import AFTER the DOM env exists
// (house pattern; the static import binds before GlobalRegistrator runs).
const { default: userEvent } = await import("@testing-library/user-event");

useDomEnv();

// SAFE mock.module (gotcha pattern): keep the real store module, override
// only the patch action the panel calls.
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
const { SttDictationPanel } = await import("./SttDictationPanel.js");

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

describe("SttDictationPanel", () => {
  test("enable checkbox flips the dictation store (mic gate opens)", async () => {
      const view = render(
      <TooltipProvider>
        <SttDictationPanel profiles={PROFILES} />
      </TooltipProvider>,
    );
    expect(useDictationStore.getState().enabled).toBe(false);
    const user = userEvent.setup();
    await user.click(view.getByTestId("dictation-enable"));
    expect(useDictationStore.getState().enabled).toBe(true);
  });

  test("mode segmented control persists the choice", async () => {
      const view = render(
      <TooltipProvider>
        <SttDictationPanel profiles={PROFILES} />
      </TooltipProvider>,
    );
    const user = userEvent.setup();
    useDictationStore.setState({ enabled: true });
    await user.click(view.getByText("dictation_mode_auto_send"));
    expect(useDictationStore.getState().mode).toBe("auto-send");
  });

  test("profile dropdown selection writes the server pointer", async () => {
      const view = render(
      <TooltipProvider>
        <SttDictationPanel profiles={PROFILES} />
      </TooltipProvider>,
    );
    const user = userEvent.setup();
    await user.click(view.getByTestId("dictation-profile-select"));
    await user.click(await view.findByText("OpenAI"));
    await act(async () => {});
    expect(patch).toHaveBeenCalledWith({ activeDictationProfileId: "stt-2" });
  });

  test("the fallback row clears the pointer", async () => {
      const view = render(
      <TooltipProvider>
        <SttDictationPanel profiles={PROFILES} />
      </TooltipProvider>,
    );
    const user = userEvent.setup();
    await user.click(view.getByTestId("dictation-profile-select"));
    // The trigger ALSO shows the fallback label — click the popup row (the
    // last match in DOM order), not the trigger.
    const rows = await view.findAllByText("dictation_profile_default_fallback");
    await user.click(rows[rows.length - 1]);
    await act(async () => {});
    expect(patch).toHaveBeenCalledWith({ activeDictationProfileId: null });
  });
});
