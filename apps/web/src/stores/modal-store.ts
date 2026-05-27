import { create } from "zustand";

export interface ModalState {
  isProviderModalOpen: boolean;
  isPromptManagerOpen: boolean;
  isPersonaModalOpen: boolean;
  isCreateCharacterModalOpen: boolean;
  isContextMemoryOpen: boolean;
  tweaksOpen: boolean;
  avatarOpen: boolean;
  mobileAccessOpen: boolean;
}

export interface ModalActions {
  setIsProviderModalOpen: (open: boolean) => void;
  setIsPromptManagerOpen: (open: boolean) => void;
  setIsPersonaModalOpen: (open: boolean) => void;
  setCreateCharacterModalOpen: (open: boolean) => void;
  setContextMemoryOpen: (open: boolean) => void;
  setTweaksOpen: (open: boolean) => void;
  setAvatarOpen: (open: boolean) => void;
  setMobileAccessOpen: (open: boolean) => void;
}

export type ModalStore = ModalState & ModalActions;

export const useModalStore = create<ModalStore>()((set) => ({
  isProviderModalOpen: false,
  isPromptManagerOpen: false,
  isPersonaModalOpen: false,
  isCreateCharacterModalOpen: false,
  isContextMemoryOpen: false,
  tweaksOpen: false,
  avatarOpen: false,
  mobileAccessOpen: false,

  setIsProviderModalOpen: (open) => set({ isProviderModalOpen: open }),
  setIsPromptManagerOpen: (open) => set({ isPromptManagerOpen: open }),
  setIsPersonaModalOpen: (open) => set({ isPersonaModalOpen: open }),
  setCreateCharacterModalOpen: (open) => set({ isCreateCharacterModalOpen: open }),
  setContextMemoryOpen: (open) => set({ isContextMemoryOpen: open }),
  setTweaksOpen: (open) => set({ tweaksOpen: open }),
  setAvatarOpen: (open) => set({ avatarOpen: open }),
  setMobileAccessOpen: (open) => set({ mobileAccessOpen: open }),
}));

if (typeof window !== "undefined") (window as any).__useModalStore = useModalStore;
