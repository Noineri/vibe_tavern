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

/** Character-editor authoring surface: classic form fields or the Vibe MD
 *  prose document editor. Persists across Build tab switches (stored here,
 *  not in the CharacterForm component state, which unmounts on tab change).
 *  Default "form" so existing behavior is unchanged. */
export type MdViewMode = "form" | "md";

export interface CharacterState {
  buildTab: BuildTab;
  mdViewMode: MdViewMode;
  isImportDragActive: boolean;
  confirmDestroy: ConfirmDestroyDialog | null;
  renamingChatId: ChatId | null;
  renameDraft: string;
  isSavingCharacter: boolean;
}

export interface CharacterActions {
  setBuildTab: (tab: BuildTab) => void;
  setMdViewMode: (mode: MdViewMode) => void;
  setIsImportDragActive: (active: boolean) => void;
  setConfirmDestroy: (dialog: ConfirmDestroyDialog | null) => void;
  setRenamingChatId: (id: ChatId | null) => void;
  setRenameDraft: (draft: string) => void;
  setIsSavingCharacter: (saving: boolean) => void;
}

export type CharacterStore = CharacterState & CharacterActions;

export const useCharacterStore = create<CharacterStore>()((set) => ({
  buildTab: "character",
  mdViewMode: "form",
  isImportDragActive: false,
  confirmDestroy: null,
  renamingChatId: null,
  renameDraft: "",
  isSavingCharacter: false,

  setBuildTab: (tab) => set({ buildTab: tab }),
  setMdViewMode: (mode) => set({ mdViewMode: mode }),
  setIsImportDragActive: (active) => set({ isImportDragActive: active }),
  setConfirmDestroy: (dialog) => set({ confirmDestroy: dialog }),
  setRenamingChatId: (id) => set({ renamingChatId: id }),
  setRenameDraft: (draft) => set({ renameDraft: draft }),
  setIsSavingCharacter: (saving) => set({ isSavingCharacter: saving }),
}));

if (typeof window !== "undefined") window.__useCharacterStore = useCharacterStore;
