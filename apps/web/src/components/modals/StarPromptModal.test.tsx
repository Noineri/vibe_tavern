/**
 * StarPromptModal — pins what each of the three controls writes.
 *
 * The modal is the only place the deferral backoff is applied to live state, so
 * a regression here silently changes how often every user gets nagged. Escape
 * is covered too: dismissing is a deferral, not consent to be asked again on
 * the next reply.
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";
import type { UiSettingsRecord } from "../../api/types.js";

useDomEnv();
const { fireEvent, render, screen } = await import("@testing-library/react");

const mockState = {
  /** Every patch passed to patchUiSettingsAction, in call order. */
  patches: [] as Array<Partial<UiSettingsRecord>>,
  /** Every URL passed to window.open, in call order. */
  opened: [] as string[],
};

const realBootstrap = await import("../../stores/api-actions/bootstrap-actions.js");
const realI18nContext = await import("../../i18n/context.js");
const realMobileHook = await import("../../hooks/use-mobile.js");

mock.module("../../stores/api-actions/bootstrap-actions.js", () => ({
  ...realBootstrap,
  patchUiSettingsAction: mock(async (patch: Partial<UiSettingsRecord>) => {
    mockState.patches.push(patch);
    return baseSettings(patch);
  }),
}));

mock.module("../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

mock.module("../../hooks/use-mobile.js", () => ({ ...realMobileHook, useIsMobile: () => false }));

let StarPromptModal: typeof import("./StarPromptModal.js").StarPromptModal;
let useModalStore: typeof import("../../stores/modal-store.js").useModalStore;
let useBootstrapStore: typeof import("../../stores/api-actions/bootstrap-actions.js").useBootstrapStore;

beforeAll(async () => {
  ({ StarPromptModal } = await import("./StarPromptModal.js"));
  ({ useModalStore } = await import("../../stores/modal-store.js"));
  ({ useBootstrapStore } = await import("../../stores/api-actions/bootstrap-actions.js"));
});

function baseSettings(over: Partial<UiSettingsRecord> = {}): UiSettingsRecord {
  return {
    id: "default",
    theme: "dark",
    chatFontSize: 15,
    uiFontSize: 14,
    messageWidth: 700,
    language: "en",
    activePromptPresetId: null,
    aiAssistantProviderId: null,
    aiAssistantModelName: null,
    coauthorProviderId: null,
    coauthorModelName: null,
    githubStarred: false,
    userMessageCount: 10,
    nextStarPromptAt: 10,
    starPromptDeferrals: 0,
    updatedAt: "2026-01-01",
    ...over,
  };
}

/** Seed the stores so the modal renders open, at the first due point. */
function openModal(settings: Partial<UiSettingsRecord> = {}) {
  useBootstrapStore.setState({
    data: {
      initialChatId: null,
      snapshot: null,
      isFirstRun: false,
      allCharacters: [],
      promptPresets: [],
      uiSettings: baseSettings(settings),
      isArmServer: false,
    },
  });
  useModalStore.setState({ isStarPromptOpen: true });
  render(<StarPromptModal />);
}

describe("StarPromptModal", () => {
  beforeEach(() => {
    mockState.patches.length = 0;
    mockState.opened.length = 0;
    window.open = ((url: string) => {
      mockState.opened.push(url);
      return null;
    }) as typeof window.open;
    useModalStore.setState({ isStarPromptOpen: false });
  });

  it("the star button opens the repo and records the ask as answered", () => {
    openModal();

    fireEvent.click(screen.getByText("star_prompt_cta"));

    expect(mockState.opened).toEqual(["https://github.com/Noineri/vibe_tavern"]);
    expect(mockState.patches).toEqual([{ githubStarred: true }]);
    expect(useModalStore.getState().isStarPromptOpen).toBe(false);
  });

  it("Later defers by the next interval without leaving the app", () => {
    openModal();

    fireEvent.click(screen.getByText("star_prompt_later"));

    expect(mockState.opened).toEqual([]);
    expect(mockState.patches).toEqual([{ starPromptDeferrals: 1, nextStarPromptAt: 110 }]);
  });

  it("a second Later waits longer than the first", () => {
    openModal({ userMessageCount: 110, nextStarPromptAt: 110, starPromptDeferrals: 1 });

    fireEvent.click(screen.getByText("star_prompt_later"));

    expect(mockState.patches).toEqual([{ starPromptDeferrals: 2, nextStarPromptAt: 410 }]);
  });

  it("the opt-out silences the prompt without opening the repo", () => {
    openModal();

    fireEvent.click(screen.getByText("star_prompt_never"));

    expect(mockState.opened).toEqual([]);
    expect(mockState.patches).toEqual([{ githubStarred: true }]);
  });

  it("Escape defers rather than silencing", () => {
    openModal();

    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });

    expect(mockState.patches).toEqual([{ starPromptDeferrals: 1, nextStarPromptAt: 110 }]);
  });
});
