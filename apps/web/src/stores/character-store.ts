import { create } from "zustand";
import type { ReactNode } from "react";
import type { ChatId } from "@rp-platform/domain";
import type { BuildTab } from "../components/BuildMode.js";

export interface ConfirmDestroyDialog {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
}

export interface CharacterState {
  buildTab: BuildTab;
  isImportDragActive: boolean;
  importNotice: string;
  confirmDestroy: ConfirmDestroyDialog | null;
  renamingChatId: ChatId | null;
  renameDraft: string;
  isSavingCharacter: boolean;
  characterSaveNotice: string;
}

export interface CharacterActions {
  setBuildTab: (tab: BuildTab) => void;
  setIsImportDragActive: (active: boolean) => void;
  setImportNotice: (notice: string) => void;
  setConfirmDestroy: (dialog: ConfirmDestroyDialog | null) => void;
  setRenamingChatId: (id: ChatId | null) => void;
  setRenameDraft: (draft: string) => void;
  setIsSavingCharacter: (saving: boolean) => void;
  setCharacterSaveNotice: (notice: string) => void;
}

export type CharacterStore = CharacterState & CharacterActions;

export const useCharacterStore = create<CharacterStore>()((set) => ({
  buildTab: "character",
  isImportDragActive: false,
  importNotice: "",
  confirmDestroy: null,
  renamingChatId: null,
  renameDraft: "",
  isSavingCharacter: false,
  characterSaveNotice: "",

  setBuildTab: (tab) => set({ buildTab: tab }),
  setIsImportDragActive: (active) => set({ isImportDragActive: active }),
  setImportNotice: (notice) => set({ importNotice: notice }),
  setConfirmDestroy: (dialog) => set({ confirmDestroy: dialog }),
  setRenamingChatId: (id) => set({ renamingChatId: id }),
  setRenameDraft: (draft) => set({ renameDraft: draft }),
  setIsSavingCharacter: (saving) => set({ isSavingCharacter: saving }),
  setCharacterSaveNotice: (notice) => set({ characterSaveNotice: notice }),
}));
