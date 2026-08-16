import { create } from "zustand";
import type { ExperienceVisualRow } from "../api/types.js";

/** Editable visual fields. The server-owned sourceHash is tracked separately. */
export interface ExperienceVisualDraftValues {
  name: string;
  source: string;
  apiVersion: number;
  compatibleManifestIds: string[];
}

export type ExperienceVisualDraftSaveState = "idle" | "saving" | "saved" | "error";

export interface ExperienceVisualDraftEntry {
  values: ExperienceVisualDraftValues;
  base: ExperienceVisualDraftValues;
  /** Hash of the last persisted source returned by the server. */
  sourceHash: string;
  saveState: ExperienceVisualDraftSaveState;
  error: string | null;
}

interface ExperienceVisualDraftState {
  drafts: Record<string, ExperienceVisualDraftEntry>;
}

interface ExperienceVisualDraftActions {
  ensure(visual: ExperienceVisualRow): void;
  patch(visualId: string, patch: Partial<ExperienceVisualDraftValues>): void;
  prepareSave(visualId: string): ExperienceVisualDraftValues | null;
  completeSave(
    visualId: string,
    submitted: ExperienceVisualDraftValues,
    saved: ExperienceVisualRow,
  ): void;
  failSave(visualId: string, error: string): void;
  remove(visualId: string): void;
  resetAll(): void;
}

export type ExperienceVisualDraftStore = ExperienceVisualDraftState & ExperienceVisualDraftActions;

function valuesFromVisual(
  visual: Pick<ExperienceVisualRow, "name" | "source" | "apiVersion" | "compatibleManifestIds">,
): ExperienceVisualDraftValues {
  return {
    name: visual.name,
    source: visual.source,
    apiVersion: visual.apiVersion,
    compatibleManifestIds: [...visual.compatibleManifestIds],
  };
}

function valuesEqual(a: ExperienceVisualDraftValues, b: ExperienceVisualDraftValues): boolean {
  return a.name === b.name
    && a.source === b.source
    && a.apiVersion === b.apiVersion
    && a.compatibleManifestIds.length === b.compatibleManifestIds.length
    && a.compatibleManifestIds.every((id, index) => id === b.compatibleManifestIds[index]);
}

function copyValues(values: ExperienceVisualDraftValues): ExperienceVisualDraftValues {
  return { ...values, compatibleManifestIds: [...values.compatibleManifestIds] };
}

export function isExperienceVisualDraftDirty(
  entry: ExperienceVisualDraftEntry | null | undefined,
): boolean {
  return !!entry && !valuesEqual(entry.values, entry.base);
}

/** Copy every editable field without retaining the source row's array references. */
export function duplicateVisualDraftValues(
  visual: Pick<ExperienceVisualRow, "name" | "source" | "apiVersion" | "compatibleManifestIds">,
): ExperienceVisualDraftValues {
  return valuesFromVisual(visual);
}

const savedTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearSavedTimer(visualId: string): void {
  const timer = savedTimers.get(visualId);
  if (timer) clearTimeout(timer);
  savedTimers.delete(visualId);
}

export const useExperienceVisualDraftStore = create<ExperienceVisualDraftStore>()((set, get) => {
  const scheduleSavedReset = (visualId: string): void => {
    clearSavedTimer(visualId);
    savedTimers.set(visualId, setTimeout(() => {
      savedTimers.delete(visualId);
      set((state) => {
        const entry = state.drafts[visualId];
        if (!entry || entry.saveState !== "saved") return state;
        return {
          drafts: {
            ...state.drafts,
            [visualId]: { ...entry, saveState: "idle" },
          },
        };
      });
    }, 2000));
  };

  return {
    drafts: {},

    ensure(visual) {
      const incoming = valuesFromVisual(visual);
      const existing = get().drafts[visual.id];
      if (existing && (isExperienceVisualDraftDirty(existing) || existing.saveState === "saving")) return;
      if (existing && valuesEqual(existing.base, incoming) && valuesEqual(existing.values, incoming)) return;
      clearSavedTimer(visual.id);
      set((state) => ({
        drafts: {
          ...state.drafts,
          [visual.id]: {
            values: incoming,
            base: copyValues(incoming),
            sourceHash: visual.sourceHash,
            saveState: "idle",
            error: null,
          },
        },
      }));
    },

    patch(visualId, patch) {
      const existing = get().drafts[visualId];
      if (!existing) return;
      clearSavedTimer(visualId);
      const values = {
        ...existing.values,
        ...patch,
        compatibleManifestIds: patch.compatibleManifestIds === undefined
          ? existing.values.compatibleManifestIds
          : [...patch.compatibleManifestIds],
      };
      set((state) => ({
        drafts: {
          ...state.drafts,
          [visualId]: {
            ...existing,
            values,
            saveState: existing.saveState === "saving" ? "saving" : "idle",
            error: null,
          },
        },
      }));
    },

    prepareSave(visualId) {
      const existing = get().drafts[visualId];
      if (!existing || !isExperienceVisualDraftDirty(existing) || existing.saveState === "saving") return null;
      const submitted = copyValues(existing.values);
      clearSavedTimer(visualId);
      set((state) => ({
        drafts: {
          ...state.drafts,
          [visualId]: { ...existing, saveState: "saving", error: null },
        },
      }));
      return submitted;
    },

    completeSave(visualId, submitted, saved) {
      const existing = get().drafts[visualId];
      if (!existing) return;
      const persisted = valuesFromVisual(saved);
      const editedDuringSave = !valuesEqual(existing.values, submitted);
      set((state) => ({
        drafts: {
          ...state.drafts,
          [visualId]: {
            values: editedDuringSave ? existing.values : persisted,
            base: copyValues(persisted),
            sourceHash: saved.sourceHash,
            saveState: editedDuringSave ? "idle" : "saved",
            error: null,
          },
        },
      }));
      if (editedDuringSave) clearSavedTimer(visualId);
      else scheduleSavedReset(visualId);
    },

    failSave(visualId, error) {
      const existing = get().drafts[visualId];
      if (!existing) return;
      clearSavedTimer(visualId);
      set((state) => ({
        drafts: {
          ...state.drafts,
          [visualId]: { ...existing, saveState: "error", error },
        },
      }));
    },

    remove(visualId) {
      clearSavedTimer(visualId);
      set((state) => {
        const { [visualId]: _removed, ...rest } = state.drafts;
        return { drafts: rest };
      });
    },

    resetAll() {
      for (const visualId of savedTimers.keys()) clearSavedTimer(visualId);
      set({ drafts: {} });
    },
  };
});
