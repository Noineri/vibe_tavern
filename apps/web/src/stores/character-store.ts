import { create } from "zustand";
import type { ReactNode } from "react";
import type { ChatId } from "@vibe-tavern/domain";
import type { BuildTab } from "../components/build/BuildMode.js";

export interface ConfirmDestroyDialog {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
}

export interface CharacterState {
  buildTab: BuildTab;
  isImportDragActive: boolean;
  confirmDestroy: ConfirmDestroyDialog | null;
  renamingChatId: ChatId | null;
  renameDraft: string;
  isSavingCharacter: boolean;
}

export interface CharacterActions {
  setBuildTab: (tab: BuildTab) => void;
  setIsImportDragActive: (active: boolean) => void;
  setConfirmDestroy: (dialog: ConfirmDestroyDialog | null) => void;
  setRenamingChatId: (id: ChatId | null) => void;
  setRenameDraft: (draft: string) => void;
  setIsSavingCharacter: (saving: boolean) => void;
}

export type CharacterStore = CharacterState & CharacterActions;

export const useCharacterStore = create<CharacterStore>()((set) => ({
  buildTab: "character",
  isImportDragActive: false,
  confirmDestroy: null,
  renamingChatId: null,
  renameDraft: "",
  isSavingCharacter: false,

  setBuildTab: (tab) => set({ buildTab: tab }),
  setIsImportDragActive: (active) => set({ isImportDragActive: active }),
  setConfirmDestroy: (dialog) => set({ confirmDestroy: dialog }),
  setRenamingChatId: (id) => set({ renamingChatId: id }),
  setRenameDraft: (draft) => set({ renameDraft: draft }),
  setIsSavingCharacter: (saving) => set({ isSavingCharacter: saving }),
}));

if (typeof window !== "undefined") window.__useCharacterStore = useCharacterStore;
