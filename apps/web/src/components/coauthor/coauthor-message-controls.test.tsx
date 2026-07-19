import { describe, test, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { MessageBlock } from "../chat/MessageBlock.js";
import { CoauthorMessageBlock } from "./CoauthorMessageBlock.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import { useChatStore } from "../../stores/chat-store.js";
import type { AppCharacter, AppMessage, AppSnapshot, AppPersona } from "../../app-client.js";
import type { ChatId } from "@vibe-tavern/domain";
import { CoauthorTurnShell } from "./CoauthorTurnShell.js";

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
  useT: () => ({ t: (key: string) => key, tDynamic: (key: string) => key, locale: "en", setLocale: NOOP, ready: true }),
}));

beforeAll(() => {
});

afterAll(() => {
});

afterEach(() => {
  cleanup();
});

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
});
