/**
 * PlayMode mobile sidechat tabs (SIDECHAT_PLAN, Wave 4 / SC-15).
 *
 * Pins the unit's outcome on the mobile branch only:
 * - the right-edge handle opens the sidechat AND switches to «Sidechat»;
 * - the × on the «Sidechat» tab closes back to «Chat» (same persisted open
 *   key as the desktop panel);
 * - both panes stay mounted across tab switches — the chat pane keeps its
 *   DOM identity and state (scroll survival's structural half; happy-dom
 *   has no layout, so scroll offsets themselves are unassertable here);
 * - the served-modes gate (a co-author chat sees no tabs, no handle);
 * - the desktop branch renders exactly the pre-SC-15 surface (no tabs,
 *   no handle, no shell).
 *
 * Harness: the `dice-panel.test.tsx` recipe — heavy children (MessageList,
 * InputArea, AgentShell, …) are stubbed with `...real` spread so the file
 * stays on the PlayMode boundary (the real shell is pinned by SC-14's
 * `SidechatPanel.test.tsx`); the stores are REAL and re-seeded in
 * `beforeEach`. The `MessageList` stub carries a probe `<input>` so the
 * survival test pins an uncontrolled value + DOM identity, not just
 * presence. `useT` is stubbed to the key (no process-global i18n — R13).
 *
 * Runner: bun:test with scoped happy-dom.
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { CHAT_MODE } from "@vibe-tavern/domain";
import type { AgentKindSettingsWire } from "@vibe-tavern/api-contracts";
import { useDomEnv } from "../../../test/dom-env.js";
import { wireUiSettings } from "../../../test/wire-fixtures.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { useSidechatMobileStore } from "../../stores/sidechat-mobile-store.js";
import { useSidechatOpenStore } from "../../stores/sidechat-open-store.js";
import { SIDECHAT_AGENT_KIND } from "../../api/agent-kind-served-modes.js";

useDomEnv();

// ── Mutable viewport override (mock `use-mobile` reads this) ────────────────
let mobileOverride = true;

const realMobile = await import("../../hooks/use-mobile.js");
mock.module("../../hooks/use-mobile.js", () => ({
  ...realMobile,
  useIsMobile: () => mobileOverride,
}));

const realI18nContext = await import("../../i18n/context.js");
mock.module("../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({ t: (key: string) => key, locale: "en", setLocale: () => {}, ready: true }),
}));

// ── Heavy children become boundary stubs (the PlayMode surface is the unit) ──
const realMessageList = await import("../chat/MessageList.js");
mock.module("../chat/MessageList.js", () => ({
  ...realMessageList,
  MessageList: () => (
    <div data-testid="message-list">
      <input data-testid="chat-probe-input" defaultValue="" />
    </div>
  ),
}));
const realInputArea = await import("../chat/InputArea.js");
mock.module("../chat/InputArea.js", () => ({
  ...realInputArea,
  InputArea: () => <div data-testid="input-area" />,
}));
const realQueueManager = await import("../chat/QueueManager.js");
mock.module("../chat/QueueManager.js", () => ({
  ...realQueueManager,
  QueueManager: () => <div data-testid="queue-manager" />,
}));
const realMessageAiEditorModal = await import("../chat/MessageAiEditorModal.js");
mock.module("../chat/MessageAiEditorModal.js", () => ({
  ...realMessageAiEditorModal,
  MessageAiEditorModal: () => null,
}));
const realDicePanel = await import("../chat/DicePanel.js");
mock.module("../chat/DicePanel.js", () => ({
  ...realDicePanel,
  DicePanel: () => <div data-testid="dice-panel" />,
}));
const realNarrationPlaylist = await import("../chat/NarrationPlaylistPanel.js");
mock.module("../chat/NarrationPlaylistPanel.js", () => ({
  ...realNarrationPlaylist,
  NarrationPlaylistPanel: () => null,
}));
const realExperienceLauncher = await import("../experience/ExperienceLauncher.js");
mock.module("../experience/ExperienceLauncher.js", () => ({
  ...realExperienceLauncher,
  ExperienceLauncher: () => null,
}));
const realFineTuningChip = await import("../chat/ImageGenFineTuningChip.js");
mock.module("../chat/ImageGenFineTuningChip.js", () => ({
  ...realFineTuningChip,
  ImageGenFineTuningChip: () => null,
}));
const realProgressRow = await import("../chat/ImageGenProgressRow.js");
mock.module("../chat/ImageGenProgressRow.js", () => ({
  ...realProgressRow,
  ImageGenProgressRow: () => null,
}));
// The shell itself is stubbed: SC-14 pins the real shell; this file pins the
// mobile surface around it (tabs, panes, handle, open key).
const realAgentShell = await import("../shared/agent-shell/AgentShell.js");
mock.module("../shared/agent-shell/AgentShell.js", () => ({
  ...realAgentShell,
  AgentShell: () => <div data-testid="sidechat-shell-stub" />,
}));
// Auto-narration is outside this unit's boundary (and its voice-map fetch is
// network-quiet only when no chat is active) — stub the hook, keep the call.
const realAutoNarrate = await import("../../hooks/use-auto-narrate.js");
mock.module("../../hooks/use-auto-narrate.js", () => ({
  ...realAutoNarrate,
  useAutoNarrate: () => {},
}));
const realTooltip = await import("../shared/Tooltip.js");
mock.module("../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

let render: typeof import("@testing-library/react").render;
let act: typeof import("@testing-library/react").act;
let fireEvent: typeof import("@testing-library/react").fireEvent;
let PlayMode: typeof import("./PlayMode.js").PlayMode;

beforeAll(async () => {
  ({ render, act, fireEvent } = await import("@testing-library/react"));
  ({ PlayMode } = await import("./PlayMode.js"));
});

// ── Fixtures ────────────────────────────────────────────────────────────────

type ActiveChat = NonNullable<ReturnType<typeof useSnapshotStore.getState>["activeChat"]>;
type ActiveBranch = NonNullable<ReturnType<typeof useSnapshotStore.getState>["activeBranch"]>;

const CHAT_A = { id: "chat-a", mode: "rp" } as unknown as ActiveChat;
const BRANCH_A = { id: "branch-a", chatId: "chat-a", label: "main" } as unknown as ActiveBranch;

function kindEntry(kind: string, servesChatModes: string[]): AgentKindSettingsWire {
  return {
    agentKind: kind,
    providerProfileId: null,
    modelName: null,
    defaultProfileId: null,
    updatedAt: "",
    servesChatModes: servesChatModes as AgentKindSettingsWire["servesChatModes"],
  };
}

function seedStores(map: Record<string, AgentKindSettingsWire>): void {
  useBootstrapStore.setState({
    data: {
      initialChatId: null,
      snapshot: null,
      isFirstRun: false,
      allCharacters: [],
      promptPresets: [],
      uiSettings: wireUiSettings(),
      agentKindSettings: map,
      isArmServer: false,
    },
  });
}

function seedChat(chat: ActiveChat, branch: ActiveBranch): void {
  useSnapshotStore.setState({ activeChat: chat, activeBranch: branch });
}

beforeEach(() => {
  mobileOverride = true;
  localStorage.clear();
  // The open flag is shared process state now (SC-18a) — reset it alongside
  // localStorage so no test reads the previous test's in-memory entry.
  useSidechatOpenStore.setState({ openByChat: {} });
  useSidechatMobileStore.setState({ tab: "chat" });
  seedStores({ [SIDECHAT_AGENT_KIND]: kindEntry(SIDECHAT_AGENT_KIND, [CHAT_MODE.rp]) });
  seedChat(CHAT_A, BRANCH_A);
});

// ── Handle → tabs → switch ──────────────────────────────────────────────────

describe("PlayMode mobile sidechat — handle opens + switches (SC-15)", () => {
  it("closed: the touch handle shows, no tabs, chat pane visible", () => {
    const { getByTestId, queryByRole, queryByTestId } = render(<PlayMode />);
    const handle = getByTestId("sidechat-toggle");
    expect(handle.getAttribute("aria-label")).toBe("sidechat_toggle_label");
    expect(handle.getAttribute("class")).toContain("h-11");
    expect(handle.getAttribute("class")).toContain("w-11");
    expect(queryByRole("tablist")).toBeNull();
    expect(queryByTestId("sidechat-shell-stub")).toBeNull();
    const chatPane = getByTestId("sidechat-mobile-pane-chat");
    expect(chatPane.getAttribute("class")).not.toContain("hidden");
    expect(getByTestId("message-list")).toBeDefined();
  });

  it("tapping the handle opens the sidechat AND activates the Sidechat tab", () => {
    const { getByTestId, getByRole } = render(<PlayMode />);
    fireEvent.click(getByTestId("sidechat-toggle"));

    expect(getByRole("tablist")).toBeDefined();
    const chatTab = getByRole("tab", { name: "coauthor.tabs.chat" });
    const sidechatTab = getByRole("tab", { name: "sidechat_toggle_label" });
    expect(chatTab.getAttribute("aria-selected")).toBe("false");
    expect(sidechatTab.getAttribute("aria-selected")).toBe("true");
    // Same persisted open key as the desktop panel.
    expect(localStorage.getItem("vt.sidechat.open.chat-a")).toBe("true");
    // Chat pane mounted but hidden; sidechat pane mounted and visible.
    expect(getByTestId("sidechat-mobile-pane-chat").getAttribute("class")).toContain("hidden");
    expect(getByTestId("sidechat-mobile-pane-sidechat").getAttribute("class")).not.toContain(
      "hidden",
    );
    expect(getByTestId("sidechat-shell-stub")).toBeDefined();
  });

  it("an outside store write shows the tabs (SC-18a)", () => {
    const { getByTestId, getByRole, queryByRole, queryByTestId } = render(<PlayMode />);
    expect(queryByRole("tablist")).toBeNull();
    expect(queryByTestId("sidechat-shell-stub")).toBeNull();

    // SC-18's future entry opens through the store, not through the handle —
    // the tabs appear (the mobile tab itself stays where it was: switching
    // it is SC-18's entry behavior, not this unit's).
    act(() => {
      useSidechatOpenStore.getState().setOpen("chat-a", true);
    });
    expect(getByRole("tablist")).toBeDefined();
    expect(getByTestId("sidechat-shell-stub")).toBeDefined();
    expect(localStorage.getItem("vt.sidechat.open.chat-a")).toBe("true");
  });

  it("tapping the Chat tab switches back while both panes stay mounted", () => {
    const { getByTestId, getByRole } = render(<PlayMode />);
    fireEvent.click(getByTestId("sidechat-toggle"));

    fireEvent.click(getByRole("tab", { name: "coauthor.tabs.chat" }));
    expect(getByRole("tab", { name: "coauthor.tabs.chat" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(getByRole("tab", { name: "sidechat_toggle_label" }).getAttribute("aria-selected")).toBe(
      "false",
    );
    expect(getByTestId("sidechat-mobile-pane-chat").getAttribute("class")).not.toContain("hidden");
    expect(getByTestId("sidechat-mobile-pane-sidechat").getAttribute("class")).toContain("hidden");
    // Still mounted (never unmounted across tab switches).
    expect(getByTestId("message-list")).toBeDefined();
    expect(getByTestId("sidechat-shell-stub")).toBeDefined();
    // Still open — tabs remain.
    expect(getByRole("tablist")).toBeDefined();
    expect(localStorage.getItem("vt.sidechat.open.chat-a")).toBe("true");
  });
});

// ── × closes ────────────────────────────────────────────────────────────────

describe("PlayMode mobile sidechat — × closes back to Chat (SC-15)", () => {
  it("× hides the tabs and returns to Chat", () => {
    const { getByTestId, getByRole, queryByRole, queryByTestId } = render(<PlayMode />);
    fireEvent.click(getByTestId("sidechat-toggle"));
    expect(getByRole("tablist")).toBeDefined();

    fireEvent.click(getByTestId("agent-shell-tab-close"));
    expect(queryByRole("tablist")).toBeNull();
    expect(queryByTestId("sidechat-shell-stub")).toBeNull();
    expect(getByTestId("sidechat-mobile-pane-chat").getAttribute("class")).not.toContain("hidden");
    expect(getByTestId("message-list")).toBeDefined();
    expect(localStorage.getItem("vt.sidechat.open.chat-a")).toBe("false");
    // The shared tab state is back on Chat — reopening lands on Sidechat again.
    expect(useSidechatMobileStore.getState().tab).toBe("chat");
    fireEvent.click(getByTestId("sidechat-toggle"));
    expect(getByRole("tab", { name: "sidechat_toggle_label" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });
});

// ── State survival ──────────────────────────────────────────────────────────

describe("PlayMode mobile sidechat — pane state survives tab switches (SC-15)", () => {
  it("the chat pane keeps its DOM identity + probe value across switches", () => {
    const { getByTestId, getByRole } = render(<PlayMode />);
    fireEvent.click(getByTestId("sidechat-toggle"));

    const probe = getByTestId("chat-probe-input") as HTMLInputElement;
    fireEvent.change(probe, { target: { value: "draft in progress" } });
    const chatNode = getByTestId("message-list");
    const shellNode = getByTestId("sidechat-shell-stub");

    fireEvent.click(getByRole("tab", { name: "coauthor.tabs.chat" }));
    fireEvent.click(getByRole("tab", { name: "sidechat_toggle_label" }));
    fireEvent.click(getByRole("tab", { name: "coauthor.tabs.chat" }));

    // Same nodes — no unmount happened on any switch.
    expect(getByTestId("message-list")).toBe(chatNode);
    expect(getByTestId("sidechat-shell-stub")).toBe(shellNode);
    expect((getByTestId("chat-probe-input") as HTMLInputElement).value).toBe("draft in progress");
  });
});

// ── Gates ───────────────────────────────────────────────────────────────────

describe("PlayMode mobile sidechat — gates (SC-15)", () => {
  it("a co-author chat sees no tabs and no handle", () => {
    seedChat(
      { id: "chat-co", mode: "coauthor" } as unknown as ActiveChat,
      { id: "branch-co", chatId: "chat-co", label: "main" } as unknown as ActiveBranch,
    );
    const { queryByRole, queryByTestId, getByTestId } = render(<PlayMode />);
    expect(queryByRole("tablist")).toBeNull();
    expect(queryByTestId("sidechat-toggle")).toBeNull();
    expect(queryByTestId("sidechat-shell-stub")).toBeNull();
    expect(getByTestId("message-list")).toBeDefined();
  });

  it("desktop renders the pre-SC-15 surface (no tabs, no handle, no shell)", () => {
    mobileOverride = false;
    const { queryByRole, queryByTestId, getByTestId } = render(<PlayMode />);
    expect(queryByRole("tablist")).toBeNull();
    expect(queryByTestId("sidechat-toggle")).toBeNull();
    expect(queryByTestId("sidechat-mobile-pane-chat")).toBeNull();
    expect(queryByTestId("sidechat-shell-stub")).toBeNull();
    // The chat pane itself is untouched.
    expect(getByTestId("message-list")).toBeDefined();
    expect(getByTestId("input-area")).toBeDefined();
  });
});
