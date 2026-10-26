import { useEffect } from "react";
import type { ScriptRecord } from "../../../../api/types.js";
import { cn } from "../../../../lib/cn.js";
import { isUntrustedImport } from "../../../../lib/script-execution-guard.js";
import { useT } from "../../../../i18n/context.js";
import { useScriptSafetySettingsStore } from "../../../../stores/script-safety-settings-store.js";

export { isUntrustedImport };

interface ScriptSafetyBannerProps {
  script: Pick<ScriptRecord, "origin" | "firstEnabledAt">;
  /** Placement extension — joins the baked notice classes (cn is join-only). */
  className?: string;
}

/**
 * Imported-script banner (decision 5), rendered near the enable toggle in BOTH
 * editors. Shows for UNTRUSTED scripts only (imported + never enabled); it
 * never renders for in-app or trusted scripts, so there is no layout shift for
 * them. When the server `suppressImportWarnings` flag is set, it renders
 * NOTHING — the flag is switched back on from settings («Script import
 * warnings» row in TweaksPanel / MobileSettings). The former lone «Show
 * warnings again» link inside the warning box was removed by owner ruling
 * 4b (IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 10): it cost the editor a
 * full banner's height for one link.
 */
export function ScriptSafetyBanner({ script, className }: ScriptSafetyBannerProps) {
  const { t } = useT();
  const suppress = useScriptSafetySettingsStore((s) => s.suppressImportWarnings);
  const load = useScriptSafetySettingsStore((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  if (!isUntrustedImport(script) || suppress === true) return null;

  return (
    <div
      data-testid="script-safety-banner"
      className={cn(
        "mb-4 rounded-md border border-warning/40 bg-warning-dim px-3 py-2 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-warning-text",
        className,
      )}
    >
      <span>{t("script_safety_banner_imported")}</span>
      <span className="block">{t("script_safety_banner_full_access")}</span>
    </div>
  );
}
