/**
 * MAE-52 — message AI editor entry-point controls.
 *
 * Pins the placement and gating of the Sparkles ("AI editor") affordance on
 * RP assistant messages:
 *   - Desktop: rendered in the same action group as Edit, immediately after
 *     it (DOM order Edit → Sparkles); icon-only with an accessible name and
 *     tooltip text from `tDynamic("message_ai_editor_tooltip")`.
 *   - Mobile: a 44px button in the right inline action group, immediately to
 *     the LEFT of Regenerate. The right grid track grows from 44px to auto so
 *     both buttons fit without shifting the centered variant controls or the
 *     branch button on the left track.
 *   - Gates: visible ONLY on committed RP assistant messages. Absent for
 *     user / system / tool roles, during streaming (`isGenerating` hides the
 *     whole action row), and in Co-Author mode. The button is disabled while
 *     `isBusy` (sending or in-flight message action) — same gate as Edit.
 *   - Action Sheet (mobile three-dot menu) must NOT include an AI-editor row.
 *
 * The mock surface mirrors coauthor-message-controls.test.tsx: STABLE_CONTROLLER
 * for useChatController, useT returning the key string, and useIsMobile as a
 * per-test flippable vi.fn. MessageBlock is mounted for real so its `canAiEdit`
 * gate and action-bar wiring are the code under test.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useMessageAiEditorStore } from "../../stores/message-ai-editor-store.js";
import type { AppCharacter, AppMessage, AppSnapshot, AppPersona } from "../../app-client.js";
import type { ChatId, MessageVariantId } from "@vibe-tavern/domain";

const asChatId = (id: string): ChatId => id as ChatId;

const NOOP = () => {};
const NOOP_ASYNC = async () => {};

const STABLE_CONTROLLER = {
  handleSend: NOOP_ASYNC,
  handleCancelGeneration: NOOP,
  handleSwitchChat: NOOP_ASYNC,
  handleStartEdit: NOOP,
  handleCancelEdit: NOOP,
  handleSaveMessageEdit: NOOP_ASYNC,
  handleDeleteMessage: NOOP_ASYNC,
  handleDeleteVariant: NOOP_ASYNC,
  handleRegenerateMessage: NOOP_ASYNC,
  handleSelectMessageVariant: NOOP_ASYNC,
  handleResend: NOOP_ASYNC,
  handleFork: NOOP_ASYNC,
  handleActivateBranch: NOOP_ASYNC,
  handleDeleteActiveBranch: NOOP_ASYNC,
  handleRenameBranch: NOOP_ASYNC,
};

vi.mock("../../hooks/use-chat-controller.js", () => ({
  useChatController: () => STABLE_CONTROLLER,
}));

vi.mock("../../i18n/context.js", () => ({
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: NOOP,
    ready: true,
  }),
}));

vi.mock("../../hooks/use-mobile.js", () => ({
  useIsMobile: vi.fn(() => false),
}));

vi.mock("../shared/Tooltip.js", () => ({
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

beforeAll(() => {
  if (typeof window !== "undefined") {
    if (!window.matchMedia) {
      window.matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener: NOOP, removeEventListener: NOOP,
        addListener: NOOP, removeListener: NOOP, dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
    }
    if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      (window as { ResizeObserver?: unknown }).ResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    }
  }
});

afterAll(() => {});

afterEach(() => {
  cleanup();
});

function makeAssistantMessage(id: string, content = "msg"): AppMessage {
  return {
    id,
    role: "assistant",
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    variants: [
      { id: `${id}-v0` as MessageVariantId, messageId: id, variantIndex: 0, content, isSelected: true },
    ],
    selectedVariantIndex: 0,
    modelId: null,
  } as unknown as AppMessage;
}

function makeUserMessage(id: string, content = "msg"): AppMessage {
  return {
    id, role: "user", content,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    variants: [], selectedVariantIndex: null, modelId: null,
  } as unknown as AppMessage;
}

function makeSystemMessage(id: string, content = "system"): AppMessage {
  return {
    id, role: "system", content,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    variants: [], selectedVariantIndex: null, modelId: null,
  } as unknown as AppMessage;
}

function makeToolMessage(id: string, content = "tool"): AppMessage {
  return {
    id, role: "tool", content,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    variants: [], selectedVariantIndex: null, modelId: null,
  } as unknown as AppMessage;
}

function seed(messages: AppMessage[], isCoauthorMode: boolean): AppSnapshot {
  return {
    chats: [{ id: "chat-1", title: "Chat", characterId: "c1", mode: isCoauthorMode ? "coauthor" : "rp", messageCount: messages.length, updatedAt: "2026-01-01T00:00:00.000Z" }],
    allCharacters: [],
    activeChat: { id: "chat-1", title: "Chat", characterId: "c1", mode: isCoauthorMode ? "coauthor" : "rp" } as unknown as AppSnapshot["activeChat"],
    activeBranch: { id: "b1", chatId: "chat-1", label: "main" } as unknown as AppSnapshot["activeBranch"],
    branches: [],
    messages,
    summaries: [],
    promptTrace: null,
    character: { id: "c1", name: "Char c1", avatarExt: null, avatarAssetId: null, avatarCropJson: null } as unknown as AppCharacter,
    persona: { id: "p1", name: "Persona", avatarExt: null, avatarAssetId: null, avatarCropJson: null } as unknown as AppPersona,
  } as unknown as AppSnapshot;
}

const CHAT = "chat-1";
const TOOLTIP_KEY = "message_ai_editor_tooltip";

beforeEach(() => {
  useSnapshotStore.getState().clear();
  useChatStore.setState({
    activeChatId: null,
    selectedCharacterId: null,
    draft: "",
    editingMessageId: null,
    editingDraft: "",
    messageActionId: null,
    selectedTraceId: null,
    generations: {},
    draftAttachments: [],
  });
  useMessageAiEditorStore.setState({ target: null, starredVariantIdsByMessage: {} });
});

describe("MAE-52 message AI editor controls", () => {
  test("desktop: assistant message shows Edit then Sparkles as an adjacent action group with tooltip + accessible name", async () => {
    const { MessageBlock } = await import("./MessageBlock.js");
    useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1")], false));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <MessageBlock messageId="m1" index={0} isFirstAssistant={false} isLast={true} prevRole="user" />,
    );
    await act(async () => { await Promise.resolve(); });

    const editEl = Array.from(container.querySelectorAll("*")).find(el => el.textContent === "edit");
    expect(editEl, "Edit action must be present").toBeTruthy();

    const sparklesBtn = container.querySelector(`button[aria-label="${TOOLTIP_KEY}"]`);
    expect(sparklesBtn, "Sparkles button with accessible name must be present").not.toBeNull();

    const editAction = editEl!.closest("[class*='cursor-pointer']") ?? editEl;
    const group = (editAction as HTMLElement).parentElement;
    expect(group, "Edit and Sparkles must share a parent action group").not.toBeNull();
    expect(group!.contains(sparklesBtn), "Sparkles must be inside the same action group as Edit").toBe(true);

    const groupChildren = Array.from(group!.children);
    const editIdx = groupChildren.findIndex(c => (c as HTMLElement).textContent === "edit");
    const sparklesIdx = groupChildren.indexOf(sparklesBtn!);
    expect(editIdx, "Edit must be in the group children").toBeGreaterThanOrEqual(0);
    expect(sparklesIdx, "Sparkles must be in the group children").toBeGreaterThan(editIdx);
    expect(sparklesIdx - editIdx, "Sparkles must immediately follow Edit (DOM adjacency)").toBe(1);

    expect(sparklesBtn!.getAttribute("title") === TOOLTIP_KEY || sparklesBtn!.querySelector("svg"), "icon-only sparkles glyph present").toBeTruthy();
  });

  test("desktop: clicking Sparkles opens the AI editor in message_edit mode with the selected variant id", async () => {
    const { MessageBlock } = await import("./MessageBlock.js");
    useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1", "hello")], false));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <MessageBlock messageId="m1" index={0} isFirstAssistant={false} isLast={true} prevRole="user" />,
    );
    await act(async () => { await Promise.resolve(); });

    const sparklesBtn = container.querySelector(`button[aria-label="${TOOLTIP_KEY}"]`) as HTMLButtonElement;
    expect(sparklesBtn).not.toBeNull();

    await act(async () => { sparklesBtn.click(); });
    const target = useMessageAiEditorStore.getState().target;
    expect(target, "openEditor must populate the store target").not.toBeNull();
    expect(target!.requestedMode).toBe("message_edit");
    expect(target!.targetMessageId).toBe("m1");
    expect(target!.selectedSourceVariantId).toBe("m1-v0");
  });

  test("mobile: Sparkles sits immediately LEFT of Regenerate as a 44px button in a content-sized right track", async () => {
    const { useIsMobile } = await import("../../hooks/use-mobile.js");
    vi.mocked(useIsMobile).mockReturnValue(true);

    const { MessageBlock } = await import("./MessageBlock.js");
    useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1")], false));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <MessageBlock messageId="m1" index={0} isFirstAssistant={false} isLast={true} prevRole="user" />,
    );
    await act(async () => { await Promise.resolve(); });

    const sparklesBtn = container.querySelector(`button[aria-label="${TOOLTIP_KEY}"]`) as HTMLButtonElement | null;
    expect(sparklesBtn, "Sparkles button must be present in the mobile right group").not.toBeNull();
    expect(sparklesBtn!.className).toContain("h-11");
    expect(sparklesBtn!.className).toContain("w-11");

    const rightGroup = sparklesBtn!.parentElement;
    expect(rightGroup, "Sparkles must sit in the right inline action group").not.toBeNull();
    expect(rightGroup!.className).toContain("justify-end");

    const rightChildren = Array.from(rightGroup!.children).filter(c => c.tagName === "BUTTON");
    const sparklesIdx = rightChildren.indexOf(sparklesBtn!);
    const regenIdx = rightChildren.findIndex(b => b.getAttribute("title") === "regen");
    expect(regenIdx, "Regenerate button must be present in the mobile right group").toBeGreaterThanOrEqual(0);
    expect(sparklesIdx, "Sparkles must come before Regenerate (immediately LEFT)").toBeGreaterThanOrEqual(0);
    expect(regenIdx - sparklesIdx, "Sparkles is immediately LEFT of Regenerate").toBe(1);

    const grid = rightGroup!.parentElement;
    expect(grid, "right group must be inside the action grid").not.toBeNull();
    expect(grid!.className, "mobile action grid uses content-sized right track (auto, not fixed 44px)").toContain("_auto]");
    expect(grid!.className, "must NOT use the legacy fixed 44px right track").not.toContain("_44px]");
  });

  test("role gate: AI editor is ABSENT for user messages", async () => {
    const { MessageBlock } = await import("./MessageBlock.js");
    useSnapshotStore.getState().ingestSnapshot(seed([makeUserMessage("u1")], false));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <MessageBlock messageId="u1" index={0} isFirstAssistant={false} isLast={true} prevRole="assistant" />,
    );
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector(`button[aria-label="${TOOLTIP_KEY}"]`)).toBeNull();
  });

  test("role gate: AI editor is ABSENT for system messages", async () => {
    const { MessageBlock } = await import("./MessageBlock.js");
    useSnapshotStore.getState().ingestSnapshot(seed([makeSystemMessage("s1")], false));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <MessageBlock messageId="s1" index={0} isFirstAssistant={false} isLast={true} prevRole="assistant" />,
    );
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector(`button[aria-label="${TOOLTIP_KEY}"]`)).toBeNull();
  });

  test("role gate: AI editor is ABSENT for tool messages", async () => {
    const { MessageBlock } = await import("./MessageBlock.js");
    useSnapshotStore.getState().ingestSnapshot(seed([makeToolMessage("t1")], false));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <MessageBlock messageId="t1" index={0} isFirstAssistant={false} isLast={true} prevRole="assistant" />,
    );
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector(`button[aria-label="${TOOLTIP_KEY}"]`)).toBeNull();
  });

  test("streaming gate: AI editor is ABSENT while the assistant message is generating (action row hidden)", async () => {
    const { MessageBlock } = await import("./MessageBlock.js");
    useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1")], false));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    act(() => {
      useChatStore.getState().startGeneration(CHAT, null, undefined, "m1");
    });
    await act(async () => { await Promise.resolve(); });

    const { container } = render(
      <MessageBlock messageId="m1" index={0} isFirstAssistant={false} isLast={true} prevRole="user" />,
    );
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector(`button[aria-label="${TOOLTIP_KEY}"]`)).toBeNull();
  });

  test("Co-Author mode gate: AI editor is ABSENT for assistant messages in coauthor mode (via MessageBlock)", async () => {
    const { MessageBlock } = await import("./MessageBlock.js");
    useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1")], true));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <MessageBlock messageId="m1" index={0} isFirstAssistant={false} isLast={true} prevRole="user" />,
    );
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector(`button[aria-label="${TOOLTIP_KEY}"]`)).toBeNull();
  });

  test("busy gate: Sparkles button is disabled when isBusy (sending) on a non-last assistant message", async () => {
    const { MessageBlock } = await import("./MessageBlock.js");
    useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1"), makeAssistantMessage("m2")], false));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    act(() => {
      useChatStore.getState().startGeneration(CHAT, null, undefined, "m2");
    });
    await act(async () => { await Promise.resolve(); });

    const { container } = render(
      <MessageBlock messageId="m1" index={0} isFirstAssistant={false} isLast={false} prevRole="user" />,
    );
    await act(async () => { await Promise.resolve(); });

    const sparklesBtn = container.querySelector(`button[aria-label="${TOOLTIP_KEY}"]`) as HTMLButtonElement | null;
    expect(sparklesBtn, "Sparkles must be present on a non-last assistant message while a sibling is generating").not.toBeNull();
    expect(sparklesBtn!.disabled, "Sparkles must be disabled while isBusy (chat-wide isSending)").toBe(true);
  });

  test("greeting gate: AI editor is ABSENT on the first assistant message (greeting) — greetings are not swipes", async () => {
    const { MessageBlock } = await import("./MessageBlock.js");
    useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("g1")], false));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <MessageBlock messageId="g1" index={0} isFirstAssistant={true} isLast={true} prevRole={null} />,
    );
    await act(async () => { await Promise.resolve(); });

    // Greetings are not swipes: the AI editor (edit + merge) is hidden on the
    // first assistant message, mirroring the regenerate button's !isGreeting gate.
    expect(container.querySelector(`button[aria-label="${TOOLTIP_KEY}"]`)).toBeNull();
  });

  test("mobile Action Sheet NEVER exposes an AI editor entry", async () => {
    const { useIsMobile } = await import("../../hooks/use-mobile.js");
    vi.mocked(useIsMobile).mockReturnValue(true);

    const { MessageBlock } = await import("./MessageBlock.js");
    useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1")], false));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <MessageBlock messageId="m1" index={0} isFirstAssistant={false} isLast={true} prevRole="user" />,
    );
    await act(async () => { await Promise.resolve(); });

    const ellipsisSvgs = container.querySelectorAll("svg");
    let menuTrigger: HTMLElement | null = null;
    for (const svg of Array.from(ellipsisSvgs)) {
      const parent = svg.parentElement;
      if (parent && parent.className.includes("min-h-[44px]") && parent.className.includes("cursor-pointer")) {
        menuTrigger = parent as HTMLElement;
        break;
      }
    }
    expect(menuTrigger, "mobile three-dot menu trigger must be present").not.toBeNull();
    await act(async () => { menuTrigger!.click(); });
    await act(async () => { await Promise.resolve(); });

    const sheetText = document.body.textContent ?? "";
    expect(sheetText, "Action Sheet must not surface the tooltip key").not.toContain(TOOLTIP_KEY);
    expect(sheetText, "Action Sheet must not surface any ai-editor label fragment").not.toContain("ai_editor");
    const popup = document.querySelector(".bs-popup");
    expect(popup, "Action Sheet popup must be rendered after opening the three-dot menu").not.toBeNull();
    const sheetSparkles = popup!.querySelectorAll(`button[aria-label="${TOOLTIP_KEY}"]`);
    expect(sheetSparkles.length, "no AI-editor item rendered inside the mobile Action Sheet popup").toBe(0);
  });
});
