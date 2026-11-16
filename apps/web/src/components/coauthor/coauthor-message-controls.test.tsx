import { describe, test, expect, beforeEach, mock } from "bun:test";

import { useDomEnv } from "../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";
import { wireBranch, wireChat, wireChatListItem, wireCharacter, wireMessage, wirePersona } from "../../../test/wire-fixtures.js";
import type { AppMessage, AppSnapshot } from "../../api/types.js";
import type { ChatId } from "@vibe-tavern/domain";

useDomEnv();

const { render, act } = await import("@testing-library/react");

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

const realChatController = await import("../../hooks/use-chat-controller.js");
const realTooltip = await import("../shared/Tooltip.js");
mock.module("../../hooks/use-chat-controller.js", () => ({
  ...realChatController,
  useChatController: () => STABLE_CONTROLLER,
}));

installI18nContextSeam();

// LS-4a: the Continue button renders a Radix CustomTooltip; this suite renders
// MessageBlock without a TooltipProvider, so the tooltip is shimmed to a
// passthrough (same pattern as message-ai-editor-controls.test.tsx). The
// asserted boundary — which row actions exist per mode — is unchanged.
mock.module("../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const { useSnapshotStore } = await import("../../stores/snapshot-store.js");
const { useChatStore } = await import("../../stores/chat-store.js");
const { MessageBlock } = await import("../chat/MessageBlock.js");
const { CoauthorMessageBlock } = await import("./CoauthorMessageBlock.js");
const { CoauthorTurnShell } = await import("./CoauthorTurnShell.js");

function makeAssistantMessage(id: string, content = "msg"): AppMessage {
  return wireMessage(id, { role: "assistant", authorType: "assistant", content });
}

function makeUserMessage(id: string, content = "msg"): AppMessage {
  return wireMessage(id, { role: "user", authorType: "user", content });
}

function seed(messages: AppMessage[], isCoauthorMode: boolean): AppSnapshot {
  return {
    chats: [wireChatListItem({ mode: isCoauthorMode ? "coauthor" : "rp", messageCount: messages.length })],
    allCharacters: [],
    activeChat: wireChat({ mode: isCoauthorMode ? "coauthor" : "rp" }),
    activeBranch: wireBranch(),
    branches: [],
    messages,
    summaries: [],
    promptTrace: null,
    character: wireCharacter({ id: "c1", name: "Char c1" }),
    persona: wirePersona({ id: "p1", name: "Persona" }),
  };
}

const CHAT = "chat-1";

beforeEach(() => {
  useSnapshotStore.getState().clear();
  useChatStore.setState({ activeChatId: null });
});

describe("CS-32 Message Controls in Co-author mode", () => {
  test("RP mode: Branch and Regenerate are present for assistant", async () => {
    useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1")], false));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <MessageBlock messageId="m1" index={0} isFirstAssistant={false} isLast={true} prevRole="user" />
    );
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).toContain("branch");
    expect(container.textContent).toContain("regen");
  });

  test("Co-author mode: Branch and Regenerate are HIDDEN for assistant", async () => {
    useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1")], true));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <CoauthorTurnShell turnId="m1" index={0} isLastTurn={true} />
    );
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).not.toContain("branch");
    expect(container.textContent).not.toContain("regen");
  });

  test("RP mode: Resend is present for last user message", async () => {
    useSnapshotStore.getState().ingestSnapshot(seed([makeUserMessage("u1")], false));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <MessageBlock messageId="u1" index={0} isFirstAssistant={false} isLast={true} prevRole="assistant" />
    );
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).toContain("resend");
  });

  test("Co-author mode: Resend is PRESENT for last user message", async () => {
    useSnapshotStore.getState().ingestSnapshot(seed([makeUserMessage("u1")], true));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <CoauthorMessageBlock messageId="u1" index={0} isFirstAssistant={false} isLast={true} prevRole="assistant" />
    );
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).toContain("resend");
    expect(container.textContent).not.toContain("branch");
  });

  test("Co-author mode: AI editor (Sparkles) affordance is ABSENT on co-author assistant turns", async () => {
    useSnapshotStore.getState().ingestSnapshot(seed([makeAssistantMessage("m1")], true));
    useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <CoauthorTurnShell turnId="m1" index={0} isLastTurn={true} />
    );
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).not.toContain("branch");
    expect(container.textContent).not.toContain("regen");
    expect(container.querySelectorAll('button[aria-label="message_ai_editor_tooltip"]').length).toBe(0);
    expect(container.querySelectorAll('button[aria-label="message_ai_editor_tooltip"][disabled]').length).toBe(0);
  });
});
