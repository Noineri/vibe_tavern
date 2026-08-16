import type { ReactNode } from "react";
import { useCallback, useEffect, useState, useMemo } from "react";
import { useKeyDown } from "../../../hooks/use-key-down.js";
import { useReorderableList } from "../../../hooks/use-reorderable-list.js";
import { Ic } from "../../shared/icons.js";
import { AddButton } from "../../shared/add-button.js";
import { useIsMobile } from "../../../hooks/use-mobile.js";
import { MobileExpandTextarea } from "../../shared/MobileExpandTextarea.js";
import { AutoTextarea } from "../../shared/auto-textarea.js";
import { CodeEditor } from "../../shared/CodeEditor.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { DestructiveConfirmModal } from "../../shared/destructive-confirm-modal.js";
import { SaveButton } from "../../shared/SaveBar.js";
import { Toggle } from "../../shared/Toggle.js";
import { SCRIPT_TEMPLATES } from "./script-templates/index.js";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import { AiAssistantModal } from "../../shared/AiAssistantModal.js";
import { LinkBindingPopover, type LinkTarget } from "../../shared/LinkBindingPopover.js";
import { useAllCharacters } from "../../../stores/snapshot-store.js";
import { useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";
import { useBuildNavigationStore } from "../../../stores/build-navigation-store.js";
import {
  isScriptDraftDirty,
  useScriptDraftStore,
  type ScriptDraftValues,
} from "../../../stores/script-draft-store.js";
import {
  listAllScripts,
  listScripts,
  createScript,
  updateScript,
  deleteScript,
  importScript,
  getScriptLinks,
  setScriptLinks,
  type ScriptRecord,
  type ScriptLinkRecord,
} from "../../../app-client.js";
// ── Types ──────────────────────────────────────────────────────────────

import { LoreEntryList } from "./LoreEntryList.js";
import { ScriptTester } from "./ScriptTester.js";
import { DiceScriptTester } from "./DiceScriptTester.js";
import { ScriptApiReference } from "./script-api-reference.js";

// ── Types ──────────────────────────────────────────────────────────────

import type { Scope } from "./LorebookAccordion.js";
import {
	DndContext,
	DragOverlay,
	closestCenter,
} from "@dnd-kit/core";
import {
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
	arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

interface ScriptPanelProps {
  characterId: string;
  chatId: string | null;
  personaId: string | null;
  scope: Scope;
  onOpenEditor?: () => void;
  onBackToList?: () => void;
}

// ── Component ──────────────────────────────────────────────────────────
// ScriptPanel is a content-only component — no layout/scope/header.
// LorebookEditor manages tab, view, scope and renders these panels.

// Templates are imported from scriptTemplates.ts

/** Sortable wrapper for a script card in the list view. Mirrors LoreEntryList's
 *  SortableEntryCard: desktop drags the whole card (MouseSensor distance: 2
 *  keeps click-vs-drag distinct), mobile uses a ≡ handle as the activator. */
function SortableScriptCard({ script, isActive, isMobile, onClick }: {
	script: ScriptRecord;
	isActive: boolean;
	isMobile: boolean;
	onClick: () => void;
}) {
	const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: script.id });
	return (
		<div
			ref={setNodeRef}
			style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
			className={cn("mb-3 cursor-pointer rounded-xl border transition-all", isActive ? "border-accent bg-accent-dim" : "border-border bg-surface hover:bg-s2")}
			onClick={onClick}
			{...(isMobile ? {} : attributes)}
			{...(isMobile ? {} : listeners)}
		>
			<div className="flex items-center gap-2 px-4 pt-3 pb-3">
				{isMobile && (
					<button
						type="button"
						ref={setActivatorNodeRef}
						{...attributes}
						{...listeners}
						className="flex h-8 w-6 shrink-0 cursor-grab items-center justify-center text-t3 active:cursor-grabbing"
						onClick={e => e.stopPropagation()}
					>
						<span className="text-xl leading-none">≡</span>
					</button>
				)}
				<div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-dim text-accent-t"><Ic.terminal /></div>
				<span className="flex-1 truncate text-[14px] font-semibold text-t1">{script.name}</span>
				<div className="shrink-0 rounded px-1.5 py-0.5 font-ui text-[10px] uppercase tracking-wide bg-s3 text-t2 mr-1">
					{script.scriptKind === "dice" ? "DICE" : "PROMPT"}
				</div>
				<div className={cn("shrink-0 rounded-full px-2 py-0.5 font-ui text-[10px] font-medium uppercase", script.enabled ? "bg-success-dim text-success-text" : "bg-s3 text-t3")}>
					{script.enabled ? "ON" : "OFF"}
				</div>
			</div>
			{script.description && <div className="font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2 px-4 pb-3 pt-0">{script.description}</div>}
		</div>
	);
}

export function useScriptPanel({ characterId, chatId, personaId, scope, onOpenEditor, onBackToList }: ScriptPanelProps) {
  const { t, tDynamic } = useT();
  const isMobile = useIsMobile();

  const [activeScriptId, setActiveScriptIdRaw] = useState<string | null>(null);
  const setActiveScriptId = (id: string | null) => {
    setActiveScriptIdRaw(id);
    if (id && onOpenEditor) onOpenEditor();
  };
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importCode, setImportCode] = useState("");
  useKeyDown("Escape", () => setConfirmDeleteId(null), { enabled: !!confirmDeleteId });
  useKeyDown("Escape", () => { setImportOpen(false); setImportCode(""); }, { enabled: importOpen });
  const [apiRefOpen, setApiRefOpen] = useState(false);
  const [aiHelperOpen, setAiHelperOpen] = useState(false);

  // ── Queries (replaced with local state + async fetch) ────
  const scopeId = (() => {
    if (scope === "character") return characterId;
    if (scope === "persona") return personaId ?? undefined;
    if (scope === "chat") return chatId ?? undefined;
    return undefined;
  })();

  const [scripts, setScripts] = useState<ScriptRecord[]>([]);

  const refreshScripts = useCallback(async () => {
    // "all" — overview mode (read-only), returns all scripts with no scope filter.
    // Otherwise — filtered by scope + owner.
    // Interactive scripts are owned exclusively by the Experience editor;
    // exclude them here so they never enter this generic Prompt/Dice list
    // (never listed, never badged, never opened or tested as a prompt script).
    const all = scope === "all" ? await listAllScripts() : await listScripts(scope, scopeId);
    setScripts(all.filter((s) => s.scriptKind !== "interactive"));
  }, [scope, scopeId]);

  useEffect(() => { void refreshScripts(); }, [refreshScripts]);

  // ── Explicit authoring draft ────────────────────────────
  // Server records are the loaded base/list cache; editor fields come from a
  // dedicated Zustand draft that survives Build-panel unmounts and script
  // switches. Nothing persists until Save/Ctrl+S.
  const drafts = useScriptDraftStore((s) => s.drafts);
  const ensureDraft = useScriptDraftStore((s) => s.ensure);
  const patchDraft = useScriptDraftStore((s) => s.patch);
  const prepareSave = useScriptDraftStore((s) => s.prepareSave);
  const completeSave = useScriptDraftStore((s) => s.completeSave);
  const failSave = useScriptDraftStore((s) => s.failSave);
  const removeDraft = useScriptDraftStore((s) => s.remove);

  // Refresh clean draft bases from every loaded record while preserving dirty
  // buffers. This keeps master-list overlays current after a panel remount.
  useEffect(() => {
    for (const script of scripts) ensureDraft(script);
  }, [scripts, ensureDraft]);

  const activeScriptRecord = scripts.find((s) => s.id === activeScriptId) ?? null;
  const activeDraft = activeScriptId ? drafts[activeScriptId] ?? null : null;
  const activeScript = activeScriptRecord
    ? { ...activeScriptRecord, ...(activeDraft?.values ?? {}) }
    : null;
  const draftDirty = isScriptDraftDirty(activeDraft);
  const draftSaveState = activeDraft?.saveState ?? "idle";

  const updateDraft = (patch: Partial<ScriptDraftValues>) => {
    if (!activeScriptRecord) return;
    // Selection normally initializes in the effect above; ensure here too so
    // even an edit in the first painted frame cannot be dropped.
    ensureDraft(activeScriptRecord);
    patchDraft(activeScriptRecord.id, patch);
  };

  // ── Link binding (forward direction: bind THIS script to characters/personas).
  // Mirrors LorebookEditor's per-lorebook link state, but a single active script
  // (not a list), so a flat array is enough.
  const [scriptLinks, setScriptLinksState] = useState<ScriptLinkRecord[]>([]);
  const allCharacters = useAllCharacters();
  const personas = useBootstrapStore((s) => s.personas) ?? [];
  const linkCharacters: LinkTarget[] = allCharacters.map((c) => ({
    id: c.id, name: c.name, avatarAssetId: c.avatarAssetId, kind: "characters",
    avatarExt: c.avatarExt, avatarFullExt: c.avatarFullExt, avatarFullAssetId: c.avatarFullAssetId, updatedAt: c.updatedAt,
  }));
  const linkPersonas: LinkTarget[] = personas.map((p) => ({
    id: p.id, name: p.name, avatarAssetId: p.avatarAssetId, kind: "personas",
    avatarExt: p.avatarExt, avatarFullExt: p.avatarFullExt, updatedAt: p.updatedAt,
  }));

  useEffect(() => {
    if (!activeScriptId) { setScriptLinksState([]); return; }
    let cancelled = false;
    getScriptLinks(activeScriptId)
      .then((links) => { if (!cancelled) setScriptLinksState(links); })
      .catch(() => { if (!cancelled) setScriptLinksState([]); });
    return () => { cancelled = true; };
  }, [activeScriptId]);

  const handleSetScriptLinks = async (next: Array<{ targetType: "character" | "persona"; targetId: string }>) => {
    if (!activeScriptId) return;
    const updated = await setScriptLinks(activeScriptId, next);
    setScriptLinksState(updated);
  };

  // ── Mutations ───────────────────────────────────────────
  // CRUD updates the local list from endpoint return values. PATCH never
  // refetches the whole list: a server roundtrip must not become editor input.
  const replaceScriptRecord = useCallback((updated: ScriptRecord) => {
    setScripts((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
  }, []);

  const handleCreateScript = async (body: Parameters<typeof createScript>[0]) => {
    const created = await createScript(body);
    setScripts((prev) => [...prev, created]);
    ensureDraft(created);
    setActiveScriptId(created.id);
  };

  /** Immediate persistence for non-authoring list metadata (currently DnD
   *  sortOrder). Editable fields use the explicit Save path below. */
  const persistScriptPatch = async (id: string, body: Parameters<typeof updateScript>[1]) => {
    const updated = await updateScript(id, body);
    replaceScriptRecord(updated);
    return updated;
  };

  const handleSave = useCallback(async () => {
    if (!activeScriptId) return;
    const submitted = prepareSave(activeScriptId);
    if (!submitted) return;
    try {
      const updated = await updateScript(activeScriptId, submitted);
      completeSave(activeScriptId, submitted, updated);
      replaceScriptRecord(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failSave(activeScriptId, message);
    }
  }, [activeScriptId, prepareSave, completeSave, replaceScriptRecord, failSave]);

  useKeyDown(["s", "S"], (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    void handleSave();
  }, { enabled: !!activeScriptId && draftDirty && draftSaveState !== "saving" });

  const handleDeleteScript = async (id: string) => {
    // Close the confirm modal first (matches the shared-modal convention used
    // by VersionSwitcher / GalleryGrid: close-on-confirm, fire delete in the
    // background). No disabled flag needed — the confirm button unmounts.
    setConfirmDeleteId(null);
    await deleteScript(id);
    setScripts((prev) => prev.filter((s) => s.id !== id));
    removeDraft(id);
    if (activeScriptId === id) setActiveScriptIdRaw(null);
    onBackToList?.();
  };

  // ── Drag-reorder (P5b) ────────────────────────────────
  // Mechanics (sensors, active-drag id, optimistic/reconcile/rollback) live in
  // useReorderableList; this consumer owns only the flat-sortOrder semantics:
  // arrayMove for the optimistic order, sortOrder=index renumber, and the
  // diff-and-PATCH persist. Each PATCH response replaces its local record, so
  // the hook reconciles (clears optimistic) without a whole-list refetch.
  const { displayItems, sensors, activeDragItem: activeDragScript, handleDragStart, handleDragEnd, handleDragCancel } = useReorderableList({
    items: scripts,
    getId: (s) => s.id,
    onReorder: (activeId, overId, displayItems) => {
      const displayScripts = [...displayItems].sort((a, b) => a.sortOrder - b.sortOrder);
      const oldIndex = displayScripts.findIndex(s => s.id === activeId);
      const newIndex = displayScripts.findIndex(s => s.id === overId);
      if (oldIndex === -1 || newIndex === -1) {
        return { optimisticItems: displayScripts, persist: () => {} };
      }
      // Reassign sortOrder = index; collect only changed scripts to persist.
      const reordered = arrayMove(displayScripts, oldIndex, newIndex);
      const updates: Array<{ id: string; sortOrder: number }> = [];
      const optimistic = reordered.map((s, i) => {
        if (s.sortOrder !== i) updates.push({ id: s.id, sortOrder: i });
        return { ...s, sortOrder: i };
      });
      return {
        optimisticItems: optimistic,
        persist: () => Promise.all(updates.map((u) => persistScriptPatch(u.id, { sortOrder: u.sortOrder }))),
      };
    },
  });

  // Sort by sortOrder and overlay any unsaved authoring fields. The master
  // list therefore reflects the same draft the editor shows, even after the
  // World & Lore panel has unmounted/remounted around a server reload.
  const displayScripts = useMemo(
    () => [...displayItems]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((script) => ({ ...script, ...(drafts[script.id]?.values ?? {}) })),
    [displayItems, drafts],
  );
  const activeDragDisplay = activeDragScript
    ? { ...activeDragScript, ...(drafts[activeDragScript.id]?.values ?? {}) }
    : null;

  const handleImportScript = async (code: string) => {
    const imported = await importScript({ format: "js", code, scopeType: scope, characterId: scope === "character" ? characterId : undefined, personaId: scope === "persona" ? personaId ?? undefined : undefined, chatId: scope === "chat" ? chatId ?? undefined : undefined });
    setScripts((prev) => [...prev, imported]);
    ensureDraft(imported);
    setActiveScriptId(imported.id);
    setImportOpen(false);
    setImportCode("");
  };

  // ── Scope-aware body helper ──────────────────────────────
  // "all" — overview mode with no specific owner; creating/importing scripts
  // is disabled there (CTAs are hidden in LorebookEditor), the fallback is purely defensive.
  const scopeBody = () => {
    const effectiveScope: Exclude<Scope, "all"> = scope === "all" ? "character" : scope;
    const base: Record<string, string | undefined> = { scopeType: effectiveScope };
    if (effectiveScope === "character") base.characterId = characterId;
    if (effectiveScope === "persona") base.personaId = personaId ?? undefined;
    if (effectiveScope === "chat") base.chatId = chatId ?? undefined;
    return base;
  };

  // ── Handlers ─────────────────────────────────────────────
  const handleAdd = (kind: "prompt" | "dice" = "prompt", creationIntentId?: string) => {
    const body = { name: "New Script", code: "", scriptKind: kind, creationIntentId, ...scopeBody() } as Parameters<typeof createScript>[0];
    handleCreateScript(body);
  };

  const handleAddFromTemplate = (key: string, creationIntentId?: string) => {
    const tpl = SCRIPT_TEMPLATES[key];
    if (!tpl) return;
    if (activeScript) {
      updateDraft({ code: activeScript.code ? activeScript.code + "\n\n" + tpl.code : tpl.code });
    } else {
      void handleCreateScript({ name: tpl.name, code: tpl.code, scriptKind: tpl.scriptKind || "prompt", creationIntentId, ...scopeBody() } as Parameters<typeof createScript>[0]);
    }
  };

  useEffect(() => {
    const state = useBuildNavigationStore.getState();
    const intent = state.diceCreateIntent;
    if (intent && intent.scope.type === scope) {
      state.consumeDiceCreateIntent();
      if (intent.template === "fate_die") {
        handleAddFromTemplate("fate_die", intent.createIntentId);
      } else {
        handleAdd("dice", intent.createIntentId);
      }
    }
  }, [scope]);

  // ── Modals ───────────────────────────────────────────────
  const modals = (
    <>
      {confirmDeleteId && (
        <DestructiveConfirmModal
          title={t("delete_script_confirm")}
          body={t("delete_script_msg")}
          confirmLabel={t("delete_script_confirm")}
          onConfirm={() => void handleDeleteScript(confirmDeleteId)}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}
      {importOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onClick={() => { setImportOpen(false); setImportCode(""); }}>
          <div className="flex w-[520px] max-w-[90vw] flex-col overflow-hidden rounded-xl border border-border bg-surface" style={{ maxHeight: "80vh" }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border" style={{ padding: "16px 20px" }}>
              <span className="text-sm font-semibold text-t1">{t("script_import_title")}</span>
              <div className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={() => { setImportOpen(false); setImportCode(""); }}><Ic.close /></div>
            </div>
            <div className="flex-1 overflow-y-auto" style={{ padding: 20 }}>
              <div className="mb-3 text-[13px] text-t2">{t("script_import_paste")}</div>
              <MobileExpandTextarea value={importCode} onChange={setImportCode} label={t("script_import_import")}>
                <AutoTextarea className="w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-[12px] leading-[1.6] text-t1 outline-none focus:border-accent" style={{}} maxRows={25} minRows={10} placeholder={t("script_import_placeholder")} value={importCode} onChange={e => setImportCode(e.target.value)} />
              </MobileExpandTextarea>
              {importCode.trim() && (
                <div className="mt-2 text-[11px] text-accent-t">
                  {(importCode.trim().startsWith("{") || importCode.trim().startsWith("[")) ? t("script_import_detect_json") : t("script_import_detect_js")}
                </div>
              )}
              <div className="mt-3 text-[11px] text-t3">{t("script_templates")}:</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {Object.entries(SCRIPT_TEMPLATES).map(([key, tpl]) => (
                  <button type="button" key={key} className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1" onClick={() => { handleAddFromTemplate(key); setImportOpen(false); setImportCode(""); }}>{tDynamic("script_template_" + key) || tpl.name}</button>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-border" style={{ padding: "12px 20px" }}>
              <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1" onClick={() => { setImportOpen(false); setImportCode(""); }}>{t("cancel")}</button>
              <button type="button" className="h-9 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all" onClick={() => handleImportScript(importCode)} disabled={!importCode.trim()}>{t("script_import_import")}</button>
            </div>
          </div>
        </div>
      )}
      <AiAssistantModal
        mode="full"
        apiMode={activeScript?.scriptKind === "dice" ? "dice_script" : "script"}
        isOpen={aiHelperOpen}
        onClose={() => setAiHelperOpen(false)}
        existingContent={activeScript?.code ?? ""}
        onInsert={(text) => updateDraft({ code: text })}
        onReplace={(text) => updateDraft({ code: text })}
        scopeContext={{
          characterId: characterId,
          personaId: personaId ?? undefined,
        }}
      />
    </>
  );

  // ── Script list (for LorebookEditor list view) ────────────
  const scriptListContent = (
    <div className="flex-1 overflow-y-auto pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]" style={{ padding: isMobile ? "12px" : "20px 24px" }}>
      {scripts.length === 0 ? (
        <div className="py-10 text-center">
          <div className="mb-2 text-[13px] text-t3">{t("script_no_scripts")}</div>
          <div className="flex justify-center gap-2">
            <AddButton onClick={() => handleAdd()}>
              <Ic.plus /> {t("new_script")}
            </AddButton>
            <AddButton onClick={() => handleAdd("dice")}>
              <Ic.dice /> {t("new_dice_script")}
            </AddButton>
            <AddButton onClick={() => setImportOpen(true)}>
              <Ic.import /> {t("script_import")}
            </AddButton>
          </div>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <SortableContext items={displayScripts.map(s => s.id)} strategy={verticalListSortingStrategy}>
            {displayScripts.map(s => (
              <SortableScriptCard
                key={s.id}
                script={s}
                isActive={s.id === activeScriptId}
                isMobile={isMobile}
                onClick={() => setActiveScriptId(s.id)}
              />
            ))}
            <div className="mt-2 flex flex-wrap gap-2">
              <AddButton onClick={() => handleAdd()}><Ic.plus /> {t("new_script")}</AddButton>
              <AddButton onClick={() => handleAdd("dice")}><Ic.dice /> {t("new_dice_script")}</AddButton>
              <AddButton onClick={() => setImportOpen(true)}><Ic.import /> {t("script_import")}</AddButton>
            </div>
          </SortableContext>
          <DragOverlay dropAnimation={null}>
            {activeDragDisplay ? (
              <div className={cn("rounded-xl border", activeDragDisplay.id === activeScriptId ? "border-accent bg-accent-dim" : "border-border bg-surface")}>
                <div className="flex items-center gap-2 px-4 pt-3 pb-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-dim text-accent-t"><Ic.terminal /></div>
                  <span className="flex-1 truncate text-[14px] font-semibold text-t1">{activeDragDisplay.name}</span>
                  <div className="shrink-0 rounded px-1.5 py-0.5 font-ui text-[10px] uppercase tracking-wide bg-s3 text-t2 mr-1">
                    {activeDragDisplay.scriptKind === "dice" ? "DICE" : "PROMPT"}
                  </div>
                  <div className={cn("shrink-0 rounded-full px-2 py-0.5 font-ui text-[10px] font-medium uppercase", activeDragDisplay.enabled ? "bg-success-dim text-success-text" : "bg-s3 text-t3")}>
                    {activeDragDisplay.enabled ? "ON" : "OFF"}
                  </div>
                </div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );

  // ── Script editor panel (for LorebookEditor editor view) ──
  const scriptEditorPanel = activeScript ? (
    <div className={cn("mx-auto max-w-[860px]", isMobile && "pb-[calc(4rem+env(safe-area-inset-bottom,0px))] [&_button]:min-h-[40px] [&_input]:text-base")}>
      {/* Explicit-save status + action. Ctrl/Cmd+S calls the same handler. */}
      <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-border bg-s2 px-3 py-2">
        <span
          className={cn("min-w-0 truncate font-ui text-[12px]", draftSaveState === "error" ? "text-danger" : "text-t3")}
          title={activeDraft?.error ?? undefined}
        >
          {draftSaveState === "error" ? t("retry") : draftDirty ? t("unsaved_changes") : t("saved_state")}
        </span>
        <SaveButton
          dirty={draftDirty}
          saveState={draftSaveState}
          resetKey={activeScriptId}
          onClick={() => void handleSave()}
          label={draftSaveState === "error" ? t("retry") : t("save")}
        />
      </div>

      {/* Header: name + toggle + delete */}
      <div className="flex flex-col gap-3" style={{ marginBottom: 16 }}>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1"><input className="w-full rounded-md border border-border bg-s2 px-2.5 py-1.5 text-[15px] font-semibold text-t1 outline-none focus:border-accent" type="text" value={activeScript.name} onChange={(e) => updateDraft({ name: e.target.value })} placeholder={t("script_name")} /></div>
          <Toggle checked={activeScript.enabled} onChange={(enabled) => updateDraft({ enabled })} />
          <CustomTooltip content={t("delete_script_confirm")}>
            <div className="flex h-8 w-8 cursor-pointer items-center justify-center rounded text-danger transition-all hover:bg-s2" onClick={() => setConfirmDeleteId(activeScript.id)}><Ic.del /></div>
          </CustomTooltip>
        </div>
        <div className="flex items-center">
          {/* Script kind is immutable after creation — set via the New Script /
              New Dice Script buttons. Shown as a read-only badge so the user
              always sees which runtime a script targets. The previous kind
              toggle was removed: it could never persist (updateScriptSchema
              excludes scriptKind), so it silently reverted on save. */}
          <div className="rounded px-2 py-1 font-ui text-[11px] uppercase tracking-wide bg-s3 text-t2">
            {activeScript.scriptKind === "dice" ? t("script_kind_dice") : t("script_kind_prompt")}
          </div>
        </div>
      </div>

      {/* Description */}
      <div style={{ marginBottom: 16 }}>
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_desc_label")}</label>
        <input className="w-full rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent" value={activeScript.description ?? ""} onChange={(e) => updateDraft({ description: e.target.value })} placeholder={t("script_desc_placeholder")} />
      </div>

      {/* Link binding (forward): bind this script to additional characters/personas */}
      {scope !== "chat" && (
        <div style={{ marginBottom: 16 }}>
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_links_label")}</span>
            <CustomTooltip content={t("script_links_hint")}>
              <span className="cursor-help text-t4 text-[11px]">ⓘ</span>
            </CustomTooltip>
          </div>
          <LinkBindingPopover
            links={scriptLinks}
            characters={linkCharacters}
            personas={linkPersonas}
            onSetLinks={(next) => { void handleSetScriptLinks(next as Array<{ targetType: "character" | "persona"; targetId: string }>); }}
            t={t}
            isMobile={isMobile}
            tooltipLabel={t("script_links_add")}
            emptyLabel={t("script_links_empty")}
          />
        </div>
      )}

      {/* Toolbar */}
      <div className="mb-2 flex flex-wrap gap-2">
        <button type="button" className={cn("flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 font-ui text-[11px] transition-all hover:bg-s2 hover:text-t1", apiRefOpen ? "bg-accent-dim text-accent-t" : "bg-s3 text-t2")} onClick={() => setApiRefOpen(v => !v)}><Ic.book /> {t("script_api_reference")}</button>
        <button type="button" className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1" onClick={() => setAiHelperOpen(true)}><Ic.brain /> {t("script_ai_helper")}</button>
      </div>

      {/* API Reference */}
      {apiRefOpen && (
        <ScriptApiReference kind={activeScript.scriptKind || "prompt"} />
      )}

      {/* Code editor */}
      <div style={{ marginBottom: 20 }}>
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("script_code_label")}</label>
        <div className="relative rounded-md border border-border bg-bg">
          <CodeEditor
            value={activeScript.code}
            onChange={(code) => updateDraft({ code })}
            minHeight={isMobile ? "220px" : "300px"}
            scrollMode={isMobile ? "page" : "inner"}
          />
        </div>
      </div>

      {/* Templates */}
      <div className="mb-4">
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">{t("script_templates")}</div>
        <div className="flex flex-wrap gap-2">
          {Object.entries(SCRIPT_TEMPLATES).map(([key, tpl]) => (
            <button type="button" key={key} className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[11px] text-t2 transition-all hover:bg-s2 hover:text-t1" onClick={() => handleAddFromTemplate(key)}>{tDynamic("script_template_" + key) || tpl.name}</button>
          ))}
        </div>
      </div>

      {activeScript.scriptKind === "dice" ? (
        <DiceScriptTester scriptId={activeScriptId} code={activeScript.code} isMobile={isMobile} characterName={scope === "character" ? allCharacters.find(x => x.id === characterId)?.name : undefined} />
      ) : (
        <ScriptTester scriptId={activeScriptId} code={activeScript.code} isMobile={isMobile} characterName={scope === "character" ? allCharacters.find(x => x.id === characterId)?.name : undefined} />
      )}
    </div>
  ) : (
    <div className="flex h-full items-center justify-center text-t3 font-ui text-[13px] italic">
      {t("script_test_no_result")}
    </div>
  );

  return { modals, scriptListContent, scriptEditorPanel, activeScriptId, setActiveScriptId, handleAdd: () => handleAdd(), handleAddDice: () => handleAdd("dice"), handleImportOpen: () => setImportOpen(true) };
}
