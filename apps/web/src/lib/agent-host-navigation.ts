import { brandId, type AgentThreadOwner, type ChatId, type ChatBranchId } from "@vibe-tavern/domain";
import { useBuildNavigationStore } from "../stores/build-navigation-store.js";
import { useCharacterStore } from "../stores/character-store.js";
import { useNavigationStore } from "../stores/navigation-store.js";
import { useChatStore } from "../stores/chat-store.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";
import { useSidechatOpenStore } from "../stores/sidechat-open-store.js";
import { useSidechatMobileStore } from "../stores/sidechat-mobile-store.js";
import { switchChatAction, switchModeAction, activateBranchAction } from "../stores/api-actions/chat-actions.js";
import { coauthorReviews } from "./coauthor-draft.js";

/** Use the existing Build intent path, not a second editor or direct DOM jump.
 * Both buffer editors already show their assistant whenever an entity opens. */
export async function openBuildAgent(kind: "experience" | "script", owner: AgentThreadOwner): Promise<void> {
  if (owner.kind !== "script") throw new Error("A buffer assistant requires a script owner");
  await switchModeAction("build");
  useBuildNavigationStore.getState().requestAgentOpen(kind, owner.scriptId);
  useCharacterStore.getState().setBuildTab(kind === "experience" ? "experience" : "lorebook");
}

export async function openSidechatAgent(owner: AgentThreadOwner): Promise<void> {
  if (owner.kind !== "chat") throw new Error("A sidechat assistant requires a chat owner");
  const chatId = brandId<ChatId>(owner.chatId);
  if (useChatStore.getState().activeChatId !== chatId) {
    await switchChatAction(chatId);
    useChatStore.getState().setActiveChatId(chatId);
  }
  if (useSnapshotStore.getState().activeBranch?.id !== owner.branchId) {
    await activateBranchAction(chatId, brandId<ChatBranchId>(owner.branchId));
  }
  useNavigationStore.getState().setMode("play");
  useSidechatOpenStore.getState().setOpen(owner.chatId, true);
  useSidechatMobileStore.getState().setTab("sidechat");
}

/** Co-Author runs are chat-owned, not copilot threads. Reuse the existing chat
 * switch path so the character selection and canonical shell follow its chat. */
export async function openCoauthorChat(id: string): Promise<void> {
  const chatId = brandId<ChatId>(id);
  await switchChatAction(chatId);
  const chat = useSnapshotStore.getState().activeChat;
  if (chat?.id !== chatId || chat.mode !== "coauthor") throw new Error("Co-Author chat no longer exists");
  useChatStore.getState().setActiveChatId(chatId);
  useNavigationStore.getState().setMode("play");
  await coauthorReviews.hydrate(chatId);
}
