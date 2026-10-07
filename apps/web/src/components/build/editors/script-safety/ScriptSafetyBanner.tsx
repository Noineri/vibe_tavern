import { useEffect } from "react";
import type { ScriptRecord } from "../../../../api/types.js";
import { cn } from "../../../../lib/cn.js";
import { useT } from "../../../../i18n/context.js";
import { useScriptSafetySettingsStore } from "../../../../stores/script-safety-settings-store.js";

/** UNTRUSTED = imported and never enabled (SCRIPT_SAFETY_PLAN, SS-6). The
 *  single source for the trust predicate shared by the banner and the
 *  ExperienceEditor enable-lock. */
export function isUntrustedImport(script: Pick<ScriptRecord, "origin" | "firstEnabledAt"> | null): boolean {
  return script !== null && script.origin === "imported" && script.firstEnabledAt === null;
}

interface ScriptSafetyBannerProps {
  script: Pick<ScriptRecord, "origin" | "firstEnabledAt">;
  /** Placement extension — joins the baked notice classes (cn is join-only). */
  className?: string;
}

/**
 * Imported-script banner (decision 5), rendered near the enable toggle in BOTH
 * editors. Shows for UNTRUSTED scripts only (imported + never enabled); it
 * never renders for in-app or trusted scripts, so there is no layout shift for
 * them. When the server `suppressImportWarnings` flag is set, the same line
 * collapses to a single «Show warnings again» control that flips the flag back
 * off via PUT.
 */
export function ScriptSafetyBanner({ script, className }: ScriptSafetyBannerProps) {
  const { t } = useT();
  const suppress = useScriptSafetySettingsStore((s) => s.suppressImportWarnings);
  const load = useScriptSafetySettingsStore((s) => s.load);
  const setSuppress = useScriptSafetySettingsStore((s) => s.setSuppress);

  useEffect(() => {
    void load();
  }, [load]);

  if (!isUntrustedImport(script)) return null;

  return (
    <div
      data-testid="script-safety-banner"
      className={cn(
        "mb-4 rounded-md border border-warning/40 bg-warning-dim px-3 py-2 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-warning-text",
        className,
      )}
    >
      {suppress === true ? (
        <button
          type="button"
          className="cursor-pointer underline underline-offset-2 transition-colors hover:text-t1"
          onClick={() => void setSuppress(false)}
        >
          {t("script_safety_banner_show_warnings")}
        </button>
      ) : (
        <span>{t("script_safety_banner_imported")}</span>
      )}
    </div>
  );
}
