import { create } from "zustand";

export interface ModalState {
  isProviderModalOpen: boolean;
  isCoauthorProviderModalOpen: boolean;
  /** Origin is set only by the atomic Co-Author → connections transition. */
  providerModalOrigin: "coauthor" | null;
  coauthorResumeProfileId: string | null;
  isPromptManagerOpen: boolean;
  isPersonaModalOpen: boolean;
  isCreateCharacterModalOpen: boolean;
  isContextMemoryOpen: boolean;
  isCoauthorModuleModalOpen: boolean;
  isCoauthorSkillModalOpen: boolean;
  tweaksOpen: boolean;
  avatarOpen: boolean;
  mobileAccessOpen: boolean;
  isProxyManagerOpen: boolean;
  isUpdateModalOpen: boolean;
}

export interface ModalActions {
  setIsProviderModalOpen: (open: boolean) => void;
  setCoauthorProviderModalOpen: (open: boolean) => void;
  openProviderModalFromCoauthor: () => void;
  returnToCoauthorProviderModal: (profileId?: string | null) => void;
  closeProviderModalOrigin: () => void;
  consumeCoauthorResumeProfileId: () => string | null;
  setIsPromptManagerOpen: (open: boolean) => void;
  setIsPersonaModalOpen: (open: boolean) => void;
  setCreateCharacterModalOpen: (open: boolean) => void;
  setContextMemoryOpen: (open: boolean) => void;
  setCoauthorModuleModalOpen: (open: boolean) => void;
  setCoauthorSkillModalOpen: (open: boolean) => void;
  setTweaksOpen: (open: boolean) => void;
  setAvatarOpen: (open: boolean) => void;
  setMobileAccessOpen: (open: boolean) => void;
  setIsProxyManagerOpen: (open: boolean) => void;
  setUpdateModalOpen: (open: boolean) => void;
}

export type ModalStore = ModalState & ModalActions;

export const useModalStore = create<ModalStore>()((set, get) => ({
  isProviderModalOpen: false,
  isCoauthorProviderModalOpen: false,
  providerModalOrigin: null,
  coauthorResumeProfileId: null,
  isPromptManagerOpen: false,
  isPersonaModalOpen: false,
  isCreateCharacterModalOpen: false,
  isContextMemoryOpen: false,
  isCoauthorModuleModalOpen: false,
  isCoauthorSkillModalOpen: false,
  tweaksOpen: false,
  avatarOpen: false,
  mobileAccessOpen: false,
  isProxyManagerOpen: false,
  isUpdateModalOpen: false,
  setIsProviderModalOpen: (open) => set(open ? { isProviderModalOpen: true, providerModalOrigin: null } : { isProviderModalOpen: false, providerModalOrigin: null }),
  setCoauthorProviderModalOpen: (open) => set({ isCoauthorProviderModalOpen: open }),
  openProviderModalFromCoauthor: () => set({ isCoauthorProviderModalOpen: false, isProviderModalOpen: true, providerModalOrigin: "coauthor" }),
  returnToCoauthorProviderModal: (profileId = null) => set({ isProviderModalOpen: false, isCoauthorProviderModalOpen: true, providerModalOrigin: null, coauthorResumeProfileId: profileId }),
  closeProviderModalOrigin: () => set({ isProviderModalOpen: false, providerModalOrigin: null, coauthorResumeProfileId: null }),
  consumeCoauthorResumeProfileId: () => {
    const profileId = get().coauthorResumeProfileId;
    set({ coauthorResumeProfileId: null });
    return profileId;
  },
  setIsPromptManagerOpen: (open) => set({ isPromptManagerOpen: open }),
  setIsPersonaModalOpen: (open) => set({ isPersonaModalOpen: open }),
  setCreateCharacterModalOpen: (open) => set({ isCreateCharacterModalOpen: open }),
  setContextMemoryOpen: (open) => set({ isContextMemoryOpen: open }),
  setCoauthorModuleModalOpen: (open) => set({ isCoauthorModuleModalOpen: open }),
  setCoauthorSkillModalOpen: (open) => set({ isCoauthorSkillModalOpen: open }),
  setTweaksOpen: (open) => set({ tweaksOpen: open }),
  setAvatarOpen: (open) => set({ avatarOpen: open }),
  setMobileAccessOpen: (open) => set({ mobileAccessOpen: open }),
  setIsProxyManagerOpen: (open) => set({ isProxyManagerOpen: open }),
  setUpdateModalOpen: (open) => set({ isUpdateModalOpen: open }),
}));

if (typeof window !== "undefined") window.__useModalStore = useModalStore;
