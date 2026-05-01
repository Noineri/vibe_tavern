import { create } from "zustand";
import type { ReactNode } from "react";
import type { ChatId, PromptPresetDto } from "@rp-platform/domain";
import type { PersonaRecord } from "../app-client.js";
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
  isFirstRun: boolean;
  confirmDestroy: ConfirmDestroyDialog | null;
  renamingChatId: ChatId | null;
  renameDraft: string;
  isSavingCharacter: boolean;
  characterSaveNotice: string;
  personas: PersonaRecord[];
  promptPresets: PromptPresetDto[];
  activePromptPresetId: string | null;
}

export interface CharacterActions {
  setBuildTab: (tab: BuildTab) => void;
  setIsImportDragActive: (active: boolean) => void;
  setImportNotice: (notice: string) => void;
  setIsFirstRun: (first: boolean) => void;
  setConfirmDestroy: (dialog: ConfirmDestroyDialog | null) => void;
  setRenamingChatId: (id: ChatId | null) => void;
  setRenameDraft: (draft: string) => void;
  setIsSavingCharacter: (saving: boolean) => void;
  setCharacterSaveNotice: (notice: string) => void;
  setPersonas: (personas: PersonaRecord[]) => void;
  setPromptPresets: (presets: PromptPresetDto[]) => void;
  setActivePromptPresetId: (id: string | null) => void;
}

export type CharacterStore = CharacterState & CharacterActions;

export const useCharacterStore = create<CharacterStore>()((set) => ({
  buildTab: "character",
  isImportDragActive: false,
  importNotice: "",
  isFirstRun: false,
  confirmDestroy: null,
  renamingChatId: null,
  renameDraft: "",
  isSavingCharacter: false,
  characterSaveNotice: "",
  personas: [],
  promptPresets: [],
  activePromptPresetId: null,

  setBuildTab: (tab) => set({ buildTab: tab }),
  setIsImportDragActive: (active) => set({ isImportDragActive: active }),
  setImportNotice: (notice) => set({ importNotice: notice }),
  setIsFirstRun: (first) => set({ isFirstRun: first }),
  setConfirmDestroy: (dialog) => set({ confirmDestroy: dialog }),
  setRenamingChatId: (id) => set({ renamingChatId: id }),
  setRenameDraft: (draft) => set({ renameDraft: draft }),
  setIsSavingCharacter: (saving) => set({ isSavingCharacter: saving }),
  setCharacterSaveNotice: (notice) => set({ characterSaveNotice: notice }),
  setPersonas: (personas) => set({ personas }),
  setPromptPresets: (presets) => set({ promptPresets: presets }),
  setActivePromptPresetId: (id) => set({ activePromptPresetId: id }),
}));
