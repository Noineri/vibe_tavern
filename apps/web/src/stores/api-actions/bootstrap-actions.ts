import { bootstrapApp, fetchChat, listPersonas } from "../../app-client.js";
import type { AppSnapshot, PersonaRecord, UiSettingsRecord } from "../../app-client.js";
import type { ChatId, PromptPresetDto } from "@vibe-tavern/domain";
import { useChatStore } from "../chat-store.js";
import { useSnapshotStore } from "../snapshot-store.js";
import { create } from "zustand";

export interface BootstrapData {
  initialChatId: ChatId | null;
  snapshot: AppSnapshot | null;
  isFirstRun: boolean;
  allCharacters: Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null }>;
  promptPresets: PromptPresetDto[];
  uiSettings: UiSettingsRecord;
  isArmServer: boolean;
}

export interface BootstrapState {
  data: BootstrapData | null;
  personas: PersonaRecord[] | null;
  isLoading: boolean;
}

export const useBootstrapStore = create<BootstrapState>(() => ({
  data: null,
  personas: null,
  isLoading: false,
}));

export async function syncBootstrapSnapshotForActiveChat(
  boot: Pick<BootstrapData, "initialChatId" | "snapshot">,
  fetchSnapshot: (chatId: ChatId) => Promise<AppSnapshot> = fetchChat,
): Promise<void> {
  if (!boot.initialChatId || !boot.snapshot) return;

  const activeChatId = useChatStore.getState().activeChatId;
  if (!activeChatId || activeChatId === boot.initialChatId) {
    useSnapshotStore.getState().ingestSnapshot(boot.snapshot);
    return;
  }

  try {
    const activeSnapshot = await fetchSnapshot(activeChatId);
    if (
      useChatStore.getState().activeChatId === activeChatId &&
      activeSnapshot.activeChat?.id === activeChatId
    ) {
      useSnapshotStore.getState().ingestSnapshot(activeSnapshot);
    }
  } catch {
    // Leave the existing active snapshot intact; callers that delete or
    // switch chats manage activeChatId explicitly before bootstrapping.
  }
}

export async function fetchBootstrapAction(options?: { silent?: boolean }): Promise<void> {
  if (!options?.silent) useBootstrapStore.setState({ isLoading: true });
  try {
    const boot = await bootstrapApp();
    
    // Update the bootstrap store with the new data
    useBootstrapStore.setState({ data: boot });

    // Sync snapshot if present into the canonical snapshot store.
    // Bootstrap always returns the server's initial chat, but the frontend may
    // already have a different active chat. Never let a silent/global bootstrap
    // overwrite the active snapshot with another chat, or AppShell will briefly
    // see activeChat.id !== activeChatId and render the empty/select state.
    await syncBootstrapSnapshotForActiveChat(boot);
    
    // Assuming useChatStore is used to set the active chat ID during bootstrap
    if (boot.initialChatId && !useChatStore.getState().activeChatId) {
      useChatStore.getState().setActiveChatId(boot.initialChatId);
    }
  } finally {
    if (!options?.silent) useBootstrapStore.setState({ isLoading: false });
  }
}

export async function fetchPersonasAction(): Promise<void> {
  const personas = await listPersonas();
  useBootstrapStore.setState({ personas });
}
