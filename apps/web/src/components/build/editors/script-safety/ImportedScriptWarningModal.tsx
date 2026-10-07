import { useId, useState } from "react";
import { useIsMobile } from "../../../../hooks/use-mobile.js";
import { useT } from "../../../../i18n/context.js";
import { cn } from "../../../../lib/cn.js";
import { modalPanelCls } from "../../../shared/modal-helpers.js";
import { Modal } from "../../../shared/Modal.js";
import { Toggle } from "../../../shared/Toggle.js";
import { useScriptSafetySettingsStore } from "../../../../stores/script-safety-settings-store.js";
import { scriptSafetyWarningFlow } from "../../../../lib/script-execution-guard.js";
import type {
  ScriptSafetyWarningFlow,
  ScriptSafetyWarningIntent,
} from "../../../../lib/script-execution-guard.js";

export { scriptSafetyWarningFlow };
export type { ScriptSafetyWarningFlow, ScriptSafetyWarningIntent };

interface ImportedScriptWarningModalProps {
  /** The honest verb of the confirmed action — «Enable anyway» vs «Run again». */
  intent: ScriptSafetyWarningIntent;
  /** Proceed with the enable/test after the explicit acknowledge. */
  onConfirm: () => void;
  /** Abort — the script stays disabled / the run is not sent. */
  onCancel: () => void;
}

/**
 * First-enable / test-run warning modal (SS-7, plan decision 3): the plain
 * form of the honest warning, shown ONLY for imported never-enabled scripts
 * with NO blocking detector findings (decision 11 — with findings, the
 * findings modal shows alone and carries this text itself).
 *
 * The «don't show again» Toggle PUTs the server-side singleton setting
 * (one flag for all devices). Checking it NEVER skips the current decision:
 * the enable/run still requires the explicit confirm — the checkbox only
 * silences FUTURE plain warnings (the findings modal stays unsilenceable).
 *
 * Chrome: the shared `Modal` shell (overlay/portal/focus-trap + mobile
 * fullscreen) around a `modalPanelCls` panel (SS-6B single source) with the
 * canon cancel/confirm footer pair.
 */
export function ImportedScriptWarningModal({ intent, onConfirm, onCancel }: ImportedScriptWarningModalProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const suppressToggleId = useId();
  const [suppress, setSuppress] = useState(false);
  const setSuppressSetting = useScriptSafetySettingsStore((s) => s.setSuppress);

  const handleConfirm = () => {
    if (suppress) {
      // The checkbox is the only suppression write path (decision 3).
      // Best-effort: a failed PUT never blocks the acknowledged action — the
      // decision was made in THIS modal; only FUTURE warning visibility is at
      // stake, and the failure is surfaced rather than swallowed.
      void setSuppressSetting(true).catch((error) => {
        console.warn("failed to persist script-safety suppress flag", error);
      });
    }
    onConfirm();
  };

  return (
    <Modal
      open
      onClose={onCancel}
      title={t("script_safety_warning_title")}
      description={t("script_safety_warning_body")}
    >
      <div
        data-testid="script-safety-warning-modal"
        className={cn(
          "flex flex-col",
          isMobile
            ? "glass-blur-under h-full w-full overflow-hidden"
            : cn(modalPanelCls, "max-h-[calc(100vh-60px)] w-[min(92vw,440px)] max-w-[calc(100vw-32px)]"),
        )}
      >
        {/* Header */}
        <div className="shrink-0 px-5 pt-[18px]">
          <div className="font-body text-[calc(var(--ui-fs)+4px)] font-medium text-t1">
            {t("script_safety_warning_title")}
          </div>
        </div>

        {/* Body — the honest warning + the «don't show again» toggle */}
        <div className="flex-1 overflow-y-auto px-5 py-3.5">
          <p className="font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2">
            {t("script_safety_warning_body")}
          </p>
          <div className="mt-4 flex items-center gap-2.5">
            <Toggle id={suppressToggleId} checked={suppress} onChange={setSuppress} />
            <label
              htmlFor={suppressToggleId}
              className="cursor-pointer font-ui text-[calc(var(--ui-fs)-2px)] text-t3"
            >
              {t("script_safety_warning_suppress")}
            </label>
          </div>
        </div>

        {/* Footer — canon cancel/confirm pair */}
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2.5 border-t border-border px-5 py-[14px]">
          <button
            type="button"
            className="h-[37px] cursor-pointer rounded-md bg-transparent py-0 px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1"
            onClick={onCancel}
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            className="h-[37px] cursor-pointer rounded-md bg-accent py-0 px-[21px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-on-accent transition-all hover:brightness-110"
            onClick={handleConfirm}
          >
            {t(intent === "enable" ? "script_safety_warning_confirm_enable" : "script_safety_warning_confirm_run")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
