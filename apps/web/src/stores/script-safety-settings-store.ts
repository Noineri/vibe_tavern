import { create } from "zustand";
import { getScriptSafetySettings, updateScriptSafetySettings } from "../api/settings-api.js";

/**
 * Client cache for the server-side script-safety singleton
 * (`/api/settings/script-safety`, SCRIPT_SAFETY_PLAN decision 3). One flag for
 * all devices; both editors' imported-script banner reads it and the
 * «Show warnings again» control writes it back.
 *
 * `suppressImportWarnings === null` means "not loaded yet" — consumers
 * fail OPEN (show the warning) so a slow or failed fetch never silences the
 * honest first-enable warning.
 */
interface ScriptSafetySettingsState {
  suppressImportWarnings: boolean | null;
  load: () => Promise<void>;
  setSuppress: (value: boolean) => Promise<void>;
}

export const useScriptSafetySettingsStore = create<ScriptSafetySettingsState>()((set, get) => ({
  suppressImportWarnings: null,

  load: async () => {
    // Single-flight: a second mount while already loaded (or while a load is
    // in flight) must not refetch. `null` is the only "unloaded" sentinel.
    if (get().suppressImportWarnings !== null) return;
    try {
      const settings = await getScriptSafetySettings();
      set({ suppressImportWarnings: settings.suppressImportWarnings });
    } catch {
      // Fail open — leave the sentinel null so the banner keeps showing the
      // warning and a later mount can retry.
    }
  },

  setSuppress: async (value) => {
    const updated = await updateScriptSafetySettings({ suppressImportWarnings: value });
    set({ suppressImportWarnings: updated.suppressImportWarnings });
  },
}));
