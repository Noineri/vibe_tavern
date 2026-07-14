import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => {
  const message = {
    id: "msg_assistant",
    role: "assistant",
    content: "Final answer",
    displayContent: "Final answer",
    tokenCount: 2,
    createdAt: "2026-07-14T00:00:00.000Z",
    selectedVariantIndex: 0,
    variants: [{
      id: "var_1",
      content: "Final answer",
      reasoning: "Private reasoning",
      reasoningDurationMs: 1200,
      modelId: "gemini-3.1-flash-lite-preview",
      presetId: null,
      toolCalls: null,
    }],
  };
  const snapshotState = {
    messageOrder: [message.id],
    messagesById: { [message.id]: message },
  };
  const chatState = {
    activeChatId: "chat_1",
    generations: { chat_1: { pendingUserMessageContent: null } },
    editingMessageId: null,
    editingDraft: "",
    messageActionId: null,
    setEditingDraft: vi.fn(),
  };
  return { message, snapshotState, chatState };
});

vi.mock("../../stores/index.js", () => {
  const useChatStore = Object.assign(
    (selector: (state: typeof fixtures.chatState) => unknown) => selector(fixtures.chatState),
    { getState: () => fixtures.chatState },
  );
  return { useChatStore, useIsSending: () => false };
});

vi.mock("../../stores/snapshot-store.js", () => {
  const useSnapshotStore = Object.assign(
    (selector: (state: typeof fixtures.snapshotState) => unknown) => selector(fixtures.snapshotState),
    { getState: () => fixtures.snapshotState },
  );
  return { useSnapshotStore };
});

vi.mock("../../stores/chat-selectors.js", () => ({
  useDisplayMessage: () => fixtures.message,
  useMessageAuthor: () => ({
    activeChatId: "chat_1",
    character: {
      id: "char_1",
      name: "Test Character",
      avatarExt: null,
      avatarAssetId: null,
      avatarCropJson: null,
      updatedAt: "2026-07-14T00:00:00.000Z",
    },
  }),
  useIsStreamingTarget: () => false,
  useStreamingRevealedFor: () => ({ streamingText: "", revealedText: "", reasoningText: "" }),
}));

vi.mock("../../stores/api-actions/bootstrap-actions.js", () => ({
  useBootstrapStore: (selector: (state: { data: null }) => unknown) => selector({ data: null }),
}));
vi.mock("../../hooks/use-chat-controller.js", () => ({
  useChatController: () => ({
    handleDeleteMessage: vi.fn(),
    handleStartEdit: vi.fn(),
    handleCancelEdit: vi.fn(),
    handleSaveMessageEdit: vi.fn(),
    handleResend: vi.fn(),
  }),
}));
vi.mock("../../i18n/context.js", () => ({ useT: () => ({ t: (key: string) => key }) }));
vi.mock("../../lib/avatar.js", () => ({ resolveEntityAvatarUrl: () => null }));
vi.mock("../../utils/tokenizer.js", () => ({ countTokens: () => 2 }));
vi.mock("../chat/MessageShell.js", () => ({
  MessageShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../chat/MessageReasoning.js", () => ({
  MessageReasoning: () => <div data-layer="reasoning" />,
}));
vi.mock("../chat/CoauthorToolActivitySlot.js", () => ({
  CoauthorToolActivitySlot: () => <div data-layer="tools" />,
}));
vi.mock("../../lib/markdown.js", () => ({
  Markdown: () => <div data-layer="text" />,
}));
vi.mock("../chat/StreamingMarkdown.js", () => ({ StreamingMarkdown: () => null }));
vi.mock("../shared/Logo.js", () => ({ Logo: () => null }));
vi.mock("../shared/auto-textarea.js", () => ({ AutoTextarea: () => null }));
vi.mock("../shared/MobileExpandTextarea.js", () => ({ MobileExpandTextarea: ({ children }: { children: ReactNode }) => children }));
vi.mock("../shared/destructive-confirm-modal.js", () => ({ DestructiveConfirmModal: () => null }));

import { CoauthorTurnShell } from "./CoauthorTurnShell.js";

describe("CoauthorTurnShell assistant part layout", () => {
  it("renders tool activity immediately below reasoning and before final text", () => {
    const { container } = render(<CoauthorTurnShell turnId="msg_assistant" index={0} isLastTurn />);
    const layers = Array.from(container.querySelectorAll<HTMLElement>("[data-layer]"))
      .map((node) => node.dataset.layer);

    expect(layers).toEqual(["reasoning", "tools", "text"]);
  });
});
