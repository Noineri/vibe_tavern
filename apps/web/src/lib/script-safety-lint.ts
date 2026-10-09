/**
 * Script safety lint adapter (SCRIPT_SAFETY_PLAN Wave 4, unit SS-5).
 *
 * The SINGLE bridge between the pure domain detector
 * (`analyzeScriptSource`, packages/domain — SS-1) and the two script editors'
 * CodeMirror surfaces (the prompt/dice `ScriptEditor` and the mini-app rules
 * editor inside `ExperienceCopilotShell` → `ExperienceCopilotEditorPanel`).
 * Every editor that wants suspicion diagnostics imports THIS module; there is
 * no second derivation of the finding → diagnostic mapping (AGENTS.md §3).
 *
 * CONTRACT:
 * - `scriptSafetyDiagnostics` is a PURE mapping (`ScriptSafetyFinding[]` + the
 *   document text) → `@codemirror/lint` `Diagnostic[]`. It is unit-testable
 *   without a mounted editor.
 * - `scriptSafetyLint` wraps the pure mapping in `linter()` + `lintGutter()`.
 *   It does NOT set a custom `delay`: `@codemirror/lint`'s `linter()` already
 *   debounces — it re-runs only after the document has been idle for its
 *   built-in 750ms, never synchronously per keystroke. Reusing the library's
 *   debounce keeps the parse cost off the typing path (plan constraint) without
 *   introducing a new hardcoded timer constant.
 * - Line/column conversion honors the detector's 1-based convention (acorn
 *   columns are 0-based; SS-1 emits `col = column + 1`). CodeMirror positions
 *   are absolute 0-based offsets, so `from = line.from + (col - 1)`.
 * - Diagnostics are NON-BLOCKING by construction: they render as margin markers
 *   + squiggles + tooltips. Nothing here touches the editor's save/enable flow
 *   (the banner is SS-6, the findings modal is SS-7).
 */
import { linter, lintGutter, type Diagnostic, type LintSource } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { Text } from "@codemirror/state";
import type { ScriptKind } from "@vibe-tavern/domain";
import {
  analyzeScriptSource,
  type ScriptSafetyFinding,
  type ScriptSafetySeverity,
} from "@vibe-tavern/domain/script-safety";
import { getTDynamic, type TDynamic } from "../i18n/locale-helpers.js";

/** Severity → the editor diagnostic level. `critical` maps to `error` so the
 *  most severe findings stand out; `info`/`warning` mirror the domain. */
const DIAGNOSTIC_SEVERITY: Readonly<Record<ScriptSafetySeverity, Diagnostic["severity"]>> = {
  info: "info",
  warning: "warning",
  critical: "error",
} as const;

/** The `@codemirror/lint` diagnostic `source` label — keeps the panel/hover
 *  provenance explicit ("script safety" vs. the editor's own parse errors). */
const DIAGNOSTIC_SOURCE = "script safety";

/** Map a stable detector `ruleId` (kebab-case, e.g. `escape-constructor-chain`)
 *  to its i18n key (`script_safety_rule_escape_constructor_chain`). */
export function scriptSafetyRuleI18nKey(ruleId: string): string {
  return "script_safety_rule_" + ruleId.replace(/-/g, "_");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * Pure finding → diagnostic mapping. `doc` is the document the findings were
 * computed against (its line structure supplies the absolute offsets).
 * `messageFor` resolves a rule id's i18n key to user-facing text.
 */
export function scriptSafetyDiagnostics(
  findings: readonly ScriptSafetyFinding[],
  doc: Text,
  messageFor: (key: string) => string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const finding of findings) {
    const line = doc.line(clamp(finding.line, 1, doc.lines));
    const column = finding.col ?? 1;
    const from = line.from + clamp(column - 1, 0, line.length);
    diagnostics.push({
      from,
      to: line.to,
      severity: DIAGNOSTIC_SEVERITY[finding.severity],
      message: messageFor(scriptSafetyRuleI18nKey(finding.ruleId)),
      source: DIAGNOSTIC_SOURCE,
    });
  }
  return diagnostics;
}

/** The `LintSource` for a given script kind, separated from the extension
 *  wrapper so the kind-forwarding contract is unit-testable without a view. */
export function scriptSafetyLintSource(kind: ScriptKind, messageFor: TDynamic): LintSource {
  return (view) =>
    scriptSafetyDiagnostics(
      analyzeScriptSource(view.state.doc.toString(), kind),
      view.state.doc,
      messageFor,
    );
}

/**
 * The editor extension: a debounced linter plus the gutter that renders the
 * margin markers. Pass this array straight into `CodeEditor`'s `extensions`
 * prop (CD-4 reconfigures the Compartment in place — no remount).
 *
 * `messageFor` defaults to {@link getTDynamic} — the non-React translate path
 * (the linter runs OUTSIDE React render, in CodeMirror's debounced callback),
 * so messages always resolve against the CURRENT locale at lint time, never a
 * stale render closure.
 */
export function scriptSafetyLint(kind: ScriptKind, messageFor: TDynamic = getTDynamic()): Extension[] {
  return [lintGutter(), linter(scriptSafetyLintSource(kind, messageFor))];
}
