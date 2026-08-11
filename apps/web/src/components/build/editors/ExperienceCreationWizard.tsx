/**
 * ExperienceCreationWizard — the three-step NEW-experience creation flow
 * (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, IR-90C).
 *
 * Replaces the old all-in-one editor landing for NEW experiences with exactly
 * three visible steps — Describe → Rules → Appearance & Preview — so the author
 * is never dropped into one long unsaved form. The wizard is opened from the
 * ExperienceEditor's starter picker and persists NOTHING until the confirmed
 * Finish, at which point it creates BOTH resources (the interactive rules
 * script + the visual) and hands them back so the editor opens the new
 * experience exactly as if it always existed.
 *
 * Draft reuse (not reinvention): the wizard feeds the SAME shared draft stores
 * the editor uses (`useScriptDraftStore` + `useExperienceVisualDraftStore`),
 * seeds its buffers with the SAME empty-base-dirty trick, and saves through the
 * SAME API seams (`createScript` / `createExperienceVisual`). Starters, the
 * CodeMirror CodeEditor, ExperiencePreview, and
 * AiAssistantModal are all reused as-is — wired in, not duplicated.
 *
 * Hard invariants enforced here:
 *  - Exactly three step indicators (assertable count).
 *  - Step 1 → 2 requires a non-empty name.
 *  - Step 2 → 3 requires validated rules (discover succeeds); invalid rules
 *    block Step 3 with a visible reason, never a silent disable.
 *  - Back/Next/Cancel preserve drafts (the store is the single source of
 *    truth; navigation never touches it).
 *  - No persistence before Finish — `createScript` / `createExperienceVisual`
 *    fire ONLY on the Finish action.
 *  - Partial-failure recovery: if one create succeeds and the other fails, the
 *    successful one is rolled back (best-effort delete) so no orphaned
 *    half-created experience is left behind; the wizard stays open with ALL
 *    drafts intact and the error surfaced for a clean retry.
 *  - Trust model: the new rules are explicitly NOT trusted (enabled=false);
 *    trust/enable happens post-save in the normal editor flow — never here.
 *  - AI-helper is a TOOL inside Steps 2/3, never the first thing the user sees.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { Modal } from "../../shared/Modal.js";
import { DestructiveConfirmModal } from "../../shared/destructive-confirm-modal.js";
import { CodeEditor } from "../../shared/CodeEditor.js";
import { Ic } from "../../shared/icons.js";
import { inputCls, lblCls } from "../fields/field-styles.js";
import {
  useScriptDraftStore,
} from "../../../stores/script-draft-store.js";
import {
  useExperienceVisualDraftStore,
} from "../../../stores/experience-authoring-store.js";
import {
  RULES_STARTERS,
  rulesStarterToDraftValues,
  type RulesStarter,
} from "../../../lib/experience-rules-starters.js";
import {
  VISUAL_STARTERS,
  getVisualStarter,
  type VisualStarter,
} from "../../experience/starters/index.js";
import { ExperiencePreview } from "../../experience/ExperiencePreview.js";
import { AiAssistantModal } from "../../shared/AiAssistantModal.js";
import { createScript, deleteScript, updateScript } from "../../../api/script-api.js";
import { createExperienceVisual, runExperienceTest } from "../../../api/experience-api.js";
import {
  nextLocalId,
  PAIRED_VISUAL_STARTER_ID,
  pendingScriptRecord,
  pendingVisualRow,
  VISUAL_API_VERSION,
} from "./experience-local-helpers.js";
import type { ExperienceVisualRow, ScriptRecord } from "../../../api/types.js";

export interface ExperienceCreationWizardProps {
  /** The rules starter pre-selected from the picker (null = blank start). */
  readonly starter: RulesStarter | null;
  /** Called after the user cancels (drafts cleaned up). */
  readonly onClose: () => void;
  /** Called after BOTH resources are created; the editor opens the experience. */
  readonly onFinish: (script: ScriptRecord, visual: ExperienceVisualRow) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Step labels in order (1-indexed). */
const STEP_LABEL_KEYS = [
  "experience_wizard_step_describe",
  "experience_wizard_step_rules",
  "experience_wizard_step_appearance",
] as const;

export function ExperienceCreationWizard(props: ExperienceCreationWizardProps) {
  const { starter, onClose, onFinish } = props;
  const { t } = useT();
  const isMobile = useIsMobile();

  // ── Local draft ids (created once on mount) ──────────────────────────────
  const rulesLocalIdRef = useRef<string>("");
  const visualLocalIdRef = useRef<string>("");
  const seededRef = useRef(false);

  // ── Wizard state ─────────────────────────────────────────────────────────
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [rulesValid, setRulesValid] = useState<boolean | null>(null);
  const [rulesValidationError, setRulesValidationError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [aiHelperOpen, setAiHelperOpen] = useState(false);
  const [visualAiHelperOpen, setVisualAiHelperOpen] = useState(false);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const [selectedVisualStarterId, setSelectedVisualStarterId] = useState<string>("");

  // ── Draft store hooks ────────────────────────────────────────────────────
  const scriptDrafts = useScriptDraftStore((s) => s.drafts);
  const ensureScriptDraft = useScriptDraftStore((s) => s.ensure);
  const patchScriptDraft = useScriptDraftStore((s) => s.patch);
  const removeScriptDraft = useScriptDraftStore((s) => s.remove);

  const visualDrafts = useExperienceVisualDraftStore((s) => s.drafts);
  const ensureVisualDraft = useExperienceVisualDraftStore((s) => s.ensure);
  const patchVisualDraft = useExperienceVisualDraftStore((s) => s.patch);
  const removeVisualDraft = useExperienceVisualDraftStore((s) => s.remove);

  // ── Seed the pending drafts once on mount ────────────────────────────────
  // Same empty-base-dirty trick as the editor: the base is seeded EMPTY so the
  // buffer starts dirty (nothing persisted) and the trust invariant stays
  // fail-closed (code != base.code until saved + reviewed).
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;

    const rulesId = nextLocalId("rules");
    rulesLocalIdRef.current = rulesId;
    const rulesValues = starter
      ? rulesStarterToDraftValues(starter)
      : {
          name: t("experience_editor_untitled_rules"),
          description: "",
          code: "",
          scriptKind: "interactive" as const,
          enabled: false as const,
        };
    const rulesRecord = pendingScriptRecord(rulesId, rulesValues);
    ensureScriptDraft({ ...rulesRecord, name: "", description: "", code: "" });
    patchScriptDraft(rulesId, rulesValues);

    const visualId = nextLocalId("visual");
    visualLocalIdRef.current = visualId;
    const pairedVisualId = starter ? PAIRED_VISUAL_STARTER_ID[starter.id] ?? "blank" : "blank";
    const visualStarter = getVisualStarter(pairedVisualId);
    const visualValues = {
      name: visualStarter?.label ?? "",
      source: visualStarter?.source ?? "",
      apiVersion: VISUAL_API_VERSION,
      compatibleManifestIds: starter ? [starter.id] : [],
    };
    const visualRecord = pendingVisualRow(visualId, visualValues);
    ensureVisualDraft({ ...visualRecord, name: "", source: "", compatibleManifestIds: [] });
    patchVisualDraft(visualId, visualValues);
    setSelectedVisualStarterId(pairedVisualId);
  }, [starter, t, ensureScriptDraft, patchScriptDraft, ensureVisualDraft, patchVisualDraft]);

  const rulesLocalId = rulesLocalIdRef.current;
  const visualLocalId = visualLocalIdRef.current;

  const rulesDraft = rulesLocalId ? scriptDrafts[rulesLocalId] ?? null : null;
  const rulesValues = rulesDraft?.values ?? null;
  const visualDraft = visualLocalId ? visualDrafts[visualLocalId] ?? null : null;
  const visualValues = visualDraft?.values ?? null;

  const updateRules = useCallback((patch: Partial<ScriptRecord>) => {
    if (!rulesLocalId) return;
    patchScriptDraft(rulesLocalId, patch);
  }, [rulesLocalId, patchScriptDraft]);

  const updateVisual = useCallback((patch: Partial<{ name: string; source: string; apiVersion: number; compatibleManifestIds: string[] }>) => {
    if (!visualLocalId) return;
    patchVisualDraft(visualLocalId, patch);
  }, [visualLocalId, patchVisualDraft]);

  // ── Step 2: rules starter pick ───────────────────────────────────────────
  const handlePickRulesStarter = useCallback((picked: RulesStarter) => {
    updateRules({ code: picked.source });
    // Editing the code invalidates the previous validation result.
    setRulesValid(null);
    setRulesValidationError(null);
  }, [updateRules]);

  // ── Step 2: rules validation (discover-only run via the same tester API) ──
  const handleValidateRules = useCallback(async () => {
    if (!rulesValues || rulesValues.code.trim() === "") {
      setRulesValid(false);
      setRulesValidationError(t("experience_wizard_rules_empty"));
      return;
    }
    setValidating(true);
    setRulesValidationError(null);
    try {
      await runExperienceTest({
        rulesCode: rulesValues.code,
        settings: {},
        participants: [],
        capabilityGrants: [],
        actions: [],
      });
      setRulesValid(true);
    } catch (error) {
      setRulesValid(false);
      setRulesValidationError(errorMessage(error));
    } finally {
      setValidating(false);
    }
  }, [rulesValues, t]);

  // ── Step 3: visual starter pick ──────────────────────────────────────────
  const handlePickVisualStarter = useCallback((picked: VisualStarter) => {
    updateVisual({ name: picked.label, source: picked.source });
    setSelectedVisualStarterId(picked.id);
  }, [updateVisual]);

  // ── Navigation gates ─────────────────────────────────────────────────────
  const nameValid = !!rulesValues && rulesValues.name.trim() !== "";
  const canAdvanceStep1 = nameValid;
  const canAdvanceStep2 = rulesValid === true;

  const handleNext = useCallback(() => {
    if (step === 1 && canAdvanceStep1) setStep(2);
    else if (step === 2 && canAdvanceStep2) setStep(3);
  }, [step, canAdvanceStep1, canAdvanceStep2]);

  const handleBack = useCallback(() => {
    if (step === 2) setStep(1);
    else if (step === 3) setStep(2);
  }, [step]);

  // ── Cancel (confirm-on-cancel: drafts are always dirty) ──────────────────
  const handleCancelClick = useCallback(() => {
    setConfirmCancelOpen(true);
  }, []);

  const confirmCancel = useCallback(() => {
    if (rulesLocalId) removeScriptDraft(rulesLocalId);
    if (visualLocalId) removeVisualDraft(visualLocalId);
    setConfirmCancelOpen(false);
    onClose();
  }, [rulesLocalId, visualLocalId, removeScriptDraft, removeVisualDraft, onClose]);

  // ── Finish: create BOTH resources (atomic with rollback) ─────────────────
  const handleFinish = useCallback(async () => {
    if (!rulesValues || !visualValues) return;
    setFinishing(true);
    setFinishError(null);

    let createdScript: ScriptRecord | null = null;
    try {
      createdScript = await createScript({
        name: rulesValues.name,
        description: rulesValues.description,
        code: rulesValues.code,
        scriptKind: "interactive",
        enabled: false,
        scopeType: "global",
      });
    } catch (scriptError) {
      setFinishError(errorMessage(scriptError));
      setFinishing(false);
      return;
    }

    let createdVisual: ExperienceVisualRow;
    try {
      createdVisual = await createExperienceVisual({
        name: visualValues.name,
        source: visualValues.source,
        apiVersion: visualValues.apiVersion,
        compatibleManifestIds: visualValues.compatibleManifestIds,
        scopeType: "global",
      });
    } catch (visualError) {
      // Partial failure: the rules script was created but the visual was not.
      // Roll back the orphaned script (best-effort) so no half-created
      // experience is left behind. Keep ALL drafts intact and surface the error
      // so the user can retry Finish without losing anything.
      if (createdScript) {
        try { await deleteScript(createdScript.id); } catch { /* best-effort rollback */ }
      }
      setFinishError(errorMessage(visualError));
      setFinishing(false);
      return;
    }

    // Persist the script↔visual pairing as the experience's default visual so
    // ExperienceAssignment auto-applies it (no re-binding per chat). Best-effort:
    // both assets already exist and are usable, so a link failure only means the
    // pairing isn't remembered — the editor still works.
    let linkedScript = createdScript;
    try {
      linkedScript = await updateScript(createdScript.id, { defaultVisualId: createdVisual.id });
    } catch (linkError) {
      console.warn("experience: default-visual link failed", linkError);
    }

    // Migrate the local drafts to the real server rows and hand back to the
    // editor. The drafts are replaced (not just removed) so the editor's
    // ensure-draft effect sees clean bases for the new ids.
    if (rulesLocalId) removeScriptDraft(rulesLocalId);
    if (visualLocalId) removeVisualDraft(visualLocalId);
    ensureScriptDraft(linkedScript);
    ensureVisualDraft(createdVisual);
    setFinishing(false);
    onFinish(linkedScript, createdVisual);
  }, [rulesValues, visualValues, rulesLocalId, visualLocalId, removeScriptDraft, removeVisualDraft, ensureScriptDraft, ensureVisualDraft, onFinish]);

  // ── Visual preview starter (edited source + selected starter's fixtures) ──
  const previewVisualStarter: VisualStarter | null = (() => {
    const base = getVisualStarter(selectedVisualStarterId);
    if (!base || !visualValues) return null;
    return {
      ...base,
      label: visualValues.name || base.label,
      source: visualValues.source,
    };
  })();

  // ── Render ───────────────────────────────────────────────────────────────
  const stepIndicators = (
    <div className="flex items-center justify-center gap-2 sm:gap-4" role="tablist" aria-label={t("experience_wizard_steps_label")}>
      {STEP_LABEL_KEYS.map((labelKey, i) => {
        const stepNum = i + 1;
        const isActive = stepNum === step;
        const isDone = stepNum < step;
        return (
          <div
            key={stepNum}
            data-testid="wizard-step-indicator"
            className="flex items-center gap-1.5"
            role="tab"
            aria-selected={isActive}
            aria-current={isActive ? "step" : undefined}
          >
            <div
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold transition-all",
                isActive ? "bg-accent text-on-accent" : isDone ? "bg-accent/50 text-on-accent" : "bg-s3 text-t3",
              )}
            >
              {stepNum}
            </div>
            <span className={cn("font-ui text-[11px] transition-colors", isActive ? "text-t1 font-medium" : "text-t3")}>
              {t(labelKey)}
            </span>
          </div>
        );
      })}
    </div>
  );

  const footer = (
    <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-3 sm:px-6">
      <button
        type="button"
        className="cursor-pointer rounded-lg border border-border bg-transparent px-4 py-2 font-ui text-[13px] text-t3 transition-colors hover:text-t1"
        onClick={handleCancelClick}
      >
        {t("cancel")}
      </button>
      <div className="flex items-center gap-2">
        {step > 1 && (
          <button
            type="button"
            className="cursor-pointer rounded-lg border border-border bg-transparent px-4 py-2 font-ui text-[13px] text-t2 transition-colors hover:text-t1"
            onClick={handleBack}
          >
            {t("back")}
          </button>
        )}
        {step < 3 ? (
          <button
            type="button"
            className="cursor-pointer rounded-lg border-0 bg-accent px-5 py-2 font-ui text-[13px] font-semibold text-on-accent transition-all disabled:cursor-default disabled:opacity-40"
            disabled={step === 1 ? !canAdvanceStep1 : !canAdvanceStep2}
            onClick={handleNext}
          >
            {t("next")}
          </button>
        ) : (
          <button
            type="button"
            className="cursor-pointer rounded-lg border-0 bg-accent px-5 py-2 font-ui text-[13px] font-semibold text-on-accent transition-all disabled:cursor-default disabled:opacity-40"
            disabled={finishing}
            onClick={() => void handleFinish()}
          >
            {finishing ? t("experience_wizard_finishing") : t("experience_wizard_finish")}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <Modal open={true} onClose={handleCancelClick} title={t("experience_wizard_title")} description={t("experience_wizard_title")}>
      <div className={cn(
        "flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-theme-lg",
        isMobile ? "w-full h-full rounded-none" : "w-[min(680px,94vw)] max-h-[88vh]",
      )}>
        {/* Header: title + step indicators */}
        <div className="shrink-0 border-b border-border px-4 py-4 text-center sm:px-6">
          <div className="mb-3 font-ui text-[16px] font-bold text-t1">{t("experience_wizard_title")}</div>
          {stepIndicators}
        </div>

        {/* Scrollable step content */}
        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          {/* ── Step 1: Describe ── */}
          {step === 1 && rulesValues && (
            <div className="flex flex-col gap-4">
              <div>
                <label className={cn(lblCls, "mb-1.5")}>{t("experience_wizard_name_label")}</label>
                <input
                  className={cn(inputCls, "text-[15px] font-semibold")}
                  type="text"
                  value={rulesValues.name}
                  aria-label={t("experience_wizard_name_label")}
                  onChange={(e) => updateRules({ name: e.target.value })}
                  placeholder={t("experience_wizard_name_placeholder")}
                  autoFocus
                />
                {!nameValid && (
                  <p className="mt-1.5 font-ui text-[11px] text-t3">{t("experience_wizard_name_required")}</p>
                )}
              </div>
              <div>
                <label className={cn(lblCls, "mb-1.5")}>{t("experience_wizard_desc_label")}</label>
                <input
                  className={inputCls}
                  type="text"
                  value={rulesValues.description}
                  aria-label={t("experience_wizard_desc_label")}
                  onChange={(e) => updateRules({ description: e.target.value })}
                  placeholder={t("experience_wizard_desc_placeholder")}
                />
              </div>
              {starter && (
                <div className="rounded-md border border-border bg-s2 px-3 py-2 font-ui text-[12px] text-t3">
                  {t("experience_wizard_starter_hint")}: <span className="text-t1 font-medium">{starter.label}</span>
                </div>
              )}
            </div>
          )}

          {/* ── Step 2: Rules ── */}
          {step === 2 && rulesValues && (
            <div className="flex flex-col gap-3">
              {/* Rules starter chips */}
              <div>
                <label className={cn(lblCls, "mb-1.5")}>{t("experience_wizard_rules_starter_label")}</label>
                <div className="flex flex-wrap gap-1.5">
                  {RULES_STARTERS.map((s) => (
                    <button
                      type="button"
                      key={s.id}
                      className={cn(
                        "flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 font-ui text-[11px] transition-all",
                        s.id === starter?.id
                          ? "border-accent bg-accent-dim text-accent-t"
                          : "border-border bg-s3 text-t2 hover:bg-s2 hover:text-t1",
                      )}
                      onClick={() => handlePickRulesStarter(s)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Toolbar: AI helper + validate */}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1"
                  onClick={() => setAiHelperOpen(true)}
                >
                  <Ic.brain /> {t("experience_editor_ai_helper")}
                </button>
                <button
                  type="button"
                  className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-accent px-3 font-ui text-[11px] font-medium text-on-accent transition-all disabled:cursor-default disabled:opacity-40"
                  disabled={validating}
                  onClick={() => void handleValidateRules()}
                >
                  {validating ? t("experience_wizard_validating") : t("experience_wizard_validate")}
                </button>
                {rulesValid === true && (
                  <span className="font-ui text-[11px] text-success">{t("experience_wizard_rules_valid")}</span>
                )}
              </div>

              {/* Rules source editor */}
              <div>
                <label className={cn(lblCls, "mb-1.5")}>{t("script_code_label")}</label>
                <div className="relative rounded-md border border-border bg-bg">
                  <CodeEditor
                    value={rulesValues.code}
                    onChange={(code) => {
                      updateRules({ code });
                      setRulesValid(null);
                      setRulesValidationError(null);
                    }}
                    minHeight="240px"
                    scrollMode="inner"
                  />
                </div>
              </div>

              {/* Validation result (visible reason for gating) */}
              {rulesValid === false && rulesValidationError && (
                <div className="rounded-md border border-danger bg-danger-dim px-3 py-2 font-mono text-[11px] leading-relaxed text-danger-text">
                  {t("experience_wizard_rules_invalid")}: {rulesValidationError}
                </div>
              )}
              {rulesValid === null && (
                <div className="font-ui text-[11px] italic text-t3">{t("experience_wizard_rules_not_validated")}</div>
              )}

              {/* Trust note: the new rules are NOT trusted until saved + reviewed */}
              <div className="flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning-dim/30 px-3 py-1.5 font-ui text-[11px] leading-[1.4] text-t3">
                <Ic.terminal />
                <span>{t("experience_wizard_trust_note")}</span>
              </div>

              {/* IR-90E: the full raw tester is NOT embedded in the wizard flow —
                  only the compact friendly validation result above. The tester
                  is available in the saved editor after creation. */}
            </div>
          )}

          {/* ── Step 3: Appearance & Preview ── */}
          {step === 3 && visualValues && rulesValues && (
            <div className="flex flex-col gap-3">
              {/* Visual starter chips */}
              <div>
                <label className={cn(lblCls, "mb-1.5")}>{t("experience_wizard_visual_starter_label")}</label>
                <div className="flex flex-wrap gap-1.5">
                  {VISUAL_STARTERS.map((s) => (
                    <button
                      type="button"
                      key={s.id}
                      className={cn(
                        "flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 font-ui text-[11px] transition-all",
                        s.id === selectedVisualStarterId
                          ? "border-accent bg-accent-dim text-accent-t"
                          : "border-border bg-s3 text-t2 hover:bg-s2 hover:text-t1",
                      )}
                      onClick={() => handlePickVisualStarter(s)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Visual name */}
              <div>
                <input
                  className={inputCls}
                  type="text"
                  value={visualValues.name}
                  aria-label={t("experience_editor_visual_name_ph")}
                  onChange={(e) => updateVisual({ name: e.target.value })}
                  placeholder={t("experience_editor_visual_name_ph")}
                />
              </div>

              {/* Toolbar: visual AI helper (disabled without rules source) */}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
                  disabled={!rulesValues.code.trim()}
                  onClick={() => setVisualAiHelperOpen(true)}
                >
                  <Ic.brain /> {t("experience_editor_visual_ai_helper")}
                </button>
                {!rulesValues.code.trim() && (
                  <span className="font-ui text-[11px] italic text-t3">{t("experience_editor_visual_ai_helper_no_rules")}</span>
                )}
              </div>

              {/* Visual source editor */}
              <div>
                <label className={cn(lblCls, "mb-1.5")}>{t("experience_editor_visual_source_label")}</label>
                <div className="relative rounded-md border border-border bg-bg">
                  <CodeEditor
                    value={visualValues.source}
                    onChange={(source) => updateVisual({ source })}
                    minHeight="180px"
                    scrollMode="inner"
                  />
                </div>
              </div>

              {/* Isolated preview (ExperiencePreview — never forwards actions) */}
              <div>
                <label className={cn(lblCls, "mb-1.5")}>{t("experience_wizard_preview_label")}</label>
                {previewVisualStarter ? (
                  <ExperiencePreview starter={previewVisualStarter} />
                ) : (
                  <div className="py-4 text-center font-ui text-[12px] italic text-t3">{t("experience_editor_visual_none")}</div>
                )}
              </div>

              {finishError && (
                <div className="rounded-md border border-danger bg-danger-dim px-3 py-2 font-ui text-[12px] text-danger-text">
                  {t("experience_wizard_finish_error")}: {finishError}
                </div>
              )}
            </div>
          )}
        </div>

        {footer}
      </div>

      {/* ── AI helpers (tools inside steps, never the entry) ── */}
      <AiAssistantModal
        mode="full"
        apiMode="interactive_rules"
        isOpen={aiHelperOpen}
        onClose={() => setAiHelperOpen(false)}
        existingContent={rulesValues?.code ?? ""}
        onInsert={(text) => { updateRules({ code: text }); setRulesValid(null); }}
        onReplace={(text) => { updateRules({ code: text }); setRulesValid(null); }}
      />
      <AiAssistantModal
        mode="full"
        apiMode="interactive_visual"
        isOpen={visualAiHelperOpen}
        onClose={() => setVisualAiHelperOpen(false)}
        existingContent={visualValues?.source ?? ""}
        interactiveRulesSource={rulesValues?.code ?? ""}
        onInsert={(text) => updateVisual({ source: text })}
        onReplace={(text) => updateVisual({ source: text })}
      />

      {/* ── Cancel confirm (drafts are always dirty in the wizard) ── */}
      {confirmCancelOpen && (
        <DestructiveConfirmModal
          title={t("experience_wizard_cancel_title")}
          body={t("experience_wizard_cancel_body")}
          confirmLabel={t("experience_wizard_cancel_confirm")}
          onConfirm={confirmCancel}
          onCancel={() => setConfirmCancelOpen(false)}
        />
      )}
    </Modal>
  );
}
