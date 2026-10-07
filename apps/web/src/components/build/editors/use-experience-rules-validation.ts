import { useCallback, useEffect, useRef, useState } from "react";
import { runExperienceTest } from "../../../api/experience-api.js";
import type { ScriptRecord } from "../../../api/types.js";

/**
 * The ExperienceEditor's token-guarded rules validation — an SS-7B2
 * extraction-only move out of ExperienceEditor.tsx (SCRIPT_SAFETY_PLAN):
 * state, the fail-closed reset effect, and the handler are preserved verbatim
 * (comments included). The monotonic stale-result guard survives the move
 * unchanged: changing the active script or its source invalidates every
 * in-flight validation so a stale promise can never set valid/invalid or
 * leave loading true after a switch/edit.
 */
export interface UseExperienceRulesValidationInput {
  /** The editor's active script view (server record + unsaved draft values),
   *  or null while the picker is shown (no active script). */
  readonly activeScript: ScriptRecord | null;
  /** The active script's id — switching scripts invalidates in-flight work. */
  readonly activeScriptId: string | null;
}

export interface ExperienceRulesValidationState {
  readonly rulesValid: boolean | null;
  readonly rulesValidationError: string | null;
  readonly validating: boolean;
  readonly handleValidateRules: () => Promise<void>;
}

export function useExperienceRulesValidation({
  activeScript,
  activeScriptId,
}: UseExperienceRulesValidationInput): ExperienceRulesValidationState {
  // IR-90E: compact friendly validation result (reuses the wizard's pattern).
  const [rulesValid, setRulesValid] = useState<boolean | null>(null);
  const [rulesValidationError, setRulesValidationError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);

  // IR-90E: monotonic validation token. Changing the active script or its
  // source invalidates every in-flight validation so a stale promise can
  // never set valid/invalid or leave loading true after a switch/edit.
  const validationTokenRef = useRef(0);

  // IR-90E: fail-closed validation — clear stale "valid" state AND loading
  // whenever the active script or its source code changes. The editor must
  // never show valid for a new or edited source without explicit re-validation.
  useEffect(() => {
    validationTokenRef.current += 1;
    setRulesValid(null);
    setRulesValidationError(null);
    setValidating(false);
  }, [activeScriptId, activeScript?.code]);

  // IR-90E: compact friendly rules validation (reuses the wizard's
  // runExperienceTest discovery pattern — same API, same presentation shape).
  const handleValidateRules = useCallback(async () => {
    if (!activeScript || activeScript.code.trim() === "") return;
    const token = ++validationTokenRef.current;
    setValidating(true);
    setRulesValidationError(null);
    try {
      await runExperienceTest({
        rulesCode: activeScript.code,
        settings: {},
        participants: [],
        capabilityGrants: [],
        actions: [],
      });
      if (validationTokenRef.current !== token) return;
      setRulesValid(true);
    } catch (error) {
      if (validationTokenRef.current !== token) return;
      setRulesValid(false);
      const msg = error instanceof Error ? error.message : String(error);
      setRulesValidationError(msg);
    } finally {
      if (validationTokenRef.current === token) {
        setValidating(false);
      }
    }
  }, [activeScript?.code]);

  return { rulesValid, rulesValidationError, validating, handleValidateRules };
}
