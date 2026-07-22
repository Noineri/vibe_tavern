import { create } from "zustand";
import type { ScriptRecord } from "../api/types.js";

/** The four fields edited by the Script editor. Scope/order/link mutations are
 * separate immediate operations and never participate in the authoring draft. */
export type ScriptDraftValues = Pick<ScriptRecord, "name" | "description" | "code" | "enabled" | "scriptKind">;
export type ScriptDraftSaveState = "idle" | "saving" | "saved" | "error";

export interface ScriptDraftEntry {
  /** Current authoring buffer — the sole source of truth for editor fields. */
  values: ScriptDraftValues;
  /** Last successfully persisted snapshot, used only for dirty comparison. */
  base: ScriptDraftValues;
  saveState: ScriptDraftSaveState;
  error: string | null;
}

interface ScriptDraftState {
  /** scriptId → edit buffer. Store lifetime spans Build-panel unmounts. */
  drafts: Record<string, ScriptDraftEntry>;
}

interface ScriptDraftActions {
  /** Initialize from the server record unless a dirty/in-flight draft exists. */
  ensure(script: ScriptRecord): void;
  /** Apply a synchronous local edit. Never performs I/O. */
  patch(scriptId: string, patch: Partial<ScriptDraftValues>): void;
  /** Capture the exact snapshot Save should PATCH and enter saving state. */
  prepareSave(scriptId: string): ScriptDraftValues | null;
  /** Reconcile a successful PATCH without erasing edits made mid-flight. */
  completeSave(scriptId: string, submitted: ScriptDraftValues, saved: ScriptRecord): void;
  /** Preserve the buffer and surface a retryable save error. */
  failSave(scriptId: string, error: string): void;
  /** Drop one buffer (script deletion). */
  remove(scriptId: string): void;
  /** Test/session reset. */
  resetAll(): void;
}

export type ScriptDraftStore = ScriptDraftState & ScriptDraftActions;

const savedTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearSavedTimer(scriptId: string) {
  const timer = savedTimers.get(scriptId);
  if (timer) clearTimeout(timer);
  savedTimers.delete(scriptId);
}

export function scriptDraftValues(script: ScriptRecord): ScriptDraftValues {
  return {
    name: script.name,
    description: script.description,
    code: script.code,
    enabled: script.enabled,
    scriptKind: script.scriptKind,
  };
}

function valuesEqual(a: ScriptDraftValues, b: ScriptDraftValues): boolean {
  return a.name === b.name
    && a.description === b.description
    && a.code === b.code
    && a.enabled === b.enabled
    && a.scriptKind === b.scriptKind;
}

export function isScriptDraftDirty(entry: ScriptDraftEntry | null | undefined): boolean {
  return !!entry && !valuesEqual(entry.values, entry.base);
}

export const useScriptDraftStore = create<ScriptDraftStore>()((set, get) => {
  const scheduleSavedReset = (scriptId: string) => {
    clearSavedTimer(scriptId);
    savedTimers.set(scriptId, setTimeout(() => {
      savedTimers.delete(scriptId);
      set((state) => {
        const entry = state.drafts[scriptId];
        if (!entry || entry.saveState !== "saved") return state;
        return {
          drafts: {
            ...state.drafts,
            [scriptId]: { ...entry, saveState: "idle" },
          },
        };
      });
    }, 2000));
  };

  return {
    drafts: {},

    ensure(script) {
      const incoming = scriptDraftValues(script);
      const existing = get().drafts[script.id];
      if (existing && (isScriptDraftDirty(existing) || existing.saveState === "saving")) return;
      if (existing && valuesEqual(existing.base, incoming) && valuesEqual(existing.values, incoming)) return;
      clearSavedTimer(script.id);
      set((state) => ({
        drafts: {
          ...state.drafts,
          [script.id]: {
            values: incoming,
            base: incoming,
            saveState: "idle",
            error: null,
          },
        },
      }));
    },

    patch(scriptId, patch) {
      const existing = get().drafts[scriptId];
      if (!existing) return;
      clearSavedTimer(scriptId);
      set((state) => ({
        drafts: {
          ...state.drafts,
          [scriptId]: {
            ...existing,
            values: { ...existing.values, ...patch },
            // Keep the request lock while a submitted snapshot is in flight.
            // completeSave will detect the newer values and return to idle +
            // dirty; until then a second Save must stay disabled.
            saveState: existing.saveState === "saving" ? "saving" : "idle",
            error: null,
          },
        },
      }));
    },

    prepareSave(scriptId) {
      const existing = get().drafts[scriptId];
      if (!existing || !isScriptDraftDirty(existing) || existing.saveState === "saving") return null;
      const submitted = { ...existing.values };
      clearSavedTimer(scriptId);
      set((state) => ({
        drafts: {
          ...state.drafts,
          [scriptId]: { ...existing, saveState: "saving", error: null },
        },
      }));
      return submitted;
    },

    completeSave(scriptId, submitted, saved) {
      const existing = get().drafts[scriptId];
      if (!existing) return;
      const persisted = scriptDraftValues(saved);
      const editedDuringSave = !valuesEqual(existing.values, submitted);
      set((state) => ({
        drafts: {
          ...state.drafts,
          [scriptId]: {
            values: editedDuringSave ? existing.values : persisted,
            base: persisted,
            saveState: editedDuringSave ? "idle" : "saved",
            error: null,
          },
        },
      }));
      if (editedDuringSave) clearSavedTimer(scriptId);
      else scheduleSavedReset(scriptId);
    },

    failSave(scriptId, error) {
      const existing = get().drafts[scriptId];
      if (!existing) return;
      clearSavedTimer(scriptId);
      set((state) => ({
        drafts: {
          ...state.drafts,
          [scriptId]: { ...existing, saveState: "error", error },
        },
      }));
    },

    remove(scriptId) {
      clearSavedTimer(scriptId);
      set((state) => {
        const { [scriptId]: _removed, ...rest } = state.drafts;
        return { drafts: rest };
      });
    },

    resetAll() {
      for (const scriptId of savedTimers.keys()) clearSavedTimer(scriptId);
      set({ drafts: {} });
    },
  };
});
