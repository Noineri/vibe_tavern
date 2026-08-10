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
 *  - A starter picker: the five frozen rules starters (IR-81A
 *    `RULES_STARTERS`) or a blank start. Picking one lands in the editor with
 *    an UNSAVED rules draft PLUS a paired UNSAVED visual draft (Round ↔
 *    Choice, Board ↔ Grid/Board, Card ↔ Card Table, Model Conversation ↔
 *    Conversation, Blank ↔ Blank) — two independent buffers, two independent
 *    saves.
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
 * IR-81D: the stateless InteractiveTester mounts below the rules CodeEditor
 * and drives the unsaved rules buffer through POST
 * /api/experience/test/run|simulate as a read-only diagnostic (it never
 * mutates these drafts or any store).
 */
import { useCallback, useEffect, useState } from "react";
import { useKeyDown } from "../../../hooks/use-key-down.js";
import { Ic } from "../../shared/icons.js";
import { CodeEditor } from "../../shared/CodeEditor.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
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
  rulesStarterToDraftValues,
  type InteractiveRulesDraftValues,
  type RulesStarter,
} from "../../../lib/experience-rules-starters.js";
import { VISUAL_STARTERS, getVisualStarter, type VisualStarter } from "../../experience/starters/index.js";
import { createScript, listAllScripts, updateScript } from "../../../api/script-api.js";
import {
  createExperienceVisual,
  deleteExperienceVisual,
  listExperienceVisuals,
  updateExperienceVisual,
} from "../../../api/experience-api.js";
import type { ExperienceVisualRow, ScriptRecord } from "../../../api/types.js";
import { InteractiveApiReference } from "./interactive-api-reference.js";
import { InteractiveTester } from "./InteractiveTester.js";
import { ExperiencePlayground } from "./ExperiencePlayground.js";
import { Modal } from "../../shared/Modal.js";
import { DestructiveConfirmModal } from "../../shared/destructive-confirm-modal.js";
import { AiAssistantModal } from "../../shared/AiAssistantModal.js";

// ── Local (unsaved) record ids ─────────────────────────────────────────────
// A draft created from a starter/duplicate has no server row until its first
// save. Local ids namespace those buffers; `isLocalId` drives the create-vs-
// patch save branch and the trust model (a local source is never trusted).
let localIdCounter = 0;
function nextLocalId(prefix: string): string {
  localIdCounter += 1;
  return `local:${prefix}:${localIdCounter}`;
}
function isLocalId(id: string): boolean {
  return id.startsWith("local:");
}

/** Canonical rules-starter → visual-starter pairing (IR-81A/IR-63 row order). */
const PAIRED_VISUAL_STARTER_ID: Record<string, string> = {
  round: "choice",
  board: "grid-board",
  card: "card-table",
  model_conversation: "conversation",
  blank_state_machine: "blank",
};

/** Bridge API version new visuals target (the version the five IR-63 starters
 *  are written against; there is no shared constant — the schema floor is 1). */
const VISUAL_API_VERSION = 1;

function pendingScriptRecord(id: string, values: InteractiveRulesDraftValues): ScriptRecord {
  return {
    id,
    name: values.name,
    description: values.description,
    code: values.code,
    scriptKind: "interactive",
    enabled: false,
    scopeType: "global",
    characterId: null,
    personaId: null,
    chatId: null,
    sortOrder: 0,
  };
}

function pendingVisualRow(id: string, values: ExperienceVisualDraftValues): ExperienceVisualRow {
  return {
    id,
    name: values.name,
    source: values.source,
    sourceHash: "",
    apiVersion: values.apiVersion,
    compatibleManifestIds: [...values.compatibleManifestIds],
    scopeType: "global",
    characterId: null,
    personaId: null,
    chatId: null,
    createdAt: "",
    updatedAt: "",
  };
}

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

// ── Component ──────────────────────────────────────────────────────────────

export function ExperienceEditor() {
  const { t } = useT();

  // ── Lists (server rows + unsaved local buffers) ──────────────────────────
  const [scripts, setScripts] = useState<ScriptRecord[]>([]);
  const [visuals, setVisuals] = useState<ExperienceVisualRow[]>([]);
  const [pendingScripts, setPendingScripts] = useState<ScriptRecord[]>([]);
  const [pendingVisuals, setPendingVisuals] = useState<ExperienceVisualRow[]>([]);
  const [listsFailed, setListsFailed] = useState(false);

  const [activeScriptId, setActiveScriptId] = useState<string | null>(null);
  const [activeVisualId, setActiveVisualId] = useState<string | null>(null);
  const [apiRefOpen, setApiRefOpen] = useState(false);
  const [aiHelperOpen, setAiHelperOpen] = useState(false);
  const [visualAiHelperOpen, setVisualAiHelperOpen] = useState(false);

  // IR-84B launcher: the inline playground is mounted at the bottom of the
  // editor; this opens the SAME draft-bound playground in a shared Modal from
  // the top toolbar so it is reachable without scrolling. At most ONE
  // ExperiencePlayground instance is mounted at a time — when the modal is
  // open the inline slot renders a collapsed placeholder (playground state is
  // ephemeral/scratch, so re-mounting on close/reopen is acceptable).
  const [playgroundModalOpen, setPlaygroundModalOpen] = useState(false);

  // IR-90A: explicit destructive delete for a saved/pending visual, confirmed
  // via the shared DestructiveConfirmModal. A failed delete keeps the visual
  // and surfaces the error (never silently dropped).
  const [visualDeleteId, setVisualDeleteId] = useState<string | null>(null);
  const [visualDeleteError, setVisualDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listAllScripts(),
      listExperienceVisuals({ scopeType: "global" }),
    ])
      .then(([allScripts, globalVisuals]) => {
        if (cancelled) return;
        setScripts(allScripts.filter((s) => s.scriptKind === "interactive"));
        setVisuals(globalVisuals);
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

  const handlePickStarter = (starter: RulesStarter | null) => {
    const values = starter
      ? rulesStarterToDraftValues(starter)
      : {
          name: t("experience_editor_untitled_rules"),
          description: "",
          code: "",
          scriptKind: "interactive" as const,
          enabled: false as const,
        };
    setActiveScriptId(createPendingRules(values));
    // Land with a paired, INDEPENDENT visual draft (canonical IR-63 pairing).
    const visualStarter = getVisualStarter(starter ? PAIRED_VISUAL_STARTER_ID[starter.id] ?? "blank" : "blank");
    if (visualStarter) {
      setActiveVisualId(createPendingVisual({
        name: visualStarter.label,
        source: visualStarter.source,
        apiVersion: VISUAL_API_VERSION,
        compatibleManifestIds: starter ? [starter.id] : [],
      }));
    } else {
      setActiveVisualId(null);
    }
  };

  const handleNewVisualFromStarter = (starter: VisualStarter) => {
    setActiveVisualId(createPendingVisual({
      name: starter.label,
      source: starter.source,
      apiVersion: VISUAL_API_VERSION,
      compatibleManifestIds: [],
    }));
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
      <div className="mx-auto max-w-[860px] px-6 py-5">
        {listsFailed && (
          <div className="mb-3 rounded-md border border-danger bg-danger-dim px-3 py-2 font-ui text-[12px] text-danger-text">
            {t("experience_editor_load_error")}
          </div>
        )}
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">
          {t("experience_editor_starters_label")}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {RULES_STARTERS.map((starter) => (
            <button
              type="button"
              key={starter.id}
              className="cursor-pointer rounded-xl border border-border bg-surface px-4 py-3 text-left transition-all hover:bg-s2 hover:border-accent"
              onClick={() => handlePickStarter(starter)}
            >
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-dim text-accent-t"><Ic.terminal /></div>
                <span className="flex-1 truncate text-[14px] font-semibold text-t1">{starter.label}</span>
              </div>
              <div className="mt-2 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2">{starter.description}</div>
            </button>
          ))}
          <button
            type="button"
            className="cursor-pointer rounded-xl border border-dashed border-border bg-surface px-4 py-3 text-left transition-all hover:bg-s2 hover:border-accent"
            onClick={() => handlePickStarter(null)}
          >
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-s3 text-t2"><Ic.plus /></div>
              <span className="flex-1 truncate text-[14px] font-semibold text-t1">{t("experience_editor_start_blank")}</span>
            </div>
            <div className="mt-2 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2">{t("experience_editor_start_blank_desc")}</div>
          </button>
        </div>

        <div className="mb-2 mt-6 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">
          {t("experience_editor_existing_label")}
        </div>
        {allScripts.length === 0 ? (
          <div className="py-6 text-center font-ui text-[13px] text-t3">{t("experience_editor_no_scripts")}</div>
        ) : (
          allScripts.map((script) => {
            const display = { ...script, ...(scriptDrafts[script.id]?.values ?? {}) };
            return (
              <div
                key={script.id}
                className="mb-3 cursor-pointer rounded-xl border border-border bg-surface transition-all hover:bg-s2"
                onClick={() => setActiveScriptId(script.id)}
              >
                <div className="flex items-center gap-2 px-4 pt-3 pb-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-dim text-accent-t"><Ic.terminal /></div>
                  <span className="flex-1 truncate text-[14px] font-semibold text-t1">{display.name}</span>
                  {isLocalId(script.id) && (
                    <div className="mr-1 shrink-0 rounded px-1.5 py-0.5 font-ui text-[10px] uppercase tracking-wide bg-warning-dim text-warning-text">
                      {t("experience_editor_unsaved_badge")}
                    </div>
                  )}
                  <div className={cn("shrink-0 rounded-full px-2 py-0.5 font-ui text-[10px] font-medium uppercase", display.enabled ? "bg-success-dim text-success-text" : "bg-s3 text-t3")}>
                    {display.enabled ? "ON" : "OFF"}
                  </div>
                </div>
                {display.description && <div className="px-4 pb-3 pt-0 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2">{display.description}</div>}
              </div>
            );
          })
        )}
      </div>
    );
  }

  // ── Editor view ──────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-[860px] px-6 py-5">
      <button
        type="button"
        className="mb-4 flex cursor-pointer items-center gap-1.5 font-ui text-[12px] text-t3 transition-all hover:text-t1"
        onClick={() => setActiveScriptId(null)}
      >
        {Ic.caret("l")} {t("experience_editor_back")}
      </button>

      {/* Rules: explicit-save status + action. Ctrl/Cmd+S calls the same handler. */}
      <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-border bg-s2 px-3 py-2">
        <span
          className={cn("min-w-0 truncate font-ui text-[12px]", scriptSaveState === "error" ? "text-danger" : "text-t3")}
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
      </div>

      {/* Name + trust toggle + duplicate */}
      <div className="flex items-center gap-3" style={{ marginBottom: 8 }}>
        <div className="min-w-0 flex-1">
          <input
            className={cn(inputCls, "text-[15px] font-semibold")}
            type="text"
            value={activeScript.name}
            onChange={(e) => updateScriptDraft({ name: e.target.value })}
            placeholder={t("script_name")}
          />
        </div>
        <span
          className={cn("shrink-0 rounded-full px-2 py-0.5 font-ui text-[10px] font-medium uppercase", scriptEnabled ? "bg-success-dim text-success-text" : "bg-warning-dim text-warning-text")}
        >
          {scriptEnabled ? t("experience_editor_trusted") : t("experience_editor_untrusted")}
        </span>
        <CustomTooltip content={t("experience_editor_trust_hint")}>
          <span className="cursor-help text-[11px] text-t4">ⓘ</span>
        </CustomTooltip>
        <Toggle
          checked={scriptEnabled}
          disabled={enableLocked}
          onChange={(enabled) => updateScriptDraft({ enabled })}
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
      </div>
      {enableLocked && (
        <div className="mb-4 rounded-md border border-warning/40 bg-warning-dim/30 px-2 py-1 text-[11px] leading-[1.4] text-t3">
          {t("experience_editor_trust_blocked_hint")}
        </div>
      )}

      {/* Description */}
      <div style={{ marginBottom: 16 }}>
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_desc_label")}</label>
        <input
          className={inputCls}
          value={activeScript.description}
          onChange={(e) => updateScriptDraft({ description: e.target.value })}
          placeholder={t("script_desc_placeholder")}
        />
      </div>

      {/* Toolbar: API reference + AI helper */}
      <div className="mb-2 flex flex-wrap gap-2">
        {/* IR-84B/IR-90A: above-the-fold playground launcher — opens the SAME
            draft-bound playground in a shared Modal so it is reachable without
            scrolling to the inline section at the bottom. */}
        <button
          type="button"
          className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-accent-dim px-2.5 font-ui text-[11px] text-accent-t transition-all hover:brightness-110"
          onClick={() => setPlaygroundModalOpen(true)}
        >
          <Ic.dice /> {t("experience_editor_playground_open")}
        </button>
        <button
          type="button"
          className={cn("flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 font-ui text-[11px] transition-all hover:bg-s2 hover:text-t1", apiRefOpen ? "bg-accent-dim text-accent-t" : "bg-s3 text-t2")}
          onClick={() => setApiRefOpen((v) => !v)}
        >
          <Ic.book /> {t("script_api_reference")}
        </button>
        <button
          type="button"
          className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1"
          onClick={() => setAiHelperOpen(true)}
        >
          <Ic.brain /> {t("experience_editor_ai_helper")}
        </button>
      </div>
      {apiRefOpen && <InteractiveApiReference />}

      {/* Rules source */}
      <div style={{ marginBottom: 20 }}>
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_code_label")}</label>
        <div className="relative rounded-md border border-border bg-bg">
          <CodeEditor
            value={activeScript.code}
            onChange={(code) => updateScriptDraft({ code })}
            minHeight="300px"
            scrollMode="inner"
          />
        </div>
      </div>

      {/*
       * IR-81D: the stateless unsaved-source tester. It drives the CURRENT
       * UNSAVED rules buffer through the IR-81B backend tester
       * (POST /api/experience/test/run|simulate) as a read-only diagnostic —
       * it never mutates these drafts, never touches a store, and never
       * forwards an action to any chat/session.
       */}
      <InteractiveTester code={activeScript.code} />

      {/* Visual: independent buffer with its own explicit save */}
      <div className="mt-8 border-t border-border pt-4">
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">
          {t("experience_editor_visual_section")}
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="min-w-[220px] flex-1">
            <DropdownSelect
              value={activeVisualId ?? ""}
              options={allVisuals.map((visual) => ({
                id: visual.id,
                label: (visualDrafts[visual.id]?.values.name ?? visual.name) || visual.id,
                ...(isLocalId(visual.id) ? { detail: t("experience_editor_unsaved_badge") } : {}),
              }))}
              placeholder={t("experience_assign_visual_placeholder")}
              searchPlaceholder={t("experience_assign_visual_search")}
              onChange={(id) => setActiveVisualId(id === "" ? null : id)}
            />
          </div>
          <CustomTooltip content={t("experience_editor_duplicate")}>
            <button
              type="button"
              aria-label={t("experience_editor_duplicate")}
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
              disabled={!activeVisual}
              onClick={handleDuplicateVisual}
            >
              <Ic.copy />
            </button>
          </CustomTooltip>
          <CustomTooltip content={t("experience_editor_visual_delete")}>
            <button
              type="button"
              aria-label={t("experience_editor_visual_delete")}
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-danger transition-all hover:bg-s2 disabled:cursor-default disabled:opacity-40"
              disabled={!activeVisual}
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
        </div>
        {visualDeleteError && (
          <div className="mb-3 rounded-md border border-danger bg-danger-dim px-3 py-2 font-ui text-[12px] text-danger-text">
            {t("experience_editor_visual_delete_error")}: {visualDeleteError}
          </div>
        )}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="font-ui text-[11px] text-t3">{t("experience_editor_visual_new")}</span>
          {VISUAL_STARTERS.map((starter) => (
            <button
              type="button"
              key={starter.id}
              className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1"
              onClick={() => handleNewVisualFromStarter(starter)}
            >
              {starter.label}
            </button>
          ))}
        </div>

        {activeVisual ? (
          <>
            <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-border bg-s2 px-3 py-2">
              <span
                className={cn("min-w-0 truncate font-ui text-[12px]", visualSaveState === "error" ? "text-danger" : "text-t3")}
                title={activeVisualDraft?.error ?? undefined}
              >
                {visualSaveState === "error" ? t("retry") : visualDirty ? t("unsaved_changes") : t("saved_state")}
              </span>
              <SaveButton
                dirty={visualDirty}
                saveState={visualSaveState}
                resetKey={activeVisualId}
                onClick={() => void handleSaveVisual()}
                label={visualSaveState === "error" ? t("retry") : t("experience_editor_visual_save")}
              />
            </div>
            <div style={{ marginBottom: 12 }}>
              <input
                className={inputCls}
                type="text"
                value={activeVisual.name}
                onChange={(e) => updateVisualDraft({ name: e.target.value })}
                placeholder={t("experience_editor_visual_name_ph")}
              />
            </div>
            <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 font-ui text-[11px] text-t3">
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
            <div style={{ marginBottom: 20 }}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {/*
                 * IR-83B: launch the VISUAL AI assistant. It discovers the validated
                 * contract from the ACTIVE RULES source (interactiveRulesSource) and
                 * emits visual source only — it never touches the rules draft. It is
                 * disabled when there is no rules source to discover a contract from.
                 */}
                <button
                  type="button"
                  className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1 disabled:cursor-default disabled:opacity-40"
                  disabled={!activeScript?.code?.trim()}
                  onClick={() => setVisualAiHelperOpen(true)}
                >
                  <Ic.brain /> {t("experience_editor_visual_ai_helper")}
                </button>
                {!activeScript?.code?.trim() && (
                  <span className="font-ui text-[11px] italic text-t3">{t("experience_editor_visual_ai_helper_no_rules")}</span>
                )}
              </div>
              <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("experience_editor_visual_source_label")}</label>
              <div className="relative rounded-md border border-border bg-bg">
                <CodeEditor
                  value={activeVisual.source}
                  onChange={(source) => updateVisualDraft({ source })}
                  minHeight="220px"
                  scrollMode="inner"
                />
              </div>
            </div>
          </>
        ) : (
          <div className="py-4 text-center font-ui text-[12px] italic text-t3">
            {t("experience_editor_visual_none")}
          </div>
        )}
      </div>

      <div className="mt-3">
        {/*
         * IR-84B: the interactive playground. A peer of the IR-81D tester with
         * access to BOTH unsaved buffers — it PLAYS the CURRENT UNSAVED rules
         * (`activeScript.code`) through the IR-84A in-memory playground driver
         * (POST /api/experience/playground/start|advance) turn by turn, and
         * renders the CURRENT UNSAVED visual (`activeVisual.source`, when one
         * is selected) inside the isolated ExperienceFrame against the live
         * playground state. Read-only: it never mutates these drafts, never
         * touches a store, and never forwards an action to any chat/session.
         *
         * IR-90A single-instance invariant: when the playground is open in the
         * header Modal, the inline slot renders a collapsed placeholder
         * instead of a second ExperiencePlayground (a second mounted instance
         * would create a second in-memory driver). Playground state is
         * ephemeral/scratch, so re-mounting on close/reopen is acceptable.
         */}
        {playgroundModalOpen ? (
          <div className="rounded-lg border border-border bg-s2" style={{ padding: 16 }}>
            <span className="font-ui text-[12px] text-t3">{t("experience_editor_playground_open_in_modal")}</span>
          </div>
        ) : (
          <ExperiencePlayground code={activeScript.code} visualSource={activeVisual?.source ?? null} />
        )}
      </div>

      {/*
       * IR-82: the universal AI assistant, thin-wired exactly like the
       * ScriptEditor→AiAssistantModal integration. It generates OR repairs
       * raw reviewable rules source from the selected starter, the package
       * API reference (baked into the interactive_rules prompt asset), the
       * current source, and the author's design direction. Output lands back
       * in the rules draft via the normal updateScriptDraft({ code }) action —
       * the IR-81A store invariant then keeps it UNTRUSTED (any code change
       * drops enabled=false), so AI-generated source is NEVER auto-enabled;
       * on a dirty buffer the modal's own diff/replace review governs
       * acceptance (no silent blind overwrite).
       */}
      <AiAssistantModal
        mode="full"
        apiMode="interactive_rules"
        isOpen={aiHelperOpen}
        onClose={() => setAiHelperOpen(false)}
        existingContent={activeScript.code}
        onInsert={(text) => updateScriptDraft({ code: text })}
        onReplace={(text) => updateScriptDraft({ code: text })}
      />

      {/*
       * IR-83B: the universal AI assistant, thin-wired exactly like the IR-82
       * interactive_rules integration but targeting the active VISUAL draft. It
       * generates OR repairs raw reviewable VISUAL source from the validated game
       * contract (discovered server-side from the active rules source via the new
       * interactiveRulesSource channel), the current visual source, and the author's
       * design direction. Output lands back in the VISUAL draft via the normal
       * updateVisualDraft({ source }) action — it NEVER touches the rules draft
       * (rules immutability). Visuals have no trusted/enabled gate (they run inside
       * a sandboxed iframe), so the write-back is a plain source edit; on a dirty
       * buffer the modal's own diff/replace review governs acceptance (no silent
       * blind overwrite, no auto-persist).
       */}
      <AiAssistantModal
        mode="full"
        apiMode="interactive_visual"
        isOpen={visualAiHelperOpen}
        onClose={() => setVisualAiHelperOpen(false)}
        existingContent={activeVisual?.source ?? ""}
        interactiveRulesSource={activeScript?.code ?? ""}
        onInsert={(text) => updateVisualDraft({ source: text })}
        onReplace={(text) => updateVisualDraft({ source: text })}
      />

      {/*
       * IR-90A: the above-the-fold playground launcher (header toolbar) opens
       * the SAME draft-bound playground in a shared Modal. No persistent write
       * and no second LIVE/API session is introduced — the playground never
       * persists and never creates an API session; closing the Modal writes
       * nothing. The inline instance is unmounted while this is open
       * (single-instance invariant, see the inline slot above).
       */}
      <Modal
        open={playgroundModalOpen}
        onClose={() => setPlaygroundModalOpen(false)}
        title={t("experience_editor_playground_modal_title")}
        description={t("experience_editor_playground_modal_title")}
      >
        <div className="flex max-h-[88vh] w-[min(760px,94vw)] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-xl">
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <span className="text-[13px] font-semibold text-t1">{t("experience_editor_playground_modal_title")}</span>
            <button
              type="button"
              aria-label={t("close")}
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1"
              onClick={() => setPlaygroundModalOpen(false)}
            >
              <Ic.close />
            </button>
          </div>
          <div className="overflow-y-auto p-4">
            <ExperiencePlayground code={activeScript.code} visualSource={activeVisual?.source ?? null} />
          </div>
        </div>
      </Modal>

      {/*
       * IR-90A: explicit destructive delete for the active visual, confirmed
       * via the shared DestructiveConfirmModal (same idiom as ScriptEditor).
       * A saved visual is DELETEd server-side; a pending visual is removed
       * locally. A live session that already pinned this visual keeps its own
       * immutable snapshot, so deletion never mutates a pinned source.
       */}
      {visualDeleteId && (
        <DestructiveConfirmModal
          title={t("experience_editor_visual_delete_title")}
          body={t("experience_editor_visual_delete_msg")}
          confirmLabel={t("experience_editor_visual_delete")}
          onConfirm={() => void handleDeleteVisual(visualDeleteId)}
          onCancel={() => { setVisualDeleteId(null); setVisualDeleteError(null); }}
        />
      )}
    </div>
  );
}
