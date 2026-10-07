import { useCallback, useEffect, useRef, useState } from "react";
import { runExperienceTest } from "../../../api/experience-api.js";
import { testScript } from "../../../api/script-api.js";
import type { ScriptRecord } from "../../../api/types.js";
import { useT } from "../../../i18n/context.js";
import { isLocalId } from "./experience-local-helpers.js";

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
  readonly handleValidateRules: (warningAcknowledged?: boolean) => Promise<void>;
}

export function useExperienceRulesValidation({
  activeScript,
  activeScriptId,
}: UseExperienceRulesValidationInput): ExperienceRulesValidationState {
  // IR-90E: compact friendly validation result (reuses the wizard's pattern).
  const { t } = useT();
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

  // IR-90E: local drafts use stateless discovery; persisted scripts use the
  // script-aware test route so its import-warning acknowledgement is enforced.
  const handleValidateRules = useCallback(async (warningAcknowledged = false) => {
    if (!activeScript || activeScriptId === null || activeScript.code.trim() === "") return;
    const token = ++validationTokenRef.current;
    setValidating(true);
    setRulesValidationError(null);
    try {
      if (isLocalId(activeScriptId)) {
        await runExperienceTest({
          rulesCode: activeScript.code,
          settings: {},
          participants: [],
          capabilityGrants: [],
          actions: [],
        });
      } else {
        const result = await testScript(activeScriptId, { code: activeScript.code, warningAcknowledged });
        if (result.kind !== "interactive") {
          throw new Error(t("experience_setup_discovery_error"));
        }
        if (result.discoveryError !== null || result.definition === null) {
          throw new Error(result.discoveryError ?? t("experience_setup_discovery_error"));
        }
      }
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
  }, [activeScript?.code, activeScriptId, t]);

  return { rulesValid, rulesValidationError, validating, handleValidateRules };
}
