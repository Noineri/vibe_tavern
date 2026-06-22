import { describe, test, expect, beforeAll, afterAll, afterEach, beforeEach, mock } from "bun:test";
import { render, cleanup, act } from "@testing-library/react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Variant-carousel gating invariant for the mobile message actions row.
 *
 * WHAT THIS PROVES
 *   On mobile, the prev/next variant carousel (VariantControls mobile) must
 *   only be offered for the LAST message in the chat. For older assistant
 *   messages the carousel must NOT render at all — exactly as the desktop
 *   actions row already gates with `&& canSwitchVariant`. Letting the carousel
 *   act on an old message silently flips which swipe is "current" and detaches
 *   the following user reply from the variant the user actually responded to.
 *   Reported symptom (2026-06-21): after importing a SillyTavern chat, opening
 *   it on a phone and brushing an old assistant message's arrows rewrote the
 *   active variant — read as "import picked the wrong swipe".
 *
 * HOW IT PROVES IT
 *   The real MessageBlock is mounted for a multi-variant assistant message
 *   under two `isLast` values (false / true) with `useIsMobile()` resolving
 *   true (matchMedia mocked mobile). The variant counter "1/3" is the sentinel
 *   that the mobile variant controls rendered. It must be absent for non-last
 *   and present for last.
 *
 * ROOT CAUSE (for the fix this gates)
 *   MessageShell.tsx MobileMessageActions rendered its `variantControls` slot
 *   under `{!isUser && !isGreeting && variantControls}` — missing the
 *   `&& canSwitchVariant` gate that DesktopMessageActions already enforces.
 */

// ---------------------------------------------------------------------------
// Module mocks — same boundary pattern as message-block-isolation.test.tsx.
// ---------------------------------------------------------------------------

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

mock.module("../../hooks/use-chat-controller.js", () => ({
  useChatController: () => STABLE_CONTROLLER,
}));

mock.module("../../i18n/context.js", () => ({
  useT: () => ({ t: (key: string) => key, locale: "en", setLocale: NOOP, ready: true }),
}));

// ---------------------------------------------------------------------------
// Scoped happy-dom + matchMedia mocked to MOBILE (so useIsMobile() === true).
// ---------------------------------------------------------------------------

beforeAll(() => {
  GlobalRegistrator.register();
  if (typeof window !== "undefined") {
    // Mobile viewport: the (max-width: 768px) query must match.
    window.matchMedia = (q: string) => ({
      matches: q === "(max-width: 768px)",
      media: q, onchange: null,
      addEventListener: NOOP, removeEventListener: NOOP,
      addListener: NOOP, removeListener: NOOP, dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
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

afterAll(() => {
  GlobalRegistrator.unregister();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Dynamic imports AFTER mocks.
// ---------------------------------------------------------------------------

const MessageBlockModule = import("./MessageBlock.js");
const SnapshotStoreModule = import("../../stores/snapshot-store.js");
const ChatStoreModule = import("../../stores/chat-store.js");

async function loadModules() {
  const [{ MessageBlock }, snapshotStore, chatStore] = await Promise.all([
    MessageBlockModule as Promise<{ MessageBlock: React.ComponentType<{ messageId: string; index: number; isFirstAssistant: boolean; isLast: boolean; prevRole: string | null }> }>,
    SnapshotStoreModule as Promise<typeof import("../../stores/snapshot-store.js")>,
    ChatStoreModule as Promise<typeof import("../../stores/chat-store.js")>,
  ]);
  return { MessageBlock, snapshotStore, chatStore };
}

// ---------------------------------------------------------------------------
// Factories (mirror message-block-isolation.test.tsx conventions).
// ---------------------------------------------------------------------------

import type { AppCharacter, AppMessage, AppSnapshot, AppPersona } from "../../app-client.js";
import type { ChatId } from "@vibe-tavern/domain";

const asChatId = (id: string): ChatId => id as ChatId;

function makeCharacter(id: string): AppCharacter {
  return {
    id, name: `Char ${id}`, avatarExt: null, avatarFullExt: null, description: "", scenario: "",
    systemPrompt: "", subtitle: "", firstMessage: null, mesExample: null,
    mesExampleMode: "always", mesExampleDepth: 4, alternateGreetings: [],
    postHistoryInstructions: null, creatorNotes: null, depthPrompt: null,
    depthPromptDepth: null, depthPromptRole: null, tags: [], avatarAssetId: null,
    avatarFullAssetId: null, avatarCropJson: null, personalitySummary: null,
    includeGalleryInPrompt: false, includeAvatarInPrompt: false,
    avatarDescription: null, updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeAssistantMessage(id: string, content = `msg ${id}`): AppMessage {
  return {
    id, role: "assistant", content,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    variants: [], selectedVariantIndex: null, modelId: null,
  } as unknown as AppMessage;
}

/** Assistant message with 3 variants — sentinel counter is "1/3". */
function makeMultiVariantMessage(id: string): AppMessage {
  return {
    id, role: "assistant",
    content: "variant-0",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    variants: [
      { variantIndex: 0, content: "variant-0", reasoning: null, reasoningDurationMs: null, isSelected: true },
      { variantIndex: 1, content: "variant-1", reasoning: null, reasoningDurationMs: null, isSelected: false },
      { variantIndex: 2, content: "variant-2", reasoning: null, reasoningDurationMs: null, isSelected: false },
    ],
    selectedVariantIndex: 0, modelId: null,
  } as unknown as AppMessage;
}

function seed(messages: AppMessage[]): AppSnapshot {
  return {
    chats: [{ id: "chat-1", title: "Chat 1", characterId: "c1", characterName: "Char c1", subtitle: "", activeBranchLabel: "main", messageCount: messages.length, updatedAt: "2026-01-01T00:00:00.000Z" }],
    allCharacters: [],
    activeChat: { id: "chat-1", title: "Chat 1", characterId: "c1" } as unknown as AppSnapshot["activeChat"],
    activeBranch: { id: "b1", chatId: "chat-1", label: "main" } as unknown as AppSnapshot["activeBranch"],
    branches: [],
    messages,
    summaries: [],
    promptTrace: null, promptTraceHistory: [], contextPreview: null,
    character: makeCharacter("c1"),
    persona: { id: "p1", name: "Persona", avatarExt: null, description: "", avatarAssetId: null, avatarCropJson: null } as unknown as AppPersona,
  } as unknown as AppSnapshot;
}

const CHAT = "chat-1";

beforeEach(async () => {
  const { snapshotStore, chatStore } = await loadModules();
  snapshotStore.useSnapshotStore.getState().clear();
  chatStore.useChatStore.setState({
    activeChatId: null, selectedCharacterId: null, draft: "", editingMessageId: null,
    editingDraft: "", messageActionId: null, selectedTraceId: null,
    generations: {}, draftAttachments: [],
  });
});

describe("Mobile variant carousel — gated to last message (desktop parity)", () => {
  test("NON-LAST multi-variant assistant message: carousel must NOT render", async () => {
    const { MessageBlock, snapshotStore, chatStore } = await loadModules();
    // m1 = a prior assistant message, m2 = multi-variant non-last assistant message,
    // m3 = a trailing user message so m2 is provably not the last message.
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(
      seed([makeAssistantMessage("m1"), makeMultiVariantMessage("m2"), makeAssistantMessage("m3")]),
    );
    chatStore.useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <MessageBlock messageId="m2" index={1} isFirstAssistant={false} isLast={false} prevRole="assistant" />,
    );
    await act(async () => { await Promise.resolve(); });

    // The mobile variant counter "1/3" is the sentinel that VariantControls rendered.
    // It must be ABSENT for non-last messages — otherwise tapping the arrows on an
    // old message silently rewrites its active variant.
    expect(container.textContent).not.toContain("1/3");
  });

  test("LAST multi-variant assistant message: carousel IS rendered", async () => {
    const { MessageBlock, snapshotStore, chatStore } = await loadModules();
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(
      seed([makeAssistantMessage("m1"), makeMultiVariantMessage("m2")]),
    );
    chatStore.useChatStore.getState().setActiveChatId(asChatId(CHAT));

    const { container } = render(
      <MessageBlock messageId="m2" index={1} isFirstAssistant={false} isLast={true} prevRole="assistant" />,
    );
    await act(async () => { await Promise.resolve(); });

    // Positive control: the counter proves the carousel renders for the last message.
    expect(container.textContent).toContain("1/3");
  });
});
