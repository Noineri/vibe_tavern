import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import * as Popover from "@radix-ui/react-popover";
import { CHAT_MODE } from "@vibe-tavern/domain";
import type { AgentKindSettingsWire } from "@vibe-tavern/api-contracts";
import { useDomEnv } from "../../../test/dom-env.js";
import { wireUiSettings } from "../../../test/wire-fixtures.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useSidechatMobileStore } from "../../stores/sidechat-mobile-store.js";
import { useSidechatOpenStore } from "../../stores/sidechat-open-store.js";
import { SIDECHAT_AGENT_KIND } from "../../api/agent-kind-served-modes.js";
import type { BootstrapData } from "../../stores/api-actions/bootstrap-actions.js";

useDomEnv();

let fireEvent: typeof import("@testing-library/react").fireEvent;
let render: typeof import("@testing-library/react").render;

// Mutable viewport/mode/bootstrap overrides (the mobile entry tests seed them).
let mobileOverride = false;
let modeOverride = "play";
let bootstrapDataOverride: BootstrapData | null = null;

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

mock.module("../../hooks/use-mobile.js", () => ({ ...realMobileHook, useIsMobile: () => mobileOverride }));
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
  // Stateful override so tests can seed `agentKindSettings` (the component
  // only reads `s.data` — a plain object is enough, no real store touched).
  useBootstrapStore: (selector: (state: { data: BootstrapData | null }) => unknown) =>
    selector({ data: bootstrapDataOverride }),
}));
mock.module("../../stores/index.js", () => {
  const useNavigationStore = (selector: (state: object) => unknown) => selector({
    mode: modeOverride,
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

// ── Fixtures (the PlayMode.sidechat.test.tsx recipe) ─────────────────────────

type ActiveChat = NonNullable<ReturnType<typeof useSnapshotStore.getState>["activeChat"]>;
type ActiveBranch = NonNullable<ReturnType<typeof useSnapshotStore.getState>["activeBranch"]>;

const CHAT_A = { id: "chat-a", mode: "rp" } as unknown as ActiveChat;
const BRANCH_A = { id: "branch-a", chatId: "chat-a", label: "main" } as unknown as ActiveBranch;
const CHAT_CO = { id: "chat-co", mode: "coauthor" } as unknown as ActiveChat;
const BRANCH_CO = { id: "branch-co", chatId: "chat-co", label: "main" } as unknown as ActiveBranch;

function kindEntry(kind: string, servesChatModes: string[]): AgentKindSettingsWire {
  return {
    agentKind: kind,
    providerProfileId: null,
    modelName: null,
    defaultProfileId: null,
    updatedAt: "",
    servesChatModes: servesChatModes as AgentKindSettingsWire["servesChatModes"],
    autoCompactDefault: true,
  };
}

function seedKindSettings(map: Record<string, AgentKindSettingsWire>): void {
  const data: BootstrapData = {
    initialChatId: null,
    snapshot: null,
    isFirstRun: false,
    allCharacters: [],
    promptPresets: [],
    uiSettings: wireUiSettings(),
    agentKindSettings: map,
    isArmServer: false,
  };
  bootstrapDataOverride = data;
}

function resetSharedState(): void {
  mobileOverride = false;
  modeOverride = "play";
  bootstrapDataOverride = null;
  localStorage.clear();
  useSidechatOpenStore.setState({ openByChat: {} });
  useSidechatMobileStore.setState({ tab: "chat" });
  useSnapshotStore.setState({ activeChat: null, activeBranch: null });
}

beforeEach(resetSharedState);
// The snapshot/bootstrap/sidechat stores are process-global — restore the
// defaults after the last test so no sibling file inherits this file's seed.
afterAll(resetSharedState);

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

describe("TopBar mobile sidechat entry (SC-16f)", () => {
  beforeEach(() => {
    mobileOverride = true;
    seedKindSettings({ [SIDECHAT_AGENT_KIND]: kindEntry(SIDECHAT_AGENT_KIND, [CHAT_MODE.rp]) });
    useSnapshotStore.setState({ activeChat: CHAT_A, activeBranch: BRANCH_A });
  });

  it("tapping the button opens the sidechat + the Sidechat tab; tapping again closes without touching the tab", () => {
    const { getByTestId } = render(<TopBar />);
    const button = getByTestId("topbar-sidechat-toggle");
    expect(button.getAttribute("aria-label")).toBe("sidechat_toggle_label");
    expect(button.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(button);
    expect(localStorage.getItem("vt.sidechat.open.chat-a")).toBe("true");
    expect(useSidechatMobileStore.getState().tab).toBe("sidechat");
    expect(button.getAttribute("aria-pressed")).toBe("true");

    // Closing touches only the open flag — the tab stays where it was.
    fireEvent.click(button);
    expect(localStorage.getItem("vt.sidechat.open.chat-a")).toBe("false");
    expect(useSidechatMobileStore.getState().tab).toBe("sidechat");
  });

  it("highlights the button in accent while the sidechat is open", () => {
    const { getByTestId } = render(<TopBar />);
    const button = getByTestId("topbar-sidechat-toggle");
    expect(button.className).toContain("text-t3");
    expect(button.className).not.toContain("bg-accent-dim");

    fireEvent.click(button);
    expect(button.className).toContain("bg-accent-dim");
    expect(button.className).toContain("text-accent");
    expect(button.className).not.toContain("text-t3");
  });

  it("a co-author chat has no button", () => {
    useSnapshotStore.setState({ activeChat: CHAT_CO, activeBranch: BRANCH_CO });
    const { queryByTestId } = render(<TopBar />);
    expect(queryByTestId("topbar-sidechat-toggle")).toBeNull();
  });

  it("an unserved bootstrap map has no button", () => {
    seedKindSettings({});
    const { queryByTestId } = render(<TopBar />);
    expect(queryByTestId("topbar-sidechat-toggle")).toBeNull();
  });

  it("build mode has no button", () => {
    modeOverride = "build";
    const { queryByTestId } = render(<TopBar />);
    expect(queryByTestId("topbar-sidechat-toggle")).toBeNull();
  });

  it("the 375px row never shrinks a button and the name ellipsizes", () => {
    const { container, getByTestId, getByText } = render(<TopBar railHidden />);
    const nameWrap = container.querySelector(".min-w-0.flex-1");
    expect(nameWrap).not.toBeNull();
    expect(nameWrap?.querySelector(".text-ellipsis.whitespace-nowrap")).not.toBeNull();
    const button = getByTestId("topbar-sidechat-toggle");
    expect(button.className).toContain("shrink-0");
    expect(button.className).toContain("h-8");
    expect(button.className).toContain("w-8");
    expect(getByText("topbar_build_mode").className).toContain("shrink-0");
  });
});
