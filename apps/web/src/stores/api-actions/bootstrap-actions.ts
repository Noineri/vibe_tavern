import { bootstrapApp, listPersonas } from "../../app-client.js";
import type { AppSnapshot, PersonaRecord } from "../../app-client.js";
import type { ChatId, PromptPresetDto } from "@rp-platform/domain";
import { useChatStore } from "../chat-store.js";
import { useChatDataStore } from "../chat-data-store.js";
import { create } from "zustand";

export interface BootstrapData {
  initialChatId: ChatId | null;
  snapshot: AppSnapshot | null;
  isFirstRun: boolean;
  allCharacters: Array<{ id: string; name: string; subtitle: string; avatarAssetId: string | null }>;
  promptPresets: PromptPresetDto[];
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

export async function fetchBootstrapAction(): Promise<void> {
  useBootstrapStore.setState({ isLoading: true });
  try {
    const boot = await bootstrapApp();
    
    // Update the bootstrap store with the new data
    useBootstrapStore.setState({ data: boot });

    // Sync snapshot if present
    if (boot.initialChatId && boot.snapshot) {
      useChatDataStore.getState().setSnapshot(boot.snapshot);
    }
    
    // Assuming useChatStore is used to set the active chat ID during bootstrap
    if (boot.initialChatId && !useChatStore.getState().activeChatId) {
      useChatStore.getState().setActiveChatId(boot.initialChatId);
    }
  } finally {
    useBootstrapStore.setState({ isLoading: false });
  }
}

export async function fetchPersonasAction(): Promise<void> {
  const personas = await listPersonas();
  useBootstrapStore.setState({ personas });
}
