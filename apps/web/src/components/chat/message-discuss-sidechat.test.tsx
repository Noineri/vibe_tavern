/**
 * SC-18 — «Discuss in the sidechat» RP-message entry, wired through the real
 * MessageBlock (its served-modes gate and its attach-and-open handler are
 * the code under test).
 *
 * Pins:
 *   - visibility: assistant messages of a SERVED chat mode only (the
 *     served-modes selector — never a hard-coded mode); absent for user
 *     messages, co-author chats, and before the bootstrap kind-settings land;
 *   - one variant attaches at once as `#1 · selected`;
 *   - several variants open the choice; «All variants» parks every variant
 *     with the RP-selected one marked, «Only selected» parks just it;
 *   - the entry turns the sidechat on (desktop), and on mobile also switches
 *     to the «Sidechat» tab; the RP selection never changes.
 *
 * The mock surface mirrors message-ai-editor-controls.test.tsx:
 * STABLE_CONTROLLER for useChatController, key-echo i18n, and useIsMobile as
 * a per-test flippable mock.
 */
import { describe, test, expect, beforeAll, afterEach, beforeEach, mock } from "bun:test";
import { normalizeInsightsConfig, normalizeObjectiveState, CHAT_MODE } from "@vibe-tavern/domain";
import type { ReactNode } from "react";
import type { AgentKindSettingsWire } from "@vibe-tavern/api-contracts";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";
import { useSidechatOpenStore, readSidechatOpen } from "../../stores/sidechat-open-store.js";
import { useSidechatMobileStore } from "../../stores/sidechat-mobile-store.js";
import {
  readPendingVariantAttachments,
  useSidechatVariantAttachmentsStore,
} from "../../stores/sidechat-variant-attachments-store.js";
import type { AppCharacter, AppMessage, AppSnapshot, AppPersona } from "../../api/types.js";
import { type ChatId, type MessageVariantId } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../test/dom-env.js";
import { wireUiSettings } from "../../../test/wire-fixtures.js";

// failOnNetwork: copied from message-ai-editor-controls.test.tsx — the bubble
// must never reach the live API port from a unit test.
useDomEnv({ failOnNetwork: true });

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
  handleContinueMessage: NOOP_ASYNC,
  handleSelectMessageVariant: NOOP_ASYNC,
  handleResend: NOOP_ASYNC,
  handleFork: NOOP_ASYNC,
  handleActivateBranch: NOOP_ASYNC,
  handleDeleteActiveBranch: NOOP_ASYNC,
  handleRenameBranch: NOOP_ASYNC,
};

const useIsMobile = mock(() => false);
const realChatController = await import("../../hooks/use-chat-controller.js");
const realI18nContext = await import("../../i18n/context.js");
const realMobileHook = await import("../../hooks/use-mobile.js");
const realTooltip = await import("../shared/Tooltip.js");
const realVoiceMapData = await import("../../lib/tts/voice-map-data.js");
const realRegexApi = await import("../../api/regex-api.js");
mock.module("../../hooks/use-chat-controller.js", () => ({
  ...realChatController,
  useChatController: () => STABLE_CONTROLLER,
}));

mock.module("../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({
    t: (key: string) => key,
    tDynamic: (key: string) => key,
    locale: "en",
    setLocale: NOOP,
    ready: true,
  }),
}));

mock.module("../../hooks/use-mobile.js", () => ({
  ...realMobileHook,
  useIsMobile,
}));

mock.module("../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));

mock.module("../../lib/tts/voice-map-data.js", () => ({
  ...realVoiceMapData,
  useVoiceMapData: () => ({ data: null, refresh: async () => {} }),
}));

mock.module("../../api/regex-api.js", () => ({
  ...realRegexApi,
  resolveActiveRegexPresets: async () => [],
}));

let render: typeof import("@testing-library/react").render;
let act: typeof import("@testing-library/react").act;
let fireEvent: typeof import("@testing-library/react").fireEvent;
beforeAll(async () => {
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
  ({ render, act, fireEvent } = await import("@testing-library/react"));
});

interface VariantSeed {
  id: string;
  variantIndex: number;
  isSelected: boolean;
}

function makeAssistantMessage(id: string, variants: VariantSeed[], selectedVariantIndex: number): AppMessage {
  return {
    id,
    branchId: "b1",
    role: "assistant",
    content: "msg",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    variants: variants.map((v) => ({
      id: v.id as MessageVariantId,
      messageId: id,
      variantIndex: v.variantIndex,
      content: `variant ${v.variantIndex}`,
      isSelected: v.isSelected,
    })),
    selectedVariantIndex,
    modelId: null,
  } as unknown as AppMessage;
}

function makeUserMessage(id: string): AppMessage {
  return {
    id, branchId: "b1", role: "user", content: "msg",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    variants: [], selectedVariantIndex: null, modelId: null,
  } as unknown as AppMessage;
}

function seed(messages: AppMessage[], mode: "rp" | "coauthor"): AppSnapshot {
  return {
    chats: [{ id: "chat-1", title: "Chat", characterId: "c1", mode, messageCount: messages.length, updatedAt: "2026-01-01T00:00:00.000Z" }],
    allCharacters: [],
    activeChat: { id: "chat-1", title: "Chat", characterId: "c1", mode, insightsConfig: normalizeInsightsConfig({}), insightsObjectiveState: normalizeObjectiveState({}) } as unknown as AppSnapshot["activeChat"],
    activeBranch: { id: "b1", chatId: "chat-1", label: "main" } as unknown as AppSnapshot["activeBranch"],
    branches: [],
    messages,
    summaries: [],
    promptTrace: null,
    character: { id: "c1", name: "Char c1", avatarExt: null, avatarAssetId: null, avatarCropJson: null } as unknown as AppCharacter,
    persona: { id: "p1", name: "Persona", avatarExt: null, avatarAssetId: null, avatarCropJson: null } as unknown as AppPersona,
  } as unknown as AppSnapshot;
}

function seedBootstrap(agentKindSettings: Record<string, AgentKindSettingsWire>): void {
  useBootstrapStore.setState({
    data: {
      initialChatId: null,
      snapshot: null,
      isFirstRun: false,
      allCharacters: [],
      promptPresets: [],
      uiSettings: wireUiSettings(),
      agentKindSettings,
      isArmServer: false,
    },
  });
}

function servedSettings(): Record<string, AgentKindSettingsWire> {
  return {
    "sidechat-ooc": {
      agentKind: "sidechat-ooc",
      providerProfileId: null,
      modelName: null,
      defaultProfileId: null,
      updatedAt: "",
      servesChatModes: [CHAT_MODE.rp],
    },
  };
}

const CHAT = "chat-1";
const TRIGGER = '[data-testid="discuss-sidechat-trigger"]';
const SINGLE = [{ id: "m1-v0", variantIndex: 0, isSelected: true }];
const TRIPLE = [
  { id: "m1-v0", variantIndex: 0, isSelected: false },
  { id: "m1-v1", variantIndex: 1, isSelected: true },
  { id: "m1-v2", variantIndex: 2, isSelected: false },
];

beforeEach(() => {
  useIsMobile.mockReset();
  useIsMobile.mockReturnValue(false);
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
  useSidechatVariantAttachmentsStore.setState({ pendingByChatBranch: {} });
  useSidechatOpenStore.setState({ openByChat: {} });
  useSidechatMobileStore.setState({ tab: "chat" });
  localStorage.clear();
  seedBootstrap(servedSettings());
});

afterEach(() => {
  // Process-global restores (the shared worker): bootstrap back to pristine
  // (data null — the store's initial), the open key out of storage.
  useBootstrapStore.setState({ data: null });
  localStorage.clear();
});

async function renderBlock(messageId: string) {
  const { MessageBlock } = await import("./MessageBlock.js");
  const view = render(
    <MessageBlock messageId={messageId} index={0} isFirstAssistant={false} isLast={true} prevRole="user" />,
  );
  await act(async () => { await Promise.resolve(); });
  return view;
}

describe("SC-18 discuss in sidechat (MessageBlock wiring)", () => {
  test("served RP assistant message shows the entry", async () => {
    useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1", SINGLE, 0)], "rp"));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const view = await renderBlock("m1");
    const trigger = view.container.querySelector(TRIGGER) as HTMLElement | null;
    expect(trigger, "the entry must render on a served RP assistant message").not.toBeNull();
    expect(trigger?.getAttribute("aria-label")).toBe("discuss_in_sidechat_tooltip");
  });

  test("user messages never show the entry", async () => {
    useSnapshotStore.getState().ingestSnapshot(seed([makeUserMessage("u1")], "rp"));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const view = await renderBlock("u1");
    expect(view.container.querySelector(TRIGGER)).toBeNull();
  });

  test("co-author chats never show the entry (served-modes selector, no hard-code)", async () => {
    useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1", SINGLE, 0)], "coauthor"));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const view = await renderBlock("m1");
    expect(view.container.querySelector(TRIGGER)).toBeNull();
  });

  test("the entry stays hidden before the bootstrap kind-settings land", async () => {
    seedBootstrap({});
    useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1", SINGLE, 0)], "rp"));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const view = await renderBlock("m1");
    expect(view.container.querySelector(TRIGGER)).toBeNull();
  });

  test("one variant attaches at once, opens the closed sidechat, keeps the mobile tab", async () => {
    useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1", SINGLE, 0)], "rp"));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));
    expect(readSidechatOpen(CHAT)).toBe(false);

    const view = await renderBlock("m1");
    fireEvent.click(view.container.querySelector(TRIGGER) as HTMLElement);

    expect(readPendingVariantAttachments(CHAT, "b1")).toEqual([
      { messageId: "m1", variantId: "m1-v0", variantNumber: 1, selected: true },
    ]);
    expect(readSidechatOpen(CHAT)).toBe(true);
    expect(useSidechatMobileStore.getState().tab).toBe("chat");
    // The RP selection never changes.
    expect(useSnapshotStore.getState().messagesById["m1"]?.selectedVariantIndex).toBe(0);
  });

  test("several variants: «All variants» parks every variant with the RP-selected one marked", async () => {
    useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1", TRIPLE, 1)], "rp"));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const view = await renderBlock("m1");
    fireEvent.click(view.container.querySelector(TRIGGER) as HTMLElement);
    fireEvent.click(await view.findByTestId("discuss-scope-all"));

    expect(readPendingVariantAttachments(CHAT, "b1")).toEqual([
      { messageId: "m1", variantId: "m1-v0", variantNumber: 1, selected: false },
      { messageId: "m1", variantId: "m1-v1", variantNumber: 2, selected: true },
      { messageId: "m1", variantId: "m1-v2", variantNumber: 3, selected: false },
    ]);
    expect(readSidechatOpen(CHAT)).toBe(true);
    expect(useSnapshotStore.getState().messagesById["m1"]?.selectedVariantIndex).toBe(1);
  });

  test("several variants: «Only selected» parks just the RP-selected variant", async () => {
    useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1", TRIPLE, 1)], "rp"));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const view = await renderBlock("m1");
    fireEvent.click(view.container.querySelector(TRIGGER) as HTMLElement);
    fireEvent.click(await view.findByTestId("discuss-scope-selected"));

    expect(readPendingVariantAttachments(CHAT, "b1")).toEqual([
      { messageId: "m1", variantId: "m1-v1", variantNumber: 2, selected: true },
    ]);
    expect(readSidechatOpen(CHAT)).toBe(true);
  });

  test("mobile: the entry parks the chip, opens the sidechat AND switches to the Sidechat tab", async () => {
    useIsMobile.mockReturnValue(true);
    useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1", SINGLE, 0)], "rp"));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const view = await renderBlock("m1");
    fireEvent.click(view.container.querySelector(TRIGGER) as HTMLElement);

    expect(readPendingVariantAttachments(CHAT, "b1")).toEqual([
      { messageId: "m1", variantId: "m1-v0", variantNumber: 1, selected: true },
    ]);
    expect(readSidechatOpen(CHAT)).toBe(true);
    expect(useSidechatMobileStore.getState().tab).toBe("sidechat");
  });

  test("mobile: the sheet choice parks every variant and switches the tab", async () => {
    useIsMobile.mockReturnValue(true);
    useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1", TRIPLE, 1)], "rp"));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const view = await renderBlock("m1");
    fireEvent.click(view.container.querySelector(TRIGGER) as HTMLElement);
    fireEvent.click(await view.findByTestId("discuss-scope-all"));

    expect(readPendingVariantAttachments(CHAT, "b1")).toHaveLength(3);
    expect(readSidechatOpen(CHAT)).toBe(true);
    expect(useSidechatMobileStore.getState().tab).toBe("sidechat");
  });
});
