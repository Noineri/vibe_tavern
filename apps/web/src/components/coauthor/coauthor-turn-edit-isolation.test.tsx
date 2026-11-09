import { beforeEach, describe, expect, mock, test } from "bun:test";
import { brandId, type CharacterId } from "@vibe-tavern/domain";
import { wireBranch, wireChat, wireChatListItem, wireCharacter, wireMessage } from "../../../test/wire-fixtures.js";
import { useDomEnv } from "../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";
import { installFramerMotionSeam } from "../../../test/framer-motion-seam.js";
import { Profiler, type ProfilerOnRenderCallback } from "react";

/**
 * Per-part edit isolation invariant for CoauthorTurnShell (LAG-1, step 2 of
 * AGENT_SHELL_RENDER_LAG_REPORT — the co-author twin of the MessageBlock pin
 * in message-block-isolation.test.tsx).
 *
 * WHAT THIS PROVES
 *   Typing into one co-author turn part's edit field (`setEditingDraft`) must
 *   NOT re-render the SIBLING parts of the turn. Before LAG-1 every
 *   CoauthorTurnPart subscribed to the whole `editingDraft`, so each
 *   keystroke re-rendered every mounted part of every visible turn.
 *
 * HOW IT PROVES IT
 *   The real CoauthorTurnShell is mounted (real stores, real subscription
 *   graph — not the fixture-store stubs of CoauthorTurnShell.test.tsx, which
 *   cannot observe store-driven re-renders). Heavy out-of-graph dependencies
 *   are mocked at the module boundary (useChatController, i18n, framer-motion,
 *   Tooltip); the per-part render counter is a counting stub of
 *   CoauthorToolActivitySlot — the component every NON-editing part renders
 *   exactly once per commit, so its call count per messageId IS that part's
 *   render count (R12 discipline: count the target's own renders, not
 *   Profiler subtree commits).
 *
 * POSITIVE CONTROL
 *   The edited part's textarea is asserted after EVERY keystroke — a
 *   controlled value only moves when the edited part re-renders, so the
 *   sibling's 0 is never vacuous (the store graph is alive and observed).
 */
useDomEnv();
const { act, render } = await import("@testing-library/react");

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
const realChatActions = await import("../../stores/api-actions/chat-actions.js");
const realTooltip = await import("../shared/Tooltip.js");

mock.module("../../hooks/use-chat-controller.js", () => ({
  ...realChatController,
  useChatController: () => STABLE_CONTROLLER,
}));

// Scene status hydration must stay hermetic (same spread discipline as
// message-block-isolation.test.tsx — only the 5 Scene funcs are stubbed).
mock.module("../../stores/api-actions/chat-actions.js", () => ({
  ...realChatActions,
  getSceneStatusAction: () => Promise.resolve({ generating: false, record: null }),
  generateSceneAction: () => Promise.resolve({}),
  editSceneAction: () => Promise.resolve({}),
  deleteSceneAction: () => Promise.resolve({}),
  cancelSceneAction: () => Promise.resolve(),
  previewSceneAction: () => Promise.resolve({}),
}));

mock.module("../shared/Tooltip.js", () => ({
  ...realTooltip,
  CustomTooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// House i18n pattern via the shared co-load seam: raw keys render as-is.
installI18nContextSeam();
// House animation mock via the shared co-load seam (MessageShell mounts motion).
installFramerMotionSeam();

// Per-part render counter: every NON-editing CoauthorTurnPart renders exactly
// one CoauthorToolActivitySlot per commit, so calls keyed by messageId count
// that part's renders. Load-time copy of the real namespace (R15).
const toolSlotRenders: Record<string, number> = {};
const realToolSlot = { ...(await import("../chat/CoauthorToolActivitySlot.js")) };
mock.module("../chat/CoauthorToolActivitySlot.js", () => ({
  ...realToolSlot,
  CoauthorToolActivitySlot: ({ messageId }: { chatId: string; messageId: string; isStreaming: boolean }) => {
    toolSlotRenders[messageId] = (toolSlotRenders[messageId] ?? 0) + 1;
    return null;
  },
}));

// Dynamic import AFTER mocks are registered.
const ShellModule = import("./CoauthorTurnShell.js");
const SnapshotStoreModule = import("../../stores/snapshot-store.js");
const ChatStoreModule = import("../../stores/chat-store.js");

async function loadModules() {
  const [{ CoauthorTurnShell }, snapshotStore, chatStore] = await Promise.all([
    ShellModule as Promise<{ CoauthorTurnShell: React.ComponentType<{ turnId: string; index: number; isLastTurn: boolean }> }>,
    SnapshotStoreModule as Promise<typeof import("../../stores/snapshot-store.js")>,
    ChatStoreModule as Promise<typeof import("../../stores/chat-store.js")>,
  ]);
  return { CoauthorTurnShell, snapshotStore, chatStore };
}

import type { AppCharacter, AppMessage, AppSnapshot } from "../../api/types.js";
import type { ChatId } from "@vibe-tavern/domain";

const asChatId = (id: string): ChatId => id as ChatId;

const CHAT = "chat-1";

function makeCharacter(): AppCharacter {
  return {
    ...wireCharacter(),
    id: "c1", name: "Char c1", avatarExt: null, avatarFullExt: null, description: "", scenario: "",
    systemPrompt: "", subtitle: "", firstMessage: null, mesExample: null,
    mesExampleMode: "always", mesExampleDepth: 4, alternateGreetings: [],
    postHistoryInstructions: null, creatorNotes: null, depthPrompt: null,
    depthPromptDepth: null, depthPromptRole: null, tags: [], avatarAssetId: null,
    avatarFullAssetId: null, avatarCropJson: null, personalitySummary: null,
    includeGalleryInPrompt: false, includeAvatarInPrompt: false,
    avatarDescription: null, updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeMessage(id: string, role: "user" | "assistant", content: string): AppMessage {
  return wireMessage(id, { role, authorType: role, content });
}

/** One co-author turn: user anchor u1 + two assistant parts (a1, a2). */
function makeTurnSnapshot(): AppSnapshot {
  return {
    chats: [wireChatListItem({ id: brandId<ChatId>(CHAT), title: "Chat 1", characterId: brandId<CharacterId>("c1"), characterName: "Char c1", mode: "coauthor", messageCount: 3 })],
    allCharacters: [],
    activeChat: wireChat({ id: brandId<ChatId>(CHAT), title: "Chat 1", characterId: brandId<CharacterId>("c1") }),
    activeBranch: wireBranch(),
    branches: [],
    messages: [
      makeMessage("u1", "user", "Write the scene"),
      makeMessage("a1", "assistant", "part one"),
      makeMessage("a2", "assistant", "part two"),
    ],
    summaries: [],
    promptTrace: null,
    character: makeCharacter(),
    persona: null,
  };
}

beforeEach(async () => {
  const { snapshotStore, chatStore } = await loadModules();
  snapshotStore.useSnapshotStore.getState().clear();
  chatStore.useChatStore.setState({
    activeChatId: null, selectedCharacterId: null, draft: "", editingMessageId: null,
    editingDraft: "", messageActionId: null, selectedTraceId: null,
    generations: {}, draftAttachments: [],
  });
  for (const key of Object.keys(toolSlotRenders)) delete toolSlotRenders[key];
});

describe("CoauthorTurnShell — per-part edit isolation (LAG-1)", () => {
  test("typing into a2's edit field does NOT re-render sibling a1; a2 shows every keystroke", async () => {
    const { CoauthorTurnShell, snapshotStore, chatStore } = await loadModules();
    snapshotStore.useSnapshotStore.getState().ingestSnapshot(makeTurnSnapshot());
    chatStore.useChatStore.getState().setActiveChatId(asChatId(CHAT));

    let shellCommits = 0;
    const onRender: ProfilerOnRenderCallback = () => { shellCommits++; };
    const utils = render(
      <Profiler id="turn" onRender={onRender}>
        <CoauthorTurnShell turnId="u1" index={0} isLastTurn />
      </Profiler>,
    );
    await act(async () => { await Promise.resolve(); });
    expect(shellCommits).toBe(1); // mount
    expect(toolSlotRenders["a1"]).toBe(1); // both parts mounted, each rendered once
    expect(toolSlotRenders["a2"]).toBe(1);

    // Enter edit mode on a2 (the editingMessageId flip is the enter-edit
    // TRANSITION — legitimately re-renders; not a keystroke). Reset after.
    act(() => { chatStore.useChatStore.getState().setEditingMessageId("a2"); });
    await act(async () => { await Promise.resolve(); });
    const textarea = utils.container.querySelector("textarea");
    expect(textarea).not.toBeNull(); // a2's edit field mounted
    expect(textarea!.value).toBe(""); // controlled by the store draft (empty)
    delete toolSlotRenders["a1"];
    delete toolSlotRenders["a2"]; // a2 re-renders into the edit branch
    shellCommits = 0;

    // Keystrokes into a2's edit field.
    act(() => { chatStore.useChatStore.getState().setEditingDraft("k"); });
    await act(async () => { await Promise.resolve(); });
    expect(utils.container.querySelector("textarea")!.value).toBe("k");
    act(() => { chatStore.useChatStore.getState().setEditingDraft("ke"); });
    await act(async () => { await Promise.resolve(); });
    expect(utils.container.querySelector("textarea")!.value).toBe("ke");
    act(() => { chatStore.useChatStore.getState().setEditingDraft("keys"); });
    await act(async () => { await Promise.resolve(); });
    expect(utils.container.querySelector("textarea")!.value).toBe("keys");

    // a2's controlled value moved per keystroke — the graph is alive and the
    // edited part rendered (its value updates only on its own commits).
    // a1 must have stayed at ZERO renders across all three keystrokes.
    expect(toolSlotRenders["a1"] ?? 0).toBe(0);
    utils.unmount();
  });
});
