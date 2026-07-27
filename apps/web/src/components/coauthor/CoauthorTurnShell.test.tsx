import type { ReactNode } from "react";
import { beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

let render: typeof import("@testing-library/react").render;

const fixtures = (() => {
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
    setEditingDraft: mock(),
  };
  return { message, snapshotState, chatState };
})();

mock.module("../../stores/index.js", () => {
  const useChatStore = Object.assign(
    (selector: (state: typeof fixtures.chatState) => unknown = (state) => state) => selector(fixtures.chatState),
    { getState: () => fixtures.chatState },
  );
  return { useChatStore, useIsSending: () => false };
});

mock.module("../../stores/snapshot-store.js", () => {
  const useSnapshotStore = Object.assign(
    (selector: (state: typeof fixtures.snapshotState) => unknown) => selector(fixtures.snapshotState),
    { getState: () => fixtures.snapshotState },
  );
  return { useSnapshotStore };
});

mock.module("../../stores/chat-selectors.js", () => ({
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

mock.module("../../stores/api-actions/bootstrap-actions.js", () => ({
  useBootstrapStore: (selector: (state: { data: null }) => unknown) => selector({ data: null }),
}));
mock.module("../../hooks/use-chat-controller.js", () => ({
  useChatController: () => ({
    handleDeleteMessage: mock(),
    handleStartEdit: mock(),
    handleCancelEdit: mock(),
    handleSaveMessageEdit: mock(),
    handleResend: mock(),
  }),
}));
mock.module("../../i18n/context.js", () => ({ useT: () => ({ t: (key: string) => key }) }));
mock.module("../../lib/avatar.js", () => ({ resolveEntityAvatarUrl: () => null }));
mock.module("../../utils/tokenizer.js", () => ({ countTokens: () => 2 }));
mock.module("../chat/MessageShell.js", () => ({
  MessageShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
mock.module("../chat/MessageReasoning.js", () => ({
  MessageReasoning: () => <div data-layer="reasoning" />,
}));
mock.module("../chat/CoauthorToolActivitySlot.js", () => ({
  CoauthorToolActivitySlot: () => <div data-layer="tools" />,
}));
mock.module("../../lib/markdown.js", () => ({
  Markdown: () => <div data-layer="text" />,
}));
mock.module("../chat/StreamingMarkdown.js", () => ({ StreamingMarkdown: () => null }));
mock.module("../shared/Logo.js", () => ({ Logo: () => null }));
mock.module("../shared/auto-textarea.js", () => ({ AutoTextarea: () => null }));
mock.module("../shared/MobileExpandTextarea.js", () => ({ MobileExpandTextarea: ({ children }: { children: ReactNode }) => children }));
mock.module("../shared/destructive-confirm-modal.js", () => ({ DestructiveConfirmModal: () => null }));

let CoauthorTurnShell: typeof import("./CoauthorTurnShell.js").CoauthorTurnShell;
beforeAll(async () => {
  ({ render } = await import("@testing-library/react"));
  ({ CoauthorTurnShell } = await import("./CoauthorTurnShell.js"));
});

describe("CoauthorTurnShell assistant part layout", () => {
  it("renders tool activity immediately below reasoning and before final text", () => {
    const { container } = render(<CoauthorTurnShell turnId="msg_assistant" index={0} isLastTurn />);
    const layers = Array.from(container.querySelectorAll<HTMLElement>("[data-layer]"))
      .map((node) => node.dataset.layer);

    expect(layers).toEqual(["reasoning", "tools", "text"]);
  });
});
