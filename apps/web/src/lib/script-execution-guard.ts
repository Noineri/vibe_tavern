import { analyzeScriptSource, type ScriptSafetyFinding } from "@vibe-tavern/domain/script-safety";
import type { ScriptRecord } from "../api/types.js";

export type ScriptSafetyWarningIntent = "enable" | "test";
export type ScriptExecutionIntent = "automatic" | "explicit";

export type ScriptSafetyWarningFlow =
  | { kind: "none"; warningAcknowledged: boolean }
  | { kind: "plain" }
  | { kind: "findings"; findings: readonly ScriptSafetyFinding[]; showHonestWarning: boolean };

export interface ScriptSafetyWarningFlowInput {
  script: Pick<ScriptRecord, "origin" | "firstEnabledAt"> | null;
  code: string;
  kind: ScriptRecord["scriptKind"];
  /** `null` means settings are still loading, so the warning fails open. */
  suppressImportWarnings: boolean | null;
}

export interface ScriptExecutionGuardInput extends ScriptSafetyWarningFlowInput {
  intent: ScriptExecutionIntent;
}

/** The shared localized state rendered when an untrusted import cannot run automatically. */
export const SCRIPT_SAFETY_AUTO_SKIP_MESSAGE_KEY = "script_safety_checks_after_enabling";
export const SCRIPT_SAFETY_AUTO_SKIP_STATE = {
  kind: "skip-auto",
  messageKey: SCRIPT_SAFETY_AUTO_SKIP_MESSAGE_KEY,
} as const;

export type ScriptExecutionGuardDecision =
  | { kind: "ok"; warningAcknowledged: boolean }
  | { kind: "warn"; flow: Exclude<ScriptSafetyWarningFlow, { kind: "none" }> }
  | typeof SCRIPT_SAFETY_AUTO_SKIP_STATE;

/** Imported scripts become trusted exactly once: on their first explicit enable. */
export function isUntrustedImport(script: Pick<ScriptRecord, "origin" | "firstEnabledAt"> | null): boolean {
  return script !== null && script.origin === "imported" && script.firstEnabledAt === null;
}

/** Findings that require the unsilenceable imported-script modal. */
export function blockingFindings(findings: readonly ScriptSafetyFinding[]): ScriptSafetyFinding[] {
  return findings.filter((finding) => finding.severity === "warning" || finding.severity === "critical");
}

/**
 * Existing explicit warning flow: findings take precedence over the plain
 * warning, and suppressed clean untrusted imports carry the server acknowledgement.
 */
export function scriptSafetyWarningFlow(input: ScriptSafetyWarningFlowInput): ScriptSafetyWarningFlow {
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

/**
 * Single dispatch point for every web script execution request.
 * Automatic work never executes an untrusted import; explicit work preserves
 * the existing modal flow, with a suppressed clean warning acknowledging the request.
 */
export function scriptExecutionGuard(input: ScriptExecutionGuardInput): ScriptExecutionGuardDecision {
  if (input.intent === "automatic") {
    return isUntrustedImport(input.script)
      ? SCRIPT_SAFETY_AUTO_SKIP_STATE
      : { kind: "ok", warningAcknowledged: false };
  }

  const flow = scriptSafetyWarningFlow(input);
  return flow.kind === "none"
    ? { kind: "ok", warningAcknowledged: flow.warningAcknowledged }
    : { kind: "warn", flow };
}
