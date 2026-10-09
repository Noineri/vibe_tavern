import { useIsMobile } from "../../../../hooks/use-mobile.js";
import { useT } from "../../../../i18n/context.js";
import { cn } from "../../../../lib/cn.js";
import { modalPanelCls } from "../../../shared/modal-helpers.js";
import { Modal } from "../../../shared/Modal.js";
import { blockingFindings } from "../../../../lib/script-execution-guard.js";
import type { ScriptSafetyWarningIntent } from "../../../../lib/script-execution-guard.js";
import { scriptSafetyRuleI18nKey } from "../../../../lib/script-safety-lint.js";
import { Text, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { ScriptSafetyFinding } from "@vibe-tavern/domain/script-safety";

export { blockingFindings };

/** Clamp a 1-based finding line onto the live document (1..doc.lines) and
 *  return the absolute 0-based offset of that line's start — the jump target
 *  the «Show in code» reveal uses. Pure so the clamp is unit-testable without
 *  an editor view. */
export function scriptSafetyRevealPosition(doc: Text, line: number): number {
  const clamped = Math.max(1, Math.min(line, doc.lines));
  return doc.line(clamped).from;
}

/** The «Show in code» reveal jump (SS-7): a CodeMirror extension that, once
 *  installed, moves the caret to the finding's line and centers it — the
 *  same affordance the lint gutter gives, driven from the modal.
 *
 *  Consumers fold it into their existing `extensions` array (the CD-4
 *  compartment seam, like the SS-5 linter): passing a FRESH instance per
 *  reveal request reconfigures the compartment, which (re)instantiates this
 *  plugin and fires the jump. The closure-level `fired` flag guarantees ONE
 *  jump per request even when a later spec change reconfigures the same
 *  memoized instance back in.
 *
 *  The dispatch is deferred a frame (CodeMirror requires measure-safe timing
 *  for scroll effects) and guarded by DOM connectivity so a view destroyed by
 *  a remount (mobile breakpoint crossing) can never throw. */
export function scriptSafetyRevealLine(line: number): Extension {
  let fired = false;
  return ViewPlugin.define((view) => {
    if (fired) return {};
    fired = true;
    const pos = scriptSafetyRevealPosition(view.state.doc, line);
    requestAnimationFrame(() => {
      if (!view.dom.isConnected) return;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });
    });
    return {};
  });
}

/** Severity badge chrome for the two severities that reach the modal. */
const SEVERITY_BADGE_CLS: Readonly<Record<"warning" | "critical", string>> = {
  warning: "bg-warning-dim text-warning-text",
  critical: "bg-danger-dim text-danger-text",
} as const;

interface FindingsWarningModalProps {
  /** The blocking findings to list (already `warning`+ filtered — the flow
   *  guarantees non-empty; the render stays defensive anyway). */
  findings: readonly ScriptSafetyFinding[];
  /** Decision 11 (single window): when the plain first-enable warning would
   *  ALSO fire, its honest text rides INSIDE this modal instead of stacking a
   *  second dialog. False for trusted imports and suppressed warnings — those
   *  would show no plain warning in the first place. */
  showHonestWarning: boolean;
  /** The honest verb of the confirmed action — «Enable anyway» vs «Run again». */
  intent: ScriptSafetyWarningIntent;
  /** «Show in code» — invoked with the FIRST finding's line; the caller
   *  closes the modal and reveals that line in its editor. */
  onShowInCode: (line: number) => void;
  /** Proceed (enable / run) despite the findings. */
  onConfirm: () => void;
  /** Abort — the script stays disabled / the run is not sent. */
  onCancel: () => void;
}

/**
 * Findings warning modal (SS-7, plan decision 4 + item 12): fires for ANY
 * imported script (trusted included — the modal is ORIGIN-based, never for
 * `in_app`) whose source carries `warning`+ detector findings, ALWAYS,
 * regardless of the suppress checkbox — and carries NO checkbox of its own.
 * Lists severity badge, localized rule message, and line number per finding.
 *
 * Chrome: the shared `Modal` shell (overlay/portal/focus-trap + mobile
 * fullscreen) around a `modalPanelCls` panel (SS-6B single source) with the
 * canon cancel/confirm footer pair; the «Show in code» button is the outline sibling
 * of the destructive-secondary footer shape.
 */
export function FindingsWarningModal({
  findings,
  showHonestWarning,
  intent,
  onShowInCode,
  onConfirm,
  onCancel,
}: FindingsWarningModalProps) {
  const { t, tDynamic } = useT();
  const isMobile = useIsMobile();

  return (
    <Modal
      open
      onClose={onCancel}
      title={t("script_safety_findings_title")}
      description={t("script_safety_findings_intro")}
    >
      <div
        data-testid="script-safety-findings-modal"
        className={cn(
          "flex flex-col",
          isMobile
            ? "glass-blur-under h-full w-full overflow-hidden"
            : cn(modalPanelCls, "max-h-[calc(100vh-60px)] w-[min(92vw,520px)] max-w-[calc(100vw-32px)]"),
        )}
      >
        {/* Header */}
        <div className="shrink-0 px-5 pt-[18px]">
          <div className="font-body text-[calc(var(--ui-fs)+4px)] font-medium text-t1">
            {t("script_safety_findings_title")}
          </div>
          <div className="mt-1 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t3">
            {t("script_safety_findings_intro")}
          </div>
        </div>

        {/* Body — findings list + the honest warning text when it applies */}
        <div className="flex-1 overflow-y-auto px-5 py-3.5">
          {showHonestWarning && (
            <p className="mb-3 rounded-md border border-warning/40 bg-warning-dim px-3 py-2 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-warning-text">
              {t("script_safety_warning_body")}
            </p>
          )}
          <ul className="space-y-1.5">
            {findings.map((finding, index) => (
              <li
                key={`${finding.ruleId}:${finding.line}:${index}`}
                className="flex items-start gap-2 rounded-md border border-border bg-s2 px-2.5 py-2"
              >
                <span
                  className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 font-ui text-[10px] font-medium uppercase tracking-wide",
                    SEVERITY_BADGE_CLS[finding.severity === "critical" ? "critical" : "warning"],
                  )}
                >
                  {t(finding.severity === "critical" ? "script_safety_severity_critical" : "script_safety_severity_warning")}
                </span>
                <span className="min-w-0 flex-1 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2">
                  {tDynamic(scriptSafetyRuleI18nKey(finding.ruleId))}
                </span>
                <span className="shrink-0 font-mono text-[calc(var(--ui-fs)-3px)] text-t3">
                  {t("script_safety_findings_line", { line: finding.line })}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* Footer — Show in code / Cancel / Confirm-anyway (canon pair +
            the outline sibling; flex-wrap so RU never truncates — AD-022). */}
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2.5 border-t border-border px-5 py-[14px]">
          {findings.length > 0 && (
            <button
              type="button"
              className="h-[37px] cursor-pointer rounded-md border border-border bg-transparent py-0 px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t2 transition-all hover:bg-s2 hover:text-t1"
              onClick={() => onShowInCode(findings[0].line)}
            >
              {t("script_safety_findings_show_in_code")}
            </button>
          )}
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
            onClick={onConfirm}
          >
            {t(intent === "enable" ? "script_safety_warning_confirm_enable" : "script_safety_warning_confirm_run")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
