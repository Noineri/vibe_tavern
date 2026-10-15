import { useEffect } from "react";
import { useScriptSafetySettingsStore } from "../stores/script-safety-settings-store.js";

/** Binding for the «Script import warnings» settings row — the ONE derivation
 *  both consumers render (`TweaksPanel` on desktop, `MobileSettings` on
 *  mobile). The switch reads "warnings shown", the server flag stores the
 *  inverse (`suppressImportWarnings`). An unloaded flag (`null`) reads as
 *  shown — the store's fail-open rule. The row replaced the banner's
 *  «Show warnings again» link (IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 10,
 *  owner ruling 4b: the suppressed state leaves the editor). */
export function useScriptWarningsToggle(): { checked: boolean; onChange: (checked: boolean) => void } {
  const suppress = useScriptSafetySettingsStore((s) => s.suppressImportWarnings);
  const load = useScriptSafetySettingsStore((s) => s.load);
  const setSuppress = useScriptSafetySettingsStore((s) => s.setSuppress);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    checked: suppress !== true,
    // Same failure contract as the imported-script modal's write: surfaced,
    // never an unhandled rejection; the switch stays on the stored value.
    onChange: (checked) => {
      void setSuppress(!checked).catch((error) => {
        console.warn("failed to persist script-safety suppress flag", error);
      });
    },
  };
}
