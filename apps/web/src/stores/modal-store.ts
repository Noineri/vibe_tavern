import { create } from "zustand";
import type { SettingsSectionId } from "../lib/settings-section-registry.js";

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
  isUpdateModalOpen: boolean;
  isStarPromptOpen: boolean;
  isSettingsOpen: boolean;
  settingsSection: SettingsSectionId | null;
  /** Repeated deep links are distinct navigation requests, even to the same id. */
  settingsOpenRequest: number;
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
  setUpdateModalOpen: (open: boolean) => void;
  setStarPromptOpen: (open: boolean) => void;
  setIsSettingsOpen: (open: boolean) => void;
  openSettings: (section?: SettingsSectionId) => void;
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
  isUpdateModalOpen: false,
  isStarPromptOpen: false,
  isSettingsOpen: false,
  settingsSection: null,
  settingsOpenRequest: 0,
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
  setUpdateModalOpen: (open) => set({ isUpdateModalOpen: open }),
  setStarPromptOpen: (open) => set({ isStarPromptOpen: open }),
  setIsSettingsOpen: (open) => set({ isSettingsOpen: open, ...(!open ? { settingsSection: null } : {}) }),
  openSettings: (section) => set((state) => ({
    isSettingsOpen: true,
    settingsSection: section ?? null,
    settingsOpenRequest: state.settingsOpenRequest + 1,
    tweaksOpen: false,
  })),
}));

if (typeof window !== "undefined") window.__useModalStore = useModalStore;
