import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as Popover from "@radix-ui/react-popover";
import { TopBar } from "./TopBar.js";

const mocks = vi.hoisted(() => ({
  setMode: vi.fn(),
  setTweaksOpen: vi.fn(),
}));

vi.mock("../../hooks/use-mobile.js", () => ({ useIsMobile: () => false }));
vi.mock("../../i18n/context.js", () => ({ useT: () => ({ t: (key: string) => key }) }));
vi.mock("../../hooks/use-provider-profiles.js", () => ({
  useProviderProfiles: () => ({ activeProviderProfile: null }),
}));
vi.mock("../../hooks/use-preset-controller.js", () => ({
  usePresetController: () => ({ handleSetActivePromptPresetId: vi.fn() }),
}));
vi.mock("../../stores/chat-selectors.js", () => ({
  useActiveTrace: () => null,
  useChatMeta: () => null,
}));
vi.mock("../../stores/api-actions/bootstrap-actions.js", () => ({
  useBootstrapStore: (selector: (state: { data: null }) => unknown) => selector({ data: null }),
}));
vi.mock("../../stores/index.js", () => {
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
    { getState: () => ({ setTweaksOpen: mocks.setTweaksOpen, setAvatarOpen: vi.fn() }) },
  );
  return { useNavigationStore, useProviderStore, useChatStore, useModalStore };
});
vi.mock("../shared/Tooltip.js", () => ({
  CustomTooltip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../settings/popovers/MemBadge.js", () => ({ MemBadge: () => null }));
vi.mock("../chat/MediaMenu.js", () => ({ MediaMenu: () => null }));
vi.mock("./UpdateBadge.js", () => ({ UpdateBadge: () => null }));

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
