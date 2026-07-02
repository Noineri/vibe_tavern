import { create } from "zustand";

export interface ModalState {
  isProviderModalOpen: boolean;
  /** Which surface opened the provider modal. `"coauthor"` tool-filters the
   *  model list (co-author turns require function-calling, so non-tool models
   *  are hidden — see useToolCapableModels); `"default"` shows all models
   *  (the RP surface). Resets to `"default"` when the modal closes so the RP
   *  opener never inherits a stale coauthor mode. */
  providerModalMode: "default" | "coauthor";
  isPromptManagerOpen: boolean;
  isPersonaModalOpen: boolean;
  isCreateCharacterModalOpen: boolean;
  isContextMemoryOpen: boolean;
  isCoauthorModuleModalOpen: boolean;
  tweaksOpen: boolean;
  avatarOpen: boolean;
  mobileAccessOpen: boolean;
}

export interface ModalActions {
  setIsProviderModalOpen: (open: boolean) => void;
  setProviderModalMode: (mode: "default" | "coauthor") => void;
  setIsPromptManagerOpen: (open: boolean) => void;
  setIsPersonaModalOpen: (open: boolean) => void;
  setCreateCharacterModalOpen: (open: boolean) => void;
  setContextMemoryOpen: (open: boolean) => void;
  setCoauthorModuleModalOpen: (open: boolean) => void;
  setTweaksOpen: (open: boolean) => void;
  setAvatarOpen: (open: boolean) => void;
  setMobileAccessOpen: (open: boolean) => void;
}

export type ModalStore = ModalState & ModalActions;

export const useModalStore = create<ModalStore>()((set) => ({
  isProviderModalOpen: false,
  providerModalMode: "default",
  isPromptManagerOpen: false,
  isPersonaModalOpen: false,
  isCreateCharacterModalOpen: false,
  isContextMemoryOpen: false,
  isCoauthorModuleModalOpen: false,
  tweaksOpen: false,
  avatarOpen: false,
  mobileAccessOpen: false,

  setIsProviderModalOpen: (open) => set({ isProviderModalOpen: open }),
  setProviderModalMode: (mode) => set({ providerModalMode: mode }),
  setIsPromptManagerOpen: (open) => set({ isPromptManagerOpen: open }),
  setIsPersonaModalOpen: (open) => set({ isPersonaModalOpen: open }),
  setCreateCharacterModalOpen: (open) => set({ isCreateCharacterModalOpen: open }),
  setContextMemoryOpen: (open) => set({ isContextMemoryOpen: open }),
  setCoauthorModuleModalOpen: (open) => set({ isCoauthorModuleModalOpen: open }),
  setTweaksOpen: (open) => set({ tweaksOpen: open }),
  setAvatarOpen: (open) => set({ avatarOpen: open }),
  setMobileAccessOpen: (open) => set({ mobileAccessOpen: open }),
}));

if (typeof window !== "undefined") window.__useModalStore = useModalStore;
