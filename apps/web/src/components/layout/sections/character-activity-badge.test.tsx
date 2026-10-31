/** L1: (1) imports only, no disk paths; (2) real stores restored beforeEach/afterAll,
 * localStorage restored too, no global patches; (3) synchronous act, no waits; (4) no OS assumptions;
 * (5) real components/stores, existing i18n seam only; (6) settled lifecycle state;
 * (7) no DB, builds, network, or filesystem setup. */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { brandId, type ChatId, type CharacterId } from "@vibe-tavern/domain";
import type { ChatListItem } from "@vibe-tavern/api-contracts";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";

useDomEnv({ failOnNetwork: true });
installI18nContextSeam();
const { render, act } = await import("@testing-library/react");
const { CharacterActivityBadge } = await import("./character-activity-badge.js");
const { TooltipProvider } = await import("../../shared/Tooltip.js");
const { useChatRunActivityStore, CHAT_READY_STORAGE_KEY } = await import("../../../stores/chat-run-activity-store.js");
const { useSnapshotStore } = await import("../../../stores/snapshot-store.js");
const originalActivity = useChatRunActivityStore.getState();
const originalSnapshot = useSnapshotStore.getState();
const originalReadyStorage = localStorage.getItem(CHAT_READY_STORAGE_KEY);

function restore() {
  if (originalReadyStorage === null) localStorage.removeItem(CHAT_READY_STORAGE_KEY);
  else localStorage.setItem(CHAT_READY_STORAGE_KEY, originalReadyStorage);
  useChatRunActivityStore.setState(originalActivity, true);
  useSnapshotStore.setState(originalSnapshot, true);
}
beforeEach(restore);
afterAll(restore);

function chat(id: string, characterId: string, mode: "rp" | "coauthor" = "rp"): ChatListItem {
  return { id: brandId<ChatId>(id), characterId: brandId<CharacterId>(characterId), mode, title: id,
    characterName: characterId, subtitle: "", activeBranchLabel: "", messageCount: 0, lastMessageAt: "", updatedAt: "" };
}

test("an avatar badge follows its character's chat lifecycle without visible text or a title overlay", () => {
  const chats = [chat("one", "aria"), chat("other", "bram")];
  useSnapshotStore.setState({ activeChat: null, chatsById: Object.fromEntries(chats.map((item) => [item.id, item])) });
  const view = render(<TooltipProvider><span className="relative h-8 w-8"><CharacterActivityBadge characterId="aria" /></span></TooltipProvider>);
  expect(view.queryByRole("status")).toBeNull();
  act(() => useChatRunActivityStore.getState().setRunning("other", true));
  expect(view.queryByRole("status")).toBeNull();
  act(() => useChatRunActivityStore.getState().setRunning("one", true));
  const badge = view.getByRole("status");
  expect(badge.getAttribute("aria-label")).toBe("chat_writing_badge");
  expect(badge.textContent).toBe("");
  expect(badge.classList.contains("absolute")).toBe(true);
  expect(badge.classList.contains("-bottom-0.5")).toBe(true);
  expect(badge.classList.contains("-right-[3px]")).toBe(true);
  expect(badge.classList.contains("bg-s3")).toBe(true);
  expect(badge.querySelector("[aria-hidden=true] svg")).not.toBeNull();
  act(() => useChatRunActivityStore.getState().setRunning("one", false));
  expect(view.queryByRole("status")).toBeNull();
});

test("character aggregation includes every chat, stays mode-scoped, and survives one of two runs finishing", () => {
  const chats = [chat("one", "aria"), chat("two", "aria"), chat("draft", "aria", "coauthor"), chat("other", "bram")];
  useSnapshotStore.setState({ activeChat: null, chatsById: Object.fromEntries(chats.map((item) => [item.id, item])) });
  const view = render(<TooltipProvider><CharacterActivityBadge characterId="aria" /></TooltipProvider>);
  act(() => {
    useChatRunActivityStore.getState().setRunning("draft", true);
    useChatRunActivityStore.getState().setRunning("other", true);
  });
  expect(view.queryByRole("status")).toBeNull();
  act(() => {
    useChatRunActivityStore.getState().setRunning("one", true);
    useChatRunActivityStore.getState().setRunning("two", true);
  });
  expect(view.getAllByRole("status")).toHaveLength(1);
  act(() => useChatRunActivityStore.getState().setRunning("one", false));
  expect(view.getByRole("status")).toBeTruthy();
  act(() => useChatRunActivityStore.getState().setRunning("two", false));
  expect(view.queryByRole("status")).toBeNull();
  // A mode change uses the same chat-list source, not the character tab's first chat.
  act(() => useSnapshotStore.setState({ activeChat: { ...originalSnapshot.activeChat, id: "draft", mode: "coauthor" } as typeof originalSnapshot.activeChat }));
  expect(view.getByRole("status")).toBeTruthy();
});

test("ready uses a static check, and a character's other writing chat has priority until it finishes", () => {
  const chats = [chat("one", "aria"), chat("two", "aria"), chat("other", "bram")];
  useSnapshotStore.setState({ activeChat: null, chatsById: Object.fromEntries(chats.map((item) => [item.id, item])) });
  useChatRunActivityStore.getState().markReady("one");
  useChatRunActivityStore.getState().markReady("other");
  const view = render(<TooltipProvider><CharacterActivityBadge characterId="aria" /></TooltipProvider>);
  const badge = view.getByRole("status");
  expect(badge.getAttribute("aria-label")).toBe("chat_ready_badge");
  expect(badge.classList.contains("bg-success")).toBe(true);
  expect(badge.classList.contains("text-white")).toBe(true);
  expect(badge.classList.contains("border-surface")).toBe(true);
  expect(badge.querySelector("svg")).not.toBeNull();
  expect(badge.querySelector(".chat-writing-pencil")).toBeNull();
  act(() => useChatRunActivityStore.getState().setRunning("two", true));
  expect(view.getByRole("status").getAttribute("aria-label")).toBe("chat_writing_badge");
  act(() => useChatRunActivityStore.getState().setRunning("two", false));
  expect(view.getByRole("status").getAttribute("aria-label")).toBe("chat_ready_badge");
  act(() => useChatRunActivityStore.getState().markRead("one"));
  expect(view.queryByRole("status")).toBeNull();
});
