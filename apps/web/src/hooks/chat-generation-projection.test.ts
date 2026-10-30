import { afterAll, beforeEach, expect, test } from "bun:test";
import { brandId, type ChatBranchId, type ChatId } from "@vibe-tavern/domain";
import type { ChatGenerationOperation } from "@vibe-tavern/api-contracts";
import type { AppSnapshot } from "../api/types.js";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();
const { act, renderHook } = await import("@testing-library/react");
const { useChatStore, useActiveGeneration, useIsSending } = await import("../stores/chat-store.js");
const { useSnapshotStore } = await import("../stores/snapshot-store.js");
const { useIsStreamingTarget, useStreamingRevealedFor } = await import("../stores/chat-selectors.js");
const { useDisplayMessageIds } = await import("../components/chat/MessageScroller.js");
const { useCoauthorTurnIds } = await import("../components/coauthor/useCoauthorTurnIds.js");
const originalChat = useChatStore.getState(), originalSnapshot = useSnapshotStore.getState();
beforeEach(() => { useChatStore.setState(originalChat, true); useSnapshotStore.setState(originalSnapshot, true); });
afterAll(() => { useChatStore.setState(originalChat, true); useSnapshotStore.setState(originalSnapshot, true); });

const chatId = brandId<ChatId>("projection-chat");
const branchA = brandId<ChatBranchId>("branch-a"), branchB = brandId<ChatBranchId>("branch-b");
function seed(mode: "rp" | "coauthor", ending: "user" | "assistant" = "assistant") {
  useSnapshotStore.getState().clear();
  useSnapshotStore.getState().ingestSnapshot({ activeChat: { id: chatId, mode }, activeBranch: { id: branchA, chatId }, messages: [
    { id: "user", chatId, branchId: branchA, role: "user", content: "Request", variants: [] },
    ...(ending === "assistant" ? [{ id: "assistant", chatId, branchId: branchA, role: "assistant", content: "Old reply", variants: [] }] : []),
  ] } as unknown as AppSnapshot);
  useChatStore.setState({ activeChatId: chatId, generations: {} });
}
function probe() {
  return { rp: useDisplayMessageIds(), coauthor: useCoauthorTurnIds(), gen: useActiveGeneration(),
    target: useIsStreamingTarget("assistant"), text: useStreamingRevealedFor("assistant"), busy: useIsSending() };
}

for (const mode of ["rp", "coauthor"] as const) for (const operation of [
  { operation: "send", messageId: null }, { operation: "generate", messageId: null },
  { operation: "regenerate", messageId: "assistant" }, { operation: "continue", messageId: "assistant" },
] satisfies ChatGenerationOperation[]) {
  test(`${mode} ${operation.operation}: only the originating branch displays the pending reply or exact target`, async () => {
    seed(mode);
    const store = useChatStore.getState();
    store.startGeneration(chatId);
    store.setGenerationContext(chatId, { ...operation, runId: "run", chatId, branchId: branchA });
    store.setStreamingRevealed(chatId, "Partial reply");
    const hook = renderHook(probe);
    try {
      const fresh = operation.messageId === null;
      expect(hook.result.current.rp).toEqual(["user", "assistant", ...(fresh ? ["__pending-assistant"] : [])]);
      expect(hook.result.current.coauthor).toEqual(hook.result.current.rp);
      expect(hook.result.current.target).toBe(!fresh);
      expect(hook.result.current.gen?.context?.branchId).toBe(branchA);
      await act(async () => { useSnapshotStore.setState({ activeBranch: { id: branchB, chatId } as NonNullable<AppSnapshot["activeBranch"]> }); });
      expect(hook.result.current.rp).toEqual(["user", "assistant"]);
      expect(hook.result.current.coauthor).toEqual(["user", "assistant"]);
      expect(hook.result.current.target).toBe(false);
      expect(hook.result.current.text.revealedText).toBe("");
      expect(hook.result.current.gen).toBeNull();
      expect(hook.result.current.busy).toBe(true);
      await act(async () => { useSnapshotStore.setState({ activeBranch: { id: branchA, chatId } as NonNullable<AppSnapshot["activeBranch"]> }); });
      expect(hook.result.current.gen?.streamingRevealedText).toBe("Partial reply");
      expect(hook.result.current.target).toBe(!fresh);
    } finally { hook.unmount(); }
  });
}

test("a live send captures its branch before the server context and hides both optimistic rows elsewhere", async () => {
  seed("rp", "user");
  useChatStore.getState().startGeneration(chatId, "Uncommitted next request");
  const hook = renderHook(probe);
  try {
    expect(hook.result.current.rp).toEqual(["user", "__pending-user", "__pending-assistant"]);
    await act(async () => { useSnapshotStore.setState({ activeBranch: { id: branchB, chatId } as NonNullable<AppSnapshot["activeBranch"]> }); });
    expect(hook.result.current.rp).toEqual(["user"]);
    expect(hook.result.current.coauthor).toEqual(["user"]);
    expect(hook.result.current.busy).toBe(true);
  } finally { hook.unmount(); }
});

test("a replayed committed user is not duplicated and an attachment-only pending send remains a real turn", () => {
  seed("coauthor", "user");
  useChatStore.getState().startGeneration(chatId, "");
  const hook = renderHook(probe);
  try {
    expect(hook.result.current.rp).toEqual(["user", "__pending-user", "__pending-assistant"]);
    expect(hook.result.current.coauthor).toEqual(hook.result.current.rp);
  } finally { hook.unmount(); }
  useChatStore.getState().finishGeneration(chatId);
  useChatStore.getState().startGeneration(chatId);
  useChatStore.getState().setGenerationContext(chatId, { operation: "send", messageId: null, runId: "run", chatId, branchId: branchA });
  const replay = renderHook(probe);
  try {
    expect(replay.result.current.rp).toEqual(["user", "__pending-assistant"]);
    expect(replay.result.current.coauthor).toEqual(replay.result.current.rp);
  } finally { replay.unmount(); }
});
