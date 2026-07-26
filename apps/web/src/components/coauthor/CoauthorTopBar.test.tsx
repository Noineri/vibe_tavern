/**
 * CS-20 — CoauthorTopBar render test.
 *
 * Pins the bar's visible contract: avatar/name + memory badge + provider pill
 * render, and the RP prompt-preset switcher does NOT (the defining difference
 * from the shared TopBar — presets move to the InputArea pill in Wave 4).
 *
 * Mocking note: CoauthorTopBar reads its data from hooks/stores rather than
 * props, so the three data-reading hooks (useT / useChatMeta /
 * useProviderProfiles) are mocked at their module boundary. `use-mobile` is
 * deliberately NOT mocked — happy-dom's desktop viewport already makes
 * useIsMobile() return false, and mocking it collides with VibeMdView.test
 * process-globally (AGENTS.md `mock.module` gotcha). Each mock spreads the real
 * module first so other consumers in the process keep getting genuine exports.
 */
import { describe, it, expect, mock } from "bun:test";
import * as Popover from "@radix-ui/react-popover";
import { render } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const realI18n = await import("../../i18n/context.js");
const realChatSelectors = await import("../../stores/chat-selectors.js");
const realBinding = await import("../../hooks/use-coauthor-provider-binding.js");
const realTooltip = await import("../shared/Tooltip.js");
mock.module("../../i18n/context.js", () => {
  return {
    ...realI18n,
    useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
  };
});

mock.module("../../stores/chat-selectors.js", () => {
  return {
    ...realChatSelectors,
    useChatMeta: () => ({
      character: {
        id: "c1",
        name: "Kira Vex",
        avatarExt: null,
        avatarAssetId: null,
        avatarFullAssetId: null,
        updatedAt: "",
      },
    }),
  };
});

mock.module("../../hooks/use-coauthor-provider-binding.js", () => {
  return {
    ...realBinding,
    useCoauthorProviderBinding: () => ({
      profile: { id: "p1", name: "OpenAI Pro" },
      profileId: "p1",
      model: "gpt-4o",
      isExplicit: true,
      isReady: true,
      isDangling: false,
      toolCapableModels: [{ id: "gpt-4o", label: "GPT-4o", contextLength: 128000 }],
      favorites: [],
      saveBinding: mock(async () => {}),
      quickSwitchModel: mock(async () => {}),
    }),
  };
});

// CustomTooltip (Radix) needs a TooltipProvider ancestor; the app mounts one
// globally in app.tsx but the isolated render here does not. Passthrough keeps
// the bar's layout/children under test without the Radix context. Same pattern
// as VibeMdView.test / CoauthorCharacterForm.test. `use-mobile` is deliberately
// NOT mocked — happy-dom's desktop viewport already yields useIsMobile()=false,
// and mocking it collides with VibeMdView.test process-globally.
mock.module("../shared/Tooltip.js", () => {
  return {
    ...realTooltip,
    CustomTooltip: ({ children }: { children: React.ReactNode }) => children,
  };
});

const { useModalStore } = await import("../../stores/index.js");
const { CoauthorTopBar } = await import("./CoauthorTopBar.js");

describe("CoauthorTopBar", () => {

  it("renders the character name, memory badge, and provider pill", () => {
    const { getByText } = render(<Popover.Root><CoauthorTopBar /></Popover.Root>);
    // Character name (avatar slot).
    expect(getByText("Kira Vex")).toBeDefined();
    // Memory badge — i18n key returned verbatim by the useT mock.
    expect(getByText("topbar_memory")).toBeDefined();
    // Provider pill — name + model from the Co-Author binding.
    expect(getByText("OpenAI Pro")).toBeDefined();
    expect(getByText("GPT-4o")).toBeDefined();
  });

  it("does NOT render the prompt-preset switcher", () => {
    const { queryByText } = render(<Popover.Root><CoauthorTopBar /></Popover.Root>);
    // These keys are what the shared TopBar's preset dropdown renders; neither
    // may appear in the coauthor bar (presets move to the InputArea in Wave 4).
    expect(queryByText("topbar_prompt_preset")).toBeNull();
    expect(queryByText("topbar_default")).toBeNull();
  });

  it("opens the dedicated Co-Author provider modal when the pill is clicked", () => {
    const { getByText } = render(<Popover.Root><CoauthorTopBar /></Popover.Root>);
    // Both modals start closed.
    expect(useModalStore.getState().isCoauthorProviderModalOpen).toBe(false);
    expect(useModalStore.getState().isProviderModalOpen).toBe(false);
    // The pill is the clickable element wrapping the provider name.
    const pill = getByText("OpenAI Pro").closest("[class*='cursor-pointer']") as HTMLElement;
    expect(pill).not.toBeNull();
    pill.click();
    // CS-33: the pill opens the dedicated fork modal, not the shared RP
    // ProviderModal (which used to be opened via providerModalMode="coauthor").
    expect(useModalStore.getState().isCoauthorProviderModalOpen).toBe(true);
    expect(useModalStore.getState().isProviderModalOpen).toBe(false);
  });
});
