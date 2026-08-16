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
  /** IR-81A trust restoration: the `enabled` value as of the last moment the
   *  draft's CODE was clean — i.e. the trust state from BEFORE the current
   *  dirtying code edit. A previously-TRUSTED interactive script regains
   *  trust on Save (reviewing the diff — e.g. accepting copilot hunks — and
   *  committing the exact source is the explicit trust re-affirmation), while
   *  a script that was untrusted before the edit (or never enabled) stays
   *  fail-closed. `patch` refreshes this only while the code is clean. */
  enabledBeforeCodeEdit: boolean;
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
            enabledBeforeCodeEdit: incoming.enabled,
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
      const values = { ...existing.values, ...patch };
      // Interactive rules execute with host permissions, so enabled is their
      // exact-version trust signal. A changed local source stays untrusted
      // while unsaved (patch forces enabled=false), but Save restores trust
      // for a previously-trusted script via enabledBeforeCodeEdit below —
      // see ScriptDraftEntry. Prompt and Dice scripts retain their existing
      // enabled semantics.
      if (values.scriptKind === "interactive" && values.code !== existing.base.code) {
        values.enabled = false;
      }
      const codeCleanAfterPatch = values.code === existing.base.code;
      set((state) => ({
        drafts: {
          ...state.drafts,
          [scriptId]: {
            ...existing,
            values,
            // Refresh the pre-edit trust stash only while the code is clean;
            // while dirty it must keep remembering the trust state from BEFORE
            // the edit (values.enabled was just forced false above).
            enabledBeforeCodeEdit: codeCleanAfterPatch ? values.enabled : existing.enabledBeforeCodeEdit,
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
      // IR-81A trust restoration: a previously-trusted interactive script
      // regains trust on Save. Accepting the diff (e.g. copilot hunks) and
      // committing the exact reviewed source IS the explicit re-affirmation;
      // the fail-closed paths stay fail-closed (untrusted-before-edit scripts
      // and non-interactive kinds are untouched).
      if (
        submitted.scriptKind === "interactive"
        && submitted.code !== existing.base.code
        && existing.enabledBeforeCodeEdit
      ) {
        submitted.enabled = true;
      }
      // The submitted snapshot IS the buffer being saved — sync the draft
      // values to it (the restoration above is part of that snapshot), so
      // completeSave's mid-flight divergence check (values vs submitted)
      // only trips on REAL edits made during the request, not on the
      // restoration itself.
      clearSavedTimer(scriptId);
      set((state) => ({
        drafts: {
          ...state.drafts,
          [scriptId]: { ...existing, values: submitted, saveState: "saving", error: null },
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
            // While still dirty (edited mid-flight) keep remembering the
            // pre-edit trust; once clean, the persisted record IS the new
            // pre-edit trust state for any later edit cycle.
            enabledBeforeCodeEdit: editedDuringSave ? existing.enabledBeforeCodeEdit : persisted.enabled,
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
