import { useId, useState } from "react";
import { useIsMobile } from "../../../../hooks/use-mobile.js";
import { useT } from "../../../../i18n/context.js";
import { cn } from "../../../../lib/cn.js";
import { modalPanelCls } from "../../../shared/modal-helpers.js";
import { Modal } from "../../../shared/Modal.js";
import { Toggle } from "../../../shared/Toggle.js";
import { useScriptSafetySettingsStore } from "../../../../stores/script-safety-settings-store.js";
import type { ScriptKind } from "@vibe-tavern/domain";
import { analyzeScriptSource, type ScriptSafetyFinding } from "@vibe-tavern/domain/script-safety";
import type { ScriptRecord } from "../../../../api/types.js";
import { isUntrustedImport } from "./ScriptSafetyBanner.js";
import { blockingFindings } from "./FindingsWarningModal.js";

/** The honest verb of the confirmed action — drives the confirm label. */
export type ScriptSafetyWarningIntent = "enable" | "test";

/** Which warning surface (if any) an enable/test attempt must pass through
 *  before the action proceeds. The SINGLE source of the SS-7 state matrix —
 *  every wiring site (ScriptEditor / ScriptTester / DiceScriptTester /
 *  ExperienceEditor) calls THIS function; a hand-rolled copy is a defect.
 *
 *  Matrix (plan decisions 3/4/11 + the Non-negotiable constraints):
 *  - `in_app` scripts: NEVER a modal (decision 6 — highlights only, and the
 *    detector is not even run for them here).
 *  - imported + `warning`+ findings: the FINDINGS modal ALONE (decision 11 —
 *    it carries the honest warning text exactly when the plain warning would
 *    also have fired: untrusted and not suppressed).
 *  - imported + untrusted + no blocking findings + not suppressed: the PLAIN
 *    warning with the «don't show again» checkbox.
 *  - imported + untrusted + suppressed (+ no blocking findings): no modal, but
 *    the stored suppression IS the acknowledgement — a test run still rides
 *    the acknowledged path (`warningAcknowledged: true`, decision 14: the
 *    server refuses untrusted scripts without the flag).
 *  - imported + trusted + no blocking findings: no modal, unacknowledged
 *    (the plain warning never fires for already-enabled scripts). */
export type ScriptSafetyWarningFlow =
  | { kind: "none"; warningAcknowledged: boolean }
  | { kind: "plain" }
  | { kind: "findings"; findings: readonly ScriptSafetyFinding[]; showHonestWarning: boolean };

export function scriptSafetyWarningFlow(input: {
  script: Pick<ScriptRecord, "origin" | "firstEnabledAt"> | null;
  code: string;
  kind: ScriptKind;
  /** The server suppress flag; `null` = not loaded yet → fail OPEN (the
   *  honest warning shows — a slow or failed fetch can never silence it). */
  suppressImportWarnings: boolean | null;
}): ScriptSafetyWarningFlow {
  // in_app scripts never get modals — skip the detector parse entirely.
  if (input.script?.origin !== "imported") return { kind: "none", warningAcknowledged: false };
  const untrusted = isUntrustedImport(input.script);
  const findings = blockingFindings(analyzeScriptSource(input.code, input.kind));
  if (findings.length > 0) {
    return {
      kind: "findings",
      findings,
      showHonestWarning: untrusted && input.suppressImportWarnings !== true,
    };
  }
  if (untrusted && input.suppressImportWarnings !== true) return { kind: "plain" };
  return { kind: "none", warningAcknowledged: untrusted };
}

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
