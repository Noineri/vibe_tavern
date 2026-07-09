import { create } from "zustand";
import type { ReactNode } from "react";
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
  isSavingCharacter: boolean;
}

export interface CharacterActions {
  setBuildTab: (tab: BuildTab) => void;
  setMdViewMode: (mode: MdViewMode) => void;
  setIsImportDragActive: (active: boolean) => void;
  setConfirmDestroy: (dialog: ConfirmDestroyDialog | null) => void;
  setIsSavingCharacter: (saving: boolean) => void;
}

export type CharacterStore = CharacterState & CharacterActions;

export const useCharacterStore = create<CharacterStore>()((set) => ({
  buildTab: "character",
  mdViewMode: "form",
  isImportDragActive: false,
  confirmDestroy: null,
  isSavingCharacter: false,

  setBuildTab: (tab) => set({ buildTab: tab }),
  setMdViewMode: (mode) => set({ mdViewMode: mode }),
  setIsImportDragActive: (active) => set({ isImportDragActive: active }),
  setConfirmDestroy: (dialog) => set({ confirmDestroy: dialog }),
  setIsSavingCharacter: (saving) => set({ isSavingCharacter: saving }),
}));

if (typeof window !== "undefined") window.__useCharacterStore = useCharacterStore;
