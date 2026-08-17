/**
 * ExperienceEditor — the global Build-surface authoring editor for interactive
 * experiences (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 8 / IR-81C).
 *
 * This is the AUTHORING counterpart of the ScriptEditor (prompt/dice) and the
 * counterpart activation surface is Chat Add-ons (`ExperienceAssignment`) —
 * this panel never activates anything; it only creates/edits/saves/duplicates
 * interactive rules scripts and their independent visuals.
 *
 * What an author gets:
 *  - A blank "create new" entry that persists a fresh EMPTY script immediately
 *    and opens the editor in CREATION MODE (ER-13d-2a). Step 1 offers the five
 *    frozen rules starters (IR-81A `RULES_STARTERS`) as a template picker that
 *    fills the existing buffer; step 2 highlights the PAIRED visual starter
 *    (Round ↔ Choice, Board ↔ Grid/Board, Card ↔ Card Table, Model
 *    Conversation ↔ Conversation, Blank ↔ Blank) (ER-13d-2b). Rules and
 *    visuals remain two independent buffers with two independent saves.
 *  - Explicit-save editing: rules edits live in `useScriptDraftStore`
 *    (scriptKind "interactive"), visual edits in `useExperienceVisualDraftStore`.
 *    Typing never hits the server; Save creates (first save) or patches
 *    (later saves) exactly one snapshot; a failed save keeps the buffer dirty
 *    and retryable; edits made mid-save survive the reconciliation.
 *  - The IR-81A interactive trust model, surfaced: interactive rules execute
 *    with host permissions, so `enabled` is an exact-source trust signal. A
 *    changed (or never-saved) source renders as "Not trusted" and the enable
 *    toggle stays LOCKED — enabling only succeeds when the visible source is
 *    exactly the saved one. The store already forces `enabled = false` on any
 *    code change; this UI makes that invariant visible and never silently
 *    auto-enables.
 *  - Duplication: from a starter (the picker) or from the current buffer
 *    (rules via `duplicateRulesValues`, visuals via `duplicateVisualDraftValues`)
 *    — always a fresh, explicitly untrusted copy; the source is never mutated.
 *  - The package contract at hand via `InteractiveApiReference`.
 *
 * IR-81D: the stateless InteractiveTester drives the unsaved rules buffer
 * through POST /api/experience/test/run|simulate as a read-only diagnostic
 * (it never mutates these drafts or any store). It now mounts inside the
 * copilot shell's Tester modal (IR-13c), not inline below the rules editor.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useKeyDown } from "../../../hooks/use-key-down.js";
import { Ic } from "../../shared/icons.js";
import { EmptyState } from "../../shared/empty-state.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { AnimatedDisclosure } from "../../shared/AnimatedDisclosure.js";
import { DropdownSelect } from "../../shared/DropdownSelect.js";
import { SaveButton } from "../../shared/SaveBar.js";
import { Toggle } from "../../shared/Toggle.js";
import { inputCls } from "../fields/field-styles.js";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import {
  isScriptDraftDirty,
  useScriptDraftStore,
  type ScriptDraftValues,
} from "../../../stores/script-draft-store.js";
import {
  isExperienceVisualDraftDirty,
  useExperienceVisualDraftStore,
  type ExperienceVisualDraftValues,
} from "../../../stores/experience-authoring-store.js";
import {
  RULES_STARTERS,
  duplicateRulesValues,
  type InteractiveRulesDraftValues,
  type RulesStarter,
} from "../../../lib/experience-rules-starters.js";
import { VISUAL_STARTERS, getVisualStarter, type VisualStarter } from "../../experience/starters/index.js";
import { bindScriptVisual, createScript, deleteScript, getScriptVisuals, listAllScripts, unbindScriptVisual, updateScript } from "../../../api/script-api.js";
import {
  createExperienceVisual,
  deleteExperienceVisual,
  listExperienceVisuals,
  runExperienceTest,
  updateExperienceVisual,
} from "../../../api/experience-api.js";
import type { ExperienceVisualRow, ScriptRecord } from "../../../api/types.js";
import { InteractiveApiReference } from "./interactive-api-reference.js";
import { VisualApiReference } from "./visual-api-reference.js";
import { DestructiveConfirmModal } from "../../shared/destructive-confirm-modal.js";
import {
  isLocalId,
  nextLocalId,
  PAIRED_VISUAL_STARTER_ID,
  pendingScriptRecord,
  pendingVisualRow,
  VISUAL_API_VERSION,
} from "./experience-local-helpers.js";
import { ExperienceCopilotShell, type ExperienceCopilotStep } from "./copilot/ExperienceCopilotShell.js";
import { ExperienceVisualBinding } from "./ExperienceVisualBinding.js";
import { ExperienceCardPreview } from "./ExperienceCardPreview.js";

function draftValuesEqual(a: ScriptDraftValues, b: ScriptDraftValues): boolean {
  return a.name === b.name
    && a.description === b.description
    && a.code === b.code
    && a.enabled === b.enabled
    && a.scriptKind === b.scriptKind;
}

function visualValuesEqual(a: ExperienceVisualDraftValues, b: ExperienceVisualDraftValues): boolean {
  return a.name === b.name
    && a.source === b.source
    && a.apiVersion === b.apiVersion
    && a.compatibleManifestIds.length === b.compatibleManifestIds.length
    && a.compatibleManifestIds.every((id, index) => id === b.compatibleManifestIds[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** XU-6 creation stepper: the authoring order the shell reports (rules →
 *  appearance → try). */
const CREATION_STEP_ORDER: readonly ExperienceCopilotStep[] = ["rules", "appearance", "try"];

// ── Component ──────────────────────────────────────────────────────────────

export function ExperienceEditor() {
  const { t } = useT();

  // ── Lists (server rows + unsaved local buffers) ──────────────────────────
  const [scripts, setScripts] = useState<ScriptRecord[]>([]);
  const [visuals, setVisuals] = useState<ExperienceVisualRow[]>([]);
  const [boundVisuals, setBoundVisuals] = useState<Record<string, ExperienceVisualRow[]>>({});
  const [pendingScripts, setPendingScripts] = useState<ScriptRecord[]>([]);
  const [pendingVisuals, setPendingVisuals] = useState<ExperienceVisualRow[]>([]);
  const [listsFailed, setListsFailed] = useState(false);

  const [activeScriptId, setActiveScriptId] = useState<string | null>(null);
  const [activeVisualId, setActiveVisualId] = useState<string | null>(null);
  const [apiRefOpen, setApiRefOpen] = useState(false);
  const [visualApiRefOpen, setVisualApiRefOpen] = useState(false);
  // IR-90E: compact friendly validation result (reuses the wizard's pattern).
  const [rulesValid, setRulesValid] = useState<boolean | null>(null);
  const [rulesValidationError, setRulesValidationError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);

  // IR-90A: explicit destructive delete for a saved/pending visual, confirmed
  // via the shared DestructiveConfirmModal. A failed delete keeps the visual
  // and surfaces the error (never silently dropped).
  const [visualDeleteId, setVisualDeleteId] = useState<string | null>(null);
  const [visualDeleteError, setVisualDeleteError] = useState<string | null>(null);

  // IR-90A: explicit destructive delete for the ACTIVE rules script (the
  // experience's identity). Dual-action confirm mirrors chat message deletion:
  // the primary deletes BOTH the script and the active visual; the secondary
  // ("rules only") deletes just the script. A failed delete surfaces the error
  // and keeps what it can (never silently dropped). Reachable only for a saved
  // (non-local) script — an unsaved draft is discarded by navigating back.
  const [experienceDeleteOpen, setExperienceDeleteOpen] = useState(false);

  // ER-13d-2a: persist-on-create. The "create" entry persists a fresh script
  // (enabled=false) immediately, so a server id exists from step 1 and the
  // copilot is iterative. A failed create surfaces a transient banner — never
  // silently dropped.
  const [createError, setCreateError] = useState<string | null>(null);
  // The just-created script id — drives the shell's CREATION MODE (3-position
  // [Rules|Visual|Sandbox] toggle). Cleared on navigating back so re-opening
  // the same script later is EDITING mode (2-position toggle).
  const [creatingScriptId, setCreatingScriptId] = useState<string | null>(null);
  // ER-13d-2b: the rules starter id chosen in step 1 (creation rules template
  // picker). Drives the paired-visual highlight in step 2. Cleared on
  // navigating back so a later creation starts fresh.
  const [chosenRulesStarterId, setChosenRulesStarterId] = useState<string | null>(null);

  // XU-6: the creation stepper's active step (reported by the shell as the
  // user moves between Rules / Appearance / Try).
  const [activeStep, setActiveStep] = useState<ExperienceCopilotStep>("rules");
  const handleStepChange = useCallback((step: ExperienceCopilotStep) => setActiveStep(step), []);
  // XU-6: the visual toolbar's collapsed "Technical details" accordion.
  const [visualTechOpen, setVisualTechOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listAllScripts(),
      listExperienceVisuals({ scopeType: "global" }),
    ])
      .then(async ([allScripts, globalVisuals]) => {
        if (cancelled) return;
        const interactive = allScripts.filter((s) => s.scriptKind === "interactive");
        setScripts(interactive);
        setVisuals(globalVisuals);
        // Bound visuals per experience (BE-6 junction) drive the card pills.
        const boundEntries = await Promise.all(
          interactive.map(async (s) => [s.id, await getScriptVisuals(s.id).catch(() => [] as ExperienceVisualRow[])] as const),
        );
        if (cancelled) return;
        setBoundVisuals(Object.fromEntries(boundEntries));
      })
      .catch(() => { if (!cancelled) setListsFailed(true); });
    return () => { cancelled = true; };
  }, []);

  // ── Draft stores (rules: script-draft-store; visual: experience-authoring) ──
  const scriptDrafts = useScriptDraftStore((s) => s.drafts);
  const ensureScriptDraft = useScriptDraftStore((s) => s.ensure);
  const patchScriptDraft = useScriptDraftStore((s) => s.patch);
  const prepareScriptSave = useScriptDraftStore((s) => s.prepareSave);
  const completeScriptSave = useScriptDraftStore((s) => s.completeSave);
  const failScriptSave = useScriptDraftStore((s) => s.failSave);
  const removeScriptDraft = useScriptDraftStore((s) => s.remove);

  const visualDrafts = useExperienceVisualDraftStore((s) => s.drafts);
  const ensureVisualDraft = useExperienceVisualDraftStore((s) => s.ensure);
  const patchVisualDraft = useExperienceVisualDraftStore((s) => s.patch);
  const prepareVisualSave = useExperienceVisualDraftStore((s) => s.prepareSave);
  const completeVisualSave = useExperienceVisualDraftStore((s) => s.completeSave);
  const failVisualSave = useExperienceVisualDraftStore((s) => s.failSave);
  const removeVisualDraft = useExperienceVisualDraftStore((s) => s.remove);

  const allScripts = [...scripts, ...pendingScripts];
  const allVisuals = [...visuals, ...pendingVisuals];

  // BE-6: bind/unbind a visual on an experience card, then refresh the bound set.
  const handleToggleVisual = useCallback(async (scriptId: string, visualId: string, bind: boolean) => {
    try {
      if (bind) await bindScriptVisual(scriptId, visualId);
      else await unbindScriptVisual(scriptId, visualId);
      const refreshed = await getScriptVisuals(scriptId);
      setBoundVisuals((prev) => ({ ...prev, [scriptId]: refreshed }));
    } catch (err) {
      console.warn("experience visual bind/unbind failed", err);
    }
  }, []);

  // ER-18b: opening a mini-app auto-selects its FIRST bound visual, so the
  // editor starts on the already-bound visual instead of an empty one the user
  // then has to swap for the bound one.
  const openScript = useCallback((scriptId: string) => {
    setActiveScriptId(scriptId);
    const bound = boundVisuals[scriptId] ?? [];
    const firstExisting = bound.find((v) => visuals.some((av) => av.id === v.id));
    setActiveVisualId(firstExisting?.id ?? null);
  }, [boundVisuals, visuals]);

  // Backfill for the rare case where the bound set arrives AFTER the script was
  // opened (fast click before the per-script fetch resolved): fill the first
  // bound visual once it is known, as long as nothing else has been selected.
  useEffect(() => {
    if (!activeScriptId || isLocalId(activeScriptId)) return;
    if (activeVisualId !== null) return;
    const bound = boundVisuals[activeScriptId];
    if (!bound || bound.length === 0) return;
    const first = bound.find((v) => visuals.some((av) => av.id === v.id));
    if (first) setActiveVisualId(first.id);
  }, [activeScriptId, activeVisualId, boundVisuals, visuals]);

  // Keep clean draft bases in sync with freshly loaded server rows; dirty
  // buffers are preserved by the stores themselves (IR-81A semantics).
  useEffect(() => {
    for (const script of allScripts) ensureScriptDraft(script);
  });
  useEffect(() => {
    for (const visual of allVisuals) ensureVisualDraft(visual);
  });

  // ── Active rules draft ───────────────────────────────────────────────────
  const activeScriptRecord = allScripts.find((s) => s.id === activeScriptId) ?? null;
  const activeScriptDraft = activeScriptId ? scriptDrafts[activeScriptId] ?? null : null;
  const activeScript = activeScriptRecord
    ? { ...activeScriptRecord, ...(activeScriptDraft?.values ?? {}) }
    : null;
  const isNewScript = activeScriptId !== null && isLocalId(activeScriptId);
  const scriptDirty = isNewScript || isScriptDraftDirty(activeScriptDraft);
  const scriptSaveState = activeScriptDraft?.saveState ?? "idle";
  // ER-13d-2a: creation mode is transient + session-scoped for the just-created
  // script (server id). Cleared on navigating back to the picker.
  const creationMode = creatingScriptId !== null && activeScriptId === creatingScriptId;

  const updateScriptDraft = (patch: Partial<ScriptDraftValues>) => {
    if (!activeScriptRecord) return;
    ensureScriptDraft(activeScriptRecord);
    patchScriptDraft(activeScriptRecord.id, patch);
  };

  // ── Active visual draft (independent buffer) ─────────────────────────────
  const activeVisualRecord = allVisuals.find((v) => v.id === activeVisualId) ?? null;
  const activeVisualDraft = activeVisualId ? visualDrafts[activeVisualId] ?? null : null;
  const activeVisual = activeVisualRecord
    ? { ...activeVisualRecord, ...(activeVisualDraft?.values ?? {}) }
    : null;
  const isNewVisual = activeVisualId !== null && isLocalId(activeVisualId);
  const visualDirty = isNewVisual || isExperienceVisualDraftDirty(activeVisualDraft);
  const visualSaveState = activeVisualDraft?.saveState ?? "idle";

  const updateVisualDraft = (patch: Partial<ExperienceVisualDraftValues>) => {
    if (!activeVisualRecord) return;
    ensureVisualDraft(activeVisualRecord);
    patchVisualDraft(activeVisualRecord.id, patch);
  };

  // ── Trust model (IR-81A) ─────────────────────────────────────────────────
  // Enabling is allowed only when the visible source is EXACTLY the saved one
  // (and the script exists server-side at all). The store independently
  // forces enabled=false on any code change; this UI locks the toggle and
  // explains why, so an edit can never silently carry trust forward.
  const scriptCodeTrusted = !isNewScript
    && activeScriptDraft !== null
    && activeScriptDraft.values.code === activeScriptDraft.base.code;
  const scriptEnabled = activeScript?.enabled ?? false;
  const enableLocked = !scriptEnabled && !scriptCodeTrusted;

  // ── Draft creation (starter pick / blank / duplicate) ────────────────────
  /** Seed a pending rules buffer from explicit values. The draft base is
   *  seeded EMPTY so the buffer starts dirty (nothing is persisted yet) and
   *  the trust invariant stays fail-closed: code != base.code until the exact
   *  reviewed source has been saved. */
  const createPendingRules = useCallback((values: InteractiveRulesDraftValues): string => {
    const id = nextLocalId("rules");
    const record = pendingScriptRecord(id, values);
    ensureScriptDraft({ ...record, name: "", description: "", code: "" });
    patchScriptDraft(id, values);
    setPendingScripts((prev) => [...prev, record]);
    return id;
  }, [ensureScriptDraft, patchScriptDraft]);

  /** Seed a pending visual buffer from a starter (or an explicit duplicate).
   *  Same empty-base trick as the rules buffer. */
  const createPendingVisual = useCallback((values: ExperienceVisualDraftValues): string => {
    const id = nextLocalId("visual");
    const record = pendingVisualRow(id, values);
    ensureVisualDraft({ ...record, name: "", source: "", compatibleManifestIds: [] });
    patchVisualDraft(id, values);
    setPendingVisuals((prev) => [...prev, record]);
    return id;
  }, [ensureVisualDraft, patchVisualDraft]);

  // ER-13d-2a/2b: persist-on-create. The blank "create new" button persists a
  // fresh EMPTY script immediately (enabled=false, global scope) so a server
  // id exists from step 1 and the copilot is iterative. Rules templates are no
  // longer a picker choice — they are applied to this buffer in step 1
  // (creation rulesToolbar); the paired VISUAL is step 2 (ER-13d-2b).
  const handleCreateExperience = async () => {
    setCreateError(null);
    try {
      const created = await createScript({
        name: t("experience_editor_new_experience_name"),
        description: "",
        code: "",
        scriptKind: "interactive",
        enabled: false,
        scopeType: "global",
      });
      setScripts((prev) => (prev.some((s) => s.id === created.id) ? prev : [...prev, created]));
      setActiveScriptId(created.id);
      // TF-1: a brand-new experience binds nothing — the previously open
      // experience's visual is dropped so it cannot leak into the fresh Visual
      // buffer. Instead, creating the app implies creating ITS OWN visual draft
      // (2026-08-17): a pending empty visual is selected immediately, so the
      // Visual tab is a live editable buffer from the start — the user (or the
      // copilot) fills it in and saves it like any other visual, instead of
      // hitting a "no visual selected" dead end first.
      setActiveVisualId(createPendingVisual({
        name: t("experience_editor_new_visual_name"),
        source: "",
        apiVersion: VISUAL_API_VERSION,
        compatibleManifestIds: [],
      }));
      setCreatingScriptId(created.id);
      setChosenRulesStarterId(null);
    } catch (error) {
      setCreateError(errorMessage(error));
    }
  };

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

  const handleNewVisualFromStarter = (starter: VisualStarter) => {
    setActiveVisualId(createPendingVisual({
      name: starter.label,
      source: starter.source,
      apiVersion: VISUAL_API_VERSION,
      compatibleManifestIds: [],
    }));
  };

  /** Create a completely blank visual (empty name + source) — the «+ Новый
   *  визуал» path. Unlike the starters it seeds no skeleton: the copilot
   *  (write_buffer target=visual) or the user fills it by hand. */
  const handleNewBlankVisual = () => {
    setActiveVisualId(createPendingVisual({
      name: "",
      source: "",
      apiVersion: VISUAL_API_VERSION,
      compatibleManifestIds: [],
    }));
  };

  // ER-13d-2b: applying a rules template in step 1 fills the EXISTING rules
  // buffer (the script was already persisted on create) via the draft store —
  // NOT a direct createScript (template application is a buffer edit the user
  // then saves as a PATCH). The name is overwritten only while it is still the
  // blank-create default, so a user-typed name is never clobbered.
  const handlePickRulesStarter = (starter: RulesStarter) => {
    updateScriptDraft({ code: starter.source });
    if (activeScript?.name === t("experience_editor_new_experience_name")) {
      updateScriptDraft({ name: starter.label });
    }
    setChosenRulesStarterId(starter.id);
  };

  /** Duplicate the CURRENT rules buffer (including unsaved edits) as a fresh,
   *  explicitly untrusted pending draft. The source row is never mutated. */
  const handleDuplicateScript = () => {
    if (!activeScript) return;
    const values = duplicateRulesValues({
      name: activeScript.name,
      description: activeScript.description,
      code: activeScript.code,
    });
    setActiveScriptId(createPendingRules(values));
  };

  /** Duplicate the current visual buffer as a fresh pending draft. */
  const handleDuplicateVisual = () => {
    if (!activeVisual) return;
    setActiveVisualId(createPendingVisual({
      name: activeVisual.name,
      source: activeVisual.source,
      apiVersion: activeVisual.apiVersion,
      compatibleManifestIds: [...activeVisual.compatibleManifestIds],
    }));
  };

  /** IR-90A: explicitly delete a visual. A pending (local-id) visual was never
   *  persisted, so it is removed locally with no API call. A saved visual is
   *  DELETEd server-side then dropped from the list + draft. A live session
   *  that already pinned this visual holds its own immutable source snapshot,
   *  so deleting the resource row never mutates that pinned source. On error
   *  the visual is kept and the error is surfaced (never silently dropped). */
  const handleDeleteVisual = useCallback(async (id: string) => {
    setVisualDeleteError(null);
    // Close the confirm modal first (shared-modal close-on-confirm convention).
    setVisualDeleteId(null);
    const resetActiveIfMatch = () => {
      if (activeVisualId === id) {
        const remaining = allVisuals.filter((v) => v.id !== id);
        setActiveVisualId(remaining.length > 0 ? remaining[0].id : null);
      }
    };
    if (isLocalId(id)) {
      // Never persisted: remove from the pending list + draft only.
      setPendingVisuals((prev) => prev.filter((v) => v.id !== id));
      removeVisualDraft(id);
      resetActiveIfMatch();
      return;
    }
    try {
      await deleteExperienceVisual(id);
      setVisuals((prev) => prev.filter((v) => v.id !== id));
      removeVisualDraft(id);
      resetActiveIfMatch();
    } catch (error) {
      // Keep the visual; surface the error (never silently drop it).
      setVisualDeleteError(errorMessage(error));
    }
  }, [activeVisualId, allVisuals, removeVisualDraft]);

  /** IR-90A: delete the active rules script (and optionally the active visual).
   *  The script is the experience's identity at the asset level; deleting it
   *  makes every chat config referencing it scriptless automatically (the DB
   *  FK is `onDelete: set null`, and `ExperienceAssignment` detects the stale
   *  reference). So this does NOT touch any experience config — the asset
   *  delete is the whole operation.
   *
   *  - "full": deletes the script AND the active visual (when it is a saved
   *    non-local asset). The visual is an independent reusable global asset,
   *  so deleting it here is a convenience, not a required cascade.
   *  - "rules": deletes only the script; the visual stays.
   *  Both land on no active script (the experience is gone). On error the
   *  surviving resource is kept and the error is surfaced (same pattern as
   *  the visual delete). */
  const handleDeleteExperience = useCallback(async (mode: "full" | "rules") => {
    if (!activeScriptId || isLocalId(activeScriptId)) return;
    setExperienceDeleteOpen(false);
    setVisualDeleteError(null);
    const scriptId = activeScriptId;
    const visualId = mode === "full" && activeVisualId !== null && !isLocalId(activeVisualId)
      ? activeVisualId
      : null;

    try {
      await deleteScript(scriptId);
    } catch (error) {
      setVisualDeleteError(errorMessage(error));
      return;
    }
    setScripts((prev) => prev.filter((s) => s.id !== scriptId));
    removeScriptDraft(scriptId);

    if (visualId) {
      try {
        await deleteExperienceVisual(visualId);
        setVisuals((prev) => prev.filter((v) => v.id !== visualId));
        removeVisualDraft(visualId);
      } catch (error) {
        // The script is already deleted; surface the visual delete error but
        // still clear the active selection (the experience itself is gone).
        setVisualDeleteError(errorMessage(error));
      }
    }
    setActiveScriptId(null);
    setActiveVisualId(null);
    setCreatingScriptId(null);
    setChosenRulesStarterId(null);
  }, [activeScriptId, activeVisualId, removeScriptDraft, removeVisualDraft]);

  // ── Saves ────────────────────────────────────────────────────────────────
  const handleSaveRules = useCallback(async () => {
    if (!activeScriptId) return;
    const submitted = prepareScriptSave(activeScriptId);
    if (!submitted) return;
    if (isLocalId(activeScriptId)) {
      // First save = CREATE. On success the local buffer migrates to the real
      // row id; edits made while the create was in flight are re-applied as a
      // dirty patch against the new base (mirrors completeSave semantics).
      try {
        const created = await createScript({
          name: submitted.name,
          description: submitted.description,
          code: submitted.code,
          scriptKind: "interactive",
          enabled: submitted.enabled,
          scopeType: "global",
        });
        const localId = activeScriptId;
        const latest = useScriptDraftStore.getState().drafts[localId]?.values ?? submitted;
        const editedDuringSave = !draftValuesEqual(latest, submitted);
        removeScriptDraft(localId);
        setPendingScripts((prev) => prev.filter((s) => s.id !== localId));
        setScripts((prev) => [...prev, created]);
        ensureScriptDraft(created);
        if (editedDuringSave) patchScriptDraft(created.id, latest);
        setActiveScriptId(created.id);
      } catch (error) {
        failScriptSave(activeScriptId, errorMessage(error));
      }
      return;
    }
    try {
      const updated = await updateScript(activeScriptId, submitted);
      completeScriptSave(activeScriptId, submitted, updated);
      setScripts((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (error) {
      failScriptSave(activeScriptId, errorMessage(error));
    }
  }, [activeScriptId, prepareScriptSave, removeScriptDraft, ensureScriptDraft, patchScriptDraft, completeScriptSave, failScriptSave]);

  const handleSaveVisual = useCallback(async () => {
    if (!activeVisualId) return;
    const submitted = prepareVisualSave(activeVisualId);
    if (!submitted) return;
    if (isLocalId(activeVisualId)) {
      try {
        const created = await createExperienceVisual({
          name: submitted.name,
          source: submitted.source,
          apiVersion: submitted.apiVersion,
          compatibleManifestIds: submitted.compatibleManifestIds,
          scopeType: "global",
        });
        const localId = activeVisualId;
        const latest = useExperienceVisualDraftStore.getState().drafts[localId]?.values ?? submitted;
        const editedDuringSave = !visualValuesEqual(latest, submitted);
        removeVisualDraft(localId);
        setPendingVisuals((prev) => prev.filter((v) => v.id !== localId));
        setVisuals((prev) => [...prev, created]);
        ensureVisualDraft(created);
        if (editedDuringSave) patchVisualDraft(created.id, latest);
        setActiveVisualId(created.id);
      } catch (error) {
        failVisualSave(activeVisualId, errorMessage(error));
      }
      return;
    }
    try {
      const updated = await updateExperienceVisual(activeVisualId, submitted);
      completeVisualSave(activeVisualId, submitted, updated);
      setVisuals((prev) => prev.map((v) => (v.id === updated.id ? updated : v)));
    } catch (error) {
      failVisualSave(activeVisualId, errorMessage(error));
    }
  }, [activeVisualId, prepareVisualSave, removeVisualDraft, ensureVisualDraft, patchVisualDraft, completeVisualSave, failVisualSave]);

  // Ctrl/Cmd+S saves the rules buffer (the visual has its own explicit save).
  useKeyDown(["s", "S"], (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    void handleSaveRules();
  }, { enabled: !!activeScriptId && scriptDirty && scriptSaveState !== "saving" });

  // ── Picker / list view ───────────────────────────────────────────────────
  if (!activeScript) {
    return (
      <>
      <div className="mx-auto max-w-[860px] px-6 py-5">
        {listsFailed && (
          <div className="mb-3 rounded-md border border-danger bg-danger-dim px-3 py-2 font-ui text-[12px] text-danger-text">
            {t("experience_editor_load_error")}
          </div>
        )}
        {createError && (
          <div className="mb-3 rounded-md border border-danger bg-danger-dim px-3 py-2 font-ui text-[12px] text-danger-text">
            {t("experience_editor_create_error")}: {createError}
          </div>
        )}
        <button
          type="button"
          className="mb-4 flex w-full cursor-pointer items-center gap-3 rounded-xl border border-accent bg-accent/10 px-4 py-3 text-left transition-all hover:bg-accent/20"
          onClick={() => void handleCreateExperience()}
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-on-accent"><Ic.plus /></div>
          <span className="flex-1 text-[14px] font-semibold text-t1">{t("experience_editor_create_new")}</span>
        </button>

        <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">
          {t("experience_editor_existing_label")}
        </div>
        {allScripts.length === 0 ? (
          <EmptyState
            icon={<Ic.stack />}
            title={t("experience_editor_no_scripts")}
            cta={t("experience_editor_empty_cta")}
            onCta={() => void handleCreateExperience()}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {allScripts.map((script) => {
              const display = { ...script, ...(scriptDrafts[script.id]?.values ?? {}) };
              const firstBoundVisual = (boundVisuals[script.id] ?? [])[0] ?? null;
              const isDraft = isLocalId(script.id);
              const statusKey = isDraft
                ? "experience_editor_card_draft_tooltip"
                : display.enabled
                  ? "experience_editor_enabled"
                  : "experience_editor_disabled";
              const dotClass = isDraft
                ? "bg-warning"
                : display.enabled
                  ? "bg-success"
                  : "bg-t4";
              return (
                <div
                  key={script.id}
                  className="group flex flex-col overflow-hidden rounded-xl border border-border bg-surface transition-all hover:border-accent/40 hover:bg-s2"
                >
                  <button
                    type="button"
                    className="flex w-full cursor-pointer flex-col text-left"
                    onClick={() => openScript(script.id)}
                  >
                    <ExperienceCardPreview visualSource={firstBoundVisual?.source ?? null} />
                    <div className="p-3.5">
                      <div className="flex items-center gap-1.5">
                        <CustomTooltip content={t(statusKey)}>
                          <span
                            aria-label={t(statusKey)}
                            data-testid="card-status-dot"
                            className={cn("h-2 w-2 shrink-0 rounded-full", dotClass)}
                          />
                        </CustomTooltip>
                        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold leading-tight text-t1">{display.name}</span>
                      </div>
                      <div
                        data-testid="card-description"
                        className="mt-2 min-h-[3.25em] font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2"
                      >
                        {display.description && <div className="line-clamp-2">{display.description}</div>}
                      </div>
                    </div>
                  </button>
                  {!isLocalId(script.id) && (
                    <div className="border-t border-border px-3 py-2">
                      <ExperienceVisualBinding
                        bound={boundVisuals[script.id] ?? []}
                        available={visuals}
                        onToggle={(visualId, bind) => void handleToggleVisual(script.id, visualId, bind)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      </>
    );
  }
  // ── Editor view ──────────────────────────────────────────────────────────
  // IR-13c: the editing surface is a full-bleed 2-pane copilot layout — chat
  // left + editor right (rules/visual toggle) with the management controls
  // (name / trust / save / duplicate / delete / back) in a sticky top bar. The
  // tester / preview / sandbox surfaces are the shell's top-button modals
  // (ER-13b′); the inline editors and playground moved into the shell.
  return (
    <div className="flex h-full w-full flex-col">
      {/* Top bar: back, name, trust, save, duplicate, delete. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <button
          type="button"
          aria-label={t("experience_editor_back")}
          className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 font-ui text-[12px] text-t3 transition-all hover:bg-s2 hover:text-t1"
          onClick={() => {
            setActiveScriptId(null);
            // TF-1: leaving the editor must also drop the visual selection —
            // otherwise persist-on-create inherits it into a NEW experience.
            setActiveVisualId(null);
            setCreatingScriptId(null);
            setChosenRulesStarterId(null);
          }}
        >
          {Ic.caret("l")} {t("experience_editor_back")}
        </button>

        <input
          className={cn(inputCls, "min-w-0 flex-1 text-[15px] font-semibold")}
          type="text"
          value={activeScript.name}
          onChange={(e) => updateScriptDraft({ name: e.target.value })}
          placeholder={t("script_name")}
        />

        <CustomTooltip content={t("experience_editor_trust_hint")}>
          <span
            className={cn(
              "shrink-0 cursor-help rounded-full px-2 py-0.5 font-ui text-[10px] font-medium uppercase",
              scriptEnabled ? "bg-success-dim text-success-text" : "bg-warning-dim text-warning-text",
            )}
          >
            {scriptEnabled ? t("experience_editor_enabled") : t("experience_editor_disabled")}
          </span>
        </CustomTooltip>
        <Toggle
          checked={scriptEnabled}
          disabled={enableLocked}
          onChange={(enabled) => updateScriptDraft({ enabled })}
        />

        <span
          className={cn("shrink-0 font-ui text-[12px]", scriptSaveState === "error" ? "text-danger" : "text-t3")}
          title={activeScriptDraft?.error ?? undefined}
        >
          {scriptSaveState === "error" ? t("retry") : scriptDirty ? t("unsaved_changes") : t("saved_state")}
        </span>
        <SaveButton
          dirty={scriptDirty}
          saveState={scriptSaveState}
          resetKey={activeScriptId}
          onClick={() => void handleSaveRules()}
          label={scriptSaveState === "error" ? t("retry") : t("save")}
        />

        <CustomTooltip content={t("experience_editor_duplicate")}>
          <button
            type="button"
            aria-label={t("experience_editor_duplicate")}
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t2 transition-all hover:bg-s2 hover:text-t1"
            onClick={handleDuplicateScript}
          >
            <Ic.copy />
          </button>
        </CustomTooltip>
        {/* IR-90A: delete the experience (its rules script). Reachable only for a
            saved script — an unsaved/local draft is discarded by navigating back. */}
        {!isNewScript && (
          <CustomTooltip content={t("experience_editor_delete")}>
            <button
              type="button"
              aria-label={t("experience_editor_delete")}
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-danger transition-all hover:bg-s2"
              onClick={() => setExperienceDeleteOpen(true)}
            >
              <Ic.del />
            </button>
          </CustomTooltip>
        )}
      </div>

      {enableLocked && (
        <div className="shrink-0 border-b border-warning/40 bg-warning-dim/30 px-3 py-1 text-[11px] leading-[1.4] text-t3">
          {t("experience_editor_trust_blocked_hint")}
        </div>
      )}

      {/* XU-6 creation stepper: a slim presentational strip above the editor
          pane. The active step mirrors the shell's current position (reported
          via onStepChange); completed steps get a check. */}
      {creationMode && (
        <div
          className="flex shrink-0 items-center gap-1.5 border-b border-border bg-surface px-3 py-1.5"
          data-testid="experience-creation-stepper"
        >
          {CREATION_STEP_ORDER.map((step, index) => {
            const isActive = activeStep === step;
            const isDone = CREATION_STEP_ORDER.indexOf(activeStep) > index;
            const label =
              step === "rules"
                ? t("experience_copilot_rules")
                : step === "appearance"
                  ? t("experience_editor_step_appearance")
                  : t("experience_copilot_try_it");
            return (
              <div key={step} className="flex items-center gap-1.5">
                {index > 0 && <span className="text-t4">{Ic.caret("r")}</span>}
                <span
                  className={cn(
                    "flex items-center gap-1.5 font-ui text-[11px] font-medium",
                    isActive ? "text-accent-t" : isDone ? "text-t2" : "text-t3",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-4 w-4 items-center justify-center rounded-full text-[9px]",
                      isDone ? "bg-accent text-on-accent" : "bg-s3 text-t3",
                    )}
                  >
                    {isDone ? Ic.check() : index + 1}
                  </span>
                  {label}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Body: the 2-pane copilot shell hosts both editors + top-button modals. */}
      <div className="flex min-h-0 flex-1">
        <ExperienceCopilotShell
          scriptId={activeScript.id}
          assignedProfileId={activeScript.copilotProfileId ?? null}
          creationMode={creationMode}
          onStepChange={handleStepChange}
          rulesCode={activeScript.code}
          onRulesChange={(code) => updateScriptDraft({ code })}
          visualSource={activeVisual?.source ?? ""}
          onVisualChange={(source) => updateVisualDraft({ source })}
          rulesToolbar={
            <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface px-3 py-2">
              {creationMode && (
                <div className="flex flex-col gap-1.5">
                  <div className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("experience_editor_rules_template")}</div>
                  <div className="flex flex-wrap gap-2">
                    {RULES_STARTERS.map((starter) => {
                      const active = starter.id === chosenRulesStarterId;
                      return (
                        <button
                          type="button"
                          key={starter.id}
                          className={cn(
                            "flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 font-ui text-[11px] transition-all",
                            active
                              ? "border-accent bg-accent/10 text-accent-t"
                              : "border-border bg-s3 text-t2 hover:bg-s2 hover:text-t1",
                          )}
                          onClick={() => handlePickRulesStarter(starter)}
                        >
                          {starter.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <label className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_desc_label")}</label>
              <input
                className={inputCls}
                value={activeScript.description}
                onChange={(e) => updateScriptDraft({ description: e.target.value })}
                placeholder={t("script_desc_placeholder")}
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={cn("flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 font-ui text-[11px] transition-all hover:bg-s2 hover:text-t1", apiRefOpen ? "bg-accent-dim text-accent-t" : "bg-s3 text-t2")}
                  onClick={() => setApiRefOpen((v) => !v)}
                >
                  <Ic.book /> {t("script_api_reference")}
                </button>
                <button
                  type="button"
                  className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
                  disabled={validating || activeScript.code.trim() === ""}
                  onClick={() => void handleValidateRules()}
                >
                  <Ic.check />
                  {validating ? t("experience_wizard_validating") : t("experience_editor_validate_rules")}
                </button>
                {rulesValid === true && (
                  <span className="font-ui text-[11px] text-success">{t("experience_wizard_rules_valid")}</span>
                )}
                {rulesValid === false && (
                  <span className="font-ui text-[11px] text-danger">{t("experience_wizard_rules_invalid")}: {rulesValidationError}</span>
                )}
              </div>
              {apiRefOpen && <InteractiveApiReference />}
            </div>
          }
          visualToolbar={
            <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface px-3 py-2">
              {visualDeleteError && (
                <div className="rounded-md border border-danger bg-danger-dim px-3 py-2 font-ui text-[12px] text-danger-text">
                  {t("experience_editor_visual_delete_error")}: {visualDeleteError}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-[220px] flex-1">
                  <DropdownSelect
                    value={activeVisualId ?? ""}
                    options={allVisuals.map((visual) => {
                      const isBound = activeScriptId !== null && (boundVisuals[activeScriptId] ?? []).some((v) => v.id === visual.id);
                      return {
                        id: visual.id,
                        label: (visualDrafts[visual.id]?.values.name ?? visual.name) || visual.id,
                        ...(isLocalId(visual.id) ? { detail: t("experience_editor_unsaved_badge") } : {}),
                        ...(isBound
                          ? {
                              trailing: (
                                <CustomTooltip content={t("experience_editor_visual_bound")}>
                                  <span data-testid="experience_visual_bound_badge" className="flex h-4 w-4 items-center justify-center rounded-full bg-accent-dim text-accent-t"><Ic.plug /></span>
                                </CustomTooltip>
                              ),
                            }
                          : {}),
                      };
                    })}
                    placeholder={t("experience_assign_visual_placeholder")}
                    searchPlaceholder={t("experience_assign_visual_search")}
                    onChange={(id) => setActiveVisualId(id === "" ? null : id)}
                  />
                </div>
                {activeVisual ? (
                  <>
                    <CustomTooltip content={t("experience_editor_duplicate")}>
                      <button
                        type="button"
                        aria-label={t("experience_editor_duplicate")}
                        className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t2 transition-all hover:bg-s2 hover:text-t1"
                        onClick={handleDuplicateVisual}
                      >
                        <Ic.copy />
                      </button>
                    </CustomTooltip>
                    <CustomTooltip content={t("experience_editor_visual_delete")}>
                      <button
                        type="button"
                        aria-label={t("experience_editor_visual_delete")}
                        className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-danger transition-all hover:bg-s2"
                        onClick={() => {
                          if (activeVisualId) {
                            setVisualDeleteError(null);
                            setVisualDeleteId(activeVisualId);
                          }
                        }}
                      >
                        <Ic.del />
                      </button>
                    </CustomTooltip>
                  </>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1"
                  onClick={handleNewBlankVisual}
                >
                  <Ic.plus /> {t("experience_editor_visual_blank")}
                </button>
                {VISUAL_STARTERS.map((starter) => {
                  const isPaired = creationMode
                    && chosenRulesStarterId !== null
                    && PAIRED_VISUAL_STARTER_ID[chosenRulesStarterId] === starter.id;
                  return (
                    <button
                      type="button"
                      key={starter.id}
                      aria-label={isPaired ? t("experience_editor_visual_paired") : undefined}
                      className={cn(
                        "flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 font-ui text-[11px] transition-all",
                        isPaired
                          ? "border-accent bg-accent/10 text-accent-t ring-2 ring-accent/40"
                          : "border-border bg-s3 text-t2 hover:bg-s2 hover:text-t1",
                      )}
                      onClick={() => handleNewVisualFromStarter(starter)}
                    >
                      {starter.label}
                      {isPaired && (
                        <span className="rounded bg-accent-dim px-1 py-0.5 font-ui text-[9px] font-semibold uppercase tracking-wide text-accent-t">
                          {t("experience_editor_visual_paired")}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {activeVisual ? (
                <>
                  <div className="flex items-center gap-2">
                    <input
                      className={cn(inputCls, "min-w-0 flex-1")}
                      type="text"
                      value={activeVisual.name}
                      onChange={(e) => updateVisualDraft({ name: e.target.value })}
                      placeholder={t("experience_editor_visual_name_ph")}
                      title={activeVisualDraft?.error ?? undefined}
                    />
                    {visualDirty && (
                      <span className="shrink-0 whitespace-nowrap font-ui text-[12px] text-t3">{t("unsaved_changes")}</span>
                    )}
                    <SaveButton
                      className="shrink-0"
                      dirty={visualDirty}
                      saveState={visualSaveState}
                      resetKey={activeVisualId}
                      onClick={() => void handleSaveVisual()}
                      label={visualSaveState === "error" ? t("retry") : t("experience_editor_visual_save")}
                    />
                  </div>
                  <div className="rounded-md border border-border bg-bg">
                    <button
                      type="button"
                      className="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-left"
                      onClick={() => setVisualTechOpen((v) => !v)}
                      aria-expanded={visualTechOpen}
                    >
                      <span
                        className="inline-block text-t3 transition-transform"
                        style={{ transform: visualTechOpen ? "rotate(90deg)" : "none" }}
                      >
                        {Ic.caret("r")}
                      </span>
                      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
                        {t("experience_editor_visual_technical_details")}
                      </span>
                    </button>
                    <AnimatedDisclosure open={visualTechOpen} className="px-2.5 pb-2">
                      <div className="flex flex-wrap gap-x-4 gap-y-1 font-ui text-[11px] text-t3">
                        <span>{t("experience_editor_visual_api_version")}: {activeVisual.apiVersion}</span>
                        <span>
                          {t("experience_editor_visual_hash")}:{" "}
                          {isNewVisual
                            ? t("experience_editor_visual_hash_unsaved")
                            : (activeVisualDraft?.sourceHash ? activeVisualDraft.sourceHash.slice(0, 12) : "—")}
                        </span>
                        <span>
                          {t("experience_editor_visual_manifests")}:{" "}
                          {activeVisual.compatibleManifestIds.length > 0 ? activeVisual.compatibleManifestIds.join(", ") : "—"}
                        </span>
                      </div>
                    </AnimatedDisclosure>
                  </div>
                </>
              ) : (
                <div className="py-2 text-center font-ui text-[12px] italic text-t3">
                  {t("experience_editor_visual_none")}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={cn("flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 font-ui text-[11px] transition-all hover:bg-s2 hover:text-t1", visualApiRefOpen ? "bg-accent-dim text-accent-t" : "bg-s3 text-t2")}
                  onClick={() => setVisualApiRefOpen((v) => !v)}
                >
                  <Ic.book /> {t("script_api_reference")}
                </button>
              </div>
              {visualApiRefOpen && <VisualApiReference />}
            </div>
          }
        />
      </div>

      {/* IR-90A: explicit destructive delete for the active visual. */}
      {visualDeleteId && (
        <DestructiveConfirmModal
          title={t("experience_editor_visual_delete_title")}
          body={t("experience_editor_visual_delete_msg")}
          confirmLabel={t("experience_editor_visual_delete")}
          onConfirm={() => void handleDeleteVisual(visualDeleteId)}
          onCancel={() => { setVisualDeleteId(null); setVisualDeleteError(null); }}
        />
      )}

      {/* IR-90A: dual-action destructive delete for the active experience (its
          rules script). */}
      {experienceDeleteOpen && (
        <DestructiveConfirmModal
          title={t("experience_editor_delete_title")}
          body={t("experience_editor_delete_body")}
          confirmLabel={t("experience_editor_delete_full")}
          onConfirm={() => void handleDeleteExperience("full")}
          onCancel={() => setExperienceDeleteOpen(false)}
          secondaryLabel={activeVisualId ? t("experience_editor_delete_rules_only") : undefined}
          onSecondary={activeVisualId ? () => void handleDeleteExperience("rules") : undefined}
        />
      )}
    </div>
  );
}
