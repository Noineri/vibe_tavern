import { describe, test, expect, beforeEach, mock } from "bun:test";
import { render, act } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";
import type { AppCharacter, AppMessage, AppSnapshot, AppPersona } from "../../app-client.js";
import type { ChatId } from "@vibe-tavern/domain";

useDomEnv();

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

const realChatController = await import("../../hooks/use-chat-controller.js");
const realI18nContext = await import("../../i18n/context.js");
mock.module("../../hooks/use-chat-controller.js", () => ({
  ...realChatController,
  useChatController: () => STABLE_CONTROLLER,
}));

mock.module("../../i18n/context.js", () => ({
  ...realI18nContext,
  useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: NOOP, ready: true }),
}));

const { useSnapshotStore } = await import("../../stores/snapshot-store.js");
const { useChatStore } = await import("../../stores/chat-store.js");
const { MessageBlock } = await import("../chat/MessageBlock.js");
const { CoauthorMessageBlock } = await import("./CoauthorMessageBlock.js");
const { CoauthorTurnShell } = await import("./CoauthorTurnShell.js");

function makeAssistantMessage(id: string, content = "msg"): AppMessage {
  return {
    id, role: "assistant", content,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    variants: [], selectedVariantIndex: null, modelId: null,
  } as unknown as AppMessage;
}

function makeUserMessage(id: string, content = "msg"): AppMessage {
  return {
    id, role: "user", content,
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
