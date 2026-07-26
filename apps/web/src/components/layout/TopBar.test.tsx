import { beforeAll, describe, expect, it, mock } from "bun:test";
import * as Popover from "@radix-ui/react-popover";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;

const mocks = {
  setMode: mock(),
  setTweaksOpen: mock(),
};
const realMobileHook = await import("../../hooks/use-mobile.js");
const realI18nContext = await import("../../i18n/context.js");
const realProviderProfiles = await import("../../hooks/use-provider-profiles.js");
const realPresetController = await import("../../hooks/use-preset-controller.js");
const realChatSelectors = await import("../../stores/chat-selectors.js");
const realBootstrapActions = await import("../../stores/api-actions/bootstrap-actions.js");
const realStores = await import("../../stores/index.js");
const realTooltip = await import("../shared/Tooltip.js");
const realMemBadge = await import("../settings/popovers/MemBadge.js");
const realMediaMenu = await import("../chat/MediaMenu.js");
const realUpdateBadge = await import("./UpdateBadge.js");

mock.module("../../hooks/use-mobile.js", () => ({ ...realMobileHook, useIsMobile: () => false }));
mock.module("../../i18n/context.js", () => ({ ...realI18nContext, useT: () => ({ t: (key: string) => key }) }));
mock.module("../../hooks/use-provider-profiles.js", () => ({
  ...realProviderProfiles,
  useProviderProfiles: () => ({ activeProviderProfile: null }),
}));
mock.module("../../hooks/use-preset-controller.js", () => ({
  ...realPresetController,
  usePresetController: () => ({ handleSetActivePromptPresetId: mock() }),
}));
mock.module("../../stores/chat-selectors.js", () => ({
  ...realChatSelectors,
  useActiveTrace: () => null,
  useChatMeta: () => null,
}));
mock.module("../../stores/api-actions/bootstrap-actions.js", () => ({
  ...realBootstrapActions,
  useBootstrapStore: (selector: (state: { data: null }) => unknown) => selector({ data: null }),
}));
mock.module("../../stores/index.js", () => {
  const useNavigationStore = (selector: (state: object) => unknown) => selector({
    mode: "play",
    theme: "coffee",
    setMode: mocks.setMode,
  });
  const useProviderStore = (selector: (state: object) => unknown) => selector({
    connection: { status: "disconnected", model: null, models: [] },
  });
  const useChatStore = (selector: (state: object) => unknown) => selector({
    activeChatId: null,
    selectedTraceId: null,
  });
  const useModalStore = Object.assign(
    (selector: (state: object) => unknown) => selector({ tweaksOpen: false }),
    { getState: () => ({ setTweaksOpen: mocks.setTweaksOpen, setAvatarOpen: mock() }) },
  );
  return { ...realStores, useNavigationStore, useProviderStore, useChatStore, useModalStore };
});
mock.module("../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: React.ReactNode }) => children,
}));
mock.module("../settings/popovers/MemBadge.js", () => ({ ...realMemBadge, MemBadge: () => null }));
mock.module("../chat/MediaMenu.js", () => ({ ...realMediaMenu, MediaMenu: () => null }));
mock.module("./UpdateBadge.js", () => ({ ...realUpdateBadge, UpdateBadge: () => null }));

let TopBar: typeof import("./TopBar.js").TopBar;
beforeAll(async () => {
  ({ fireEvent, render } = await import("@testing-library/react"));
  ({ TopBar } = await import("./TopBar.js"));
});

describe("TopBar mode switch", () => {
  it("uses dedicated mode-switch colors and switches from play to build", () => {
    const view = render(<Popover.Root><TopBar /></Popover.Root>);
    const button = view.getByText("topbar_build_mode");

    expect(button.className).toContain("bg-mode-switch-bg");
    expect(button.className).toContain("text-mode-switch-text");
    expect(button.className).toContain("hover:bg-mode-switch-hover-bg");
    expect(button.className).toContain("hover:text-mode-switch-hover-text");

    fireEvent.click(button);
    expect(mocks.setMode).toHaveBeenCalledWith("build");
  });
});
