/**
 * Dictation preference store (STT_PLAN ST-4b): the enable gate + transcript
 * mode, hydrated from (and persisted to) localStorage via the pure helpers in
 * lib/stt/dictation-settings.ts. A store rather than direct reads so the STT
 * tab's switch immediately re-renders the chat-input mic button (plain
 * zustand — UI state, not canonical data; the active-profile POINTER stays
 * server-side in ui_settings).
 */

import { create } from "zustand";

import {
  DEFAULT_DICTATION_SETTINGS,
  persistDictationSettings,
  readDictationSettings,
  type DictationMode,
} from "../lib/stt/dictation-settings.js";

interface DictationState {
  enabled: boolean;
  mode: DictationMode;
  setEnabled(enabled: boolean): void;
  setMode(mode: DictationMode): void;
}

function write(state: Pick<DictationState, "enabled" | "mode">): void {
  persistDictationSettings({ enabled: state.enabled, mode: state.mode });
}

const initial = readDictationSettings();

export const useDictationStore = create<DictationState>((set, get) => ({
  enabled: initial.enabled,
  mode: initial.mode ?? DEFAULT_DICTATION_SETTINGS.mode,
  setEnabled: (enabled) => {
    set({ enabled });
    write(get());
  },
  setMode: (mode) => {
    set({ mode });
    write(get());
  },
}));
