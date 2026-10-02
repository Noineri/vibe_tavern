import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const calls = {
  request: null as import("../../api/types.js").AiAssistantRequestBody | null,
  settings: null as Record<string, unknown> | null,
  pill: null as {
    onGenerate: () => void;
    onSettingsChange?: (settings: import("../shared/AiQuickPill.js").AiQuickSettings) => void;
  } | null,
};

const realAiApi = await import("../../api/ai-assistant-api.js");
const realSettingsApi = await import("../../api/settings-api.js");
const realI18n = await import("../../i18n/context.js");

mock.module("../../api/ai-assistant-api.js", () => ({
  ...realAiApi,
  streamAiAssistant: mock(async function* (request: import("../../api/types.js").AiAssistantRequestBody) {
    calls.request = request;
    yield { type: "text" as const, text: "Improved draft" };
    yield { type: "done" as const };
  }),
}));
mock.module("../../api/settings-api.js", () => ({
  ...realSettingsApi,
  updateUiSettings: mock(async (input: Record<string, unknown>) => {
    calls.settings = input;
    return input;
  }),
}));
mock.module("../../i18n/context.js", () => ({
  ...realI18n,
  useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));
mock.module("../shared/AiQuickPill.js", () => ({
  AiQuickPill: (props: NonNullable<typeof calls.pill>) => {
    calls.pill = props;
    return <button type="button" onClick={props.onGenerate}>generate</button>;
  },
}));

let ChatImpersonateAiPill: typeof import("./ChatImpersonateAiPill.js").ChatImpersonateAiPill;
let useBootstrapStore: typeof import("../../stores/api-actions/bootstrap-actions.js").useBootstrapStore;

beforeAll(async () => {
  ({ ChatImpersonateAiPill } = await import("./ChatImpersonateAiPill.js"));
  ({ useBootstrapStore } = await import("../../stores/api-actions/bootstrap-actions.js"));
});

beforeEach(() => {
  calls.request = null;
  calls.settings = null;
  calls.pill = null;
  useBootstrapStore.setState({
    data: {
      initialChatId: null,
      snapshot: null,
      isFirstRun: false,
      allCharacters: [],
      promptPresets: [],
      personas: [],
      uiSettings: {
        id: "default",
        theme: "dark",
        chatFontSize: 15,
        uiFontSize: 14,
        messageWidth: 700,
        language: "en",
        activePromptPresetId: null,
        aiAssistantProviderId: "provider_1",
        aiAssistantModelName: "model_1",
        chatImpersonateEnhanceDraft: false,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      isArmServer: false,
    } as never,
  });
});

describe("ChatImpersonateAiPill", () => {
  test("passes the current draft and streams the replacement into the composer", async () => {
    const setDraft = mock(() => {});
    const view = render(
      <ChatImpersonateAiPill
        activeChatId="chat_1"
        characterId="character_1"
        personaId="persona_1"
        draft="*I hesitate.*"
        setDraft={setDraft}
      />,
    );

    await waitFor(() => expect(calls.pill).not.toBeNull());
    await act(async () => {
      view.getByRole("button", { name: "generate" }).click();
    });

    await waitFor(() => expect(calls.request).not.toBeNull());
    expect(calls.request).toMatchObject({
      mode: "chat_impersonate",
      draftText: "*I hesitate.*",
      enhanceDraft: false,
    });
    await waitFor(() => expect(setDraft).toHaveBeenCalledWith("Improved draft"));
  });

  test("persists the draft-improvement toggle returned by the settings popover", async () => {
    render(
      <ChatImpersonateAiPill
        activeChatId="chat_1"
        characterId="character_1"
        personaId="persona_1"
        draft="draft"
        setDraft={() => {}}
      />,
    );

    await waitFor(() => expect(calls.pill).not.toBeNull());
    await act(async () => {
      calls.pill?.onSettingsChange?.({
        providerId: "provider_1",
        modelName: "model_1",
        recentMessageCount: 20,
        enhanceDraft: true,
      });
    });

    await waitFor(() => expect(calls.settings).toMatchObject({ chatImpersonateEnhanceDraft: true }));
  });
});
