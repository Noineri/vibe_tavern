/**
 * LorebookEditor — root component managing lorebooks and scripts.
 *
 * Responsible for:
 *   - Navigation between views: pick → list → editor
 *   - Scope selection (global / character / persona / chat)
 *   - Switching between lorebooks / scripts tabs
 *   - Lorebook CRUD (create, meta update, delete)
 *   - Entry CRUD (create, autosave, delete)
 *
 * Visual sub-components are extracted into separate files:
 *   - LorebookAccordion — expanded accordion for a single lorebook
 *   - LoreEntryEditor — entry editing form
 *   - LorebookImportModal — 3-step import wizard
 *   - ScriptEditor (useScriptPanel) — script editor
 */
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useKeyDown } from "../../../hooks/use-key-down.js";
import { FormProvider } from "react-hook-form";

import { Ic } from "../../shared/icons.js";
import { AddButton } from "../../shared/add-button.js";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import {
  createLorebook,
  updateLorebookMeta,
  deleteLorebook,
  createLoreEntry,
  updateLoreEntry,
  reorderLoreEntries,
  duplicateLorebook,
  exportLorebookSt,
  type LoreEntryRecord,
} from "../../../app-client.js";

import {
  useLorebookEditorState,
  writeStickyWorldLoreTab,
  type Tab,
} from "./use-lorebook-editor-state.js";
import { useScriptPanel } from "./ScriptEditor.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { LorebookAccordion } from "./LorebookAccordion.js";
import type { Scope } from "./LorebookAccordion.js";
import type { LinkTarget } from "../../shared/LinkBindingPopover.js";
import { LoreEntryEditor } from "./LoreEntryEditor.js";
import { LorebookImportModal } from "./LorebookImportModal.js";
import { buildLorebookCreateBody } from "./lorebook-create-body.js";
import { useAllCharacters } from "../../../stores/snapshot-store.js";
import { useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";

// ── Types ──────────────────────────────────────────────────────────────

interface LorebookEditorProps {
  characterId: string;
  chatId: string | null;
  personaId: string | null;
}

// View-transition keyframes (lbFadeOut / lbFadeIn / lbSlideIn) live in
// styles.css — no runtime <style> injection.

// ── Mobile detection hook ──

function useIsMobile() {
  const [mobile, setMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < 768 : false
  );
  useEffect(() => {
    const handler = () => setMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return mobile;
}

// ════════════════════════════════════════════════════════════════════════
// Main component
// ════════════════════════════════════════════════════════════════════════

export function LorebookEditor({
  characterId,
  chatId,
  personaId,
}: LorebookEditorProps) {
  const { t } = useT();
  const isMobile = useIsMobile();

  // ── Data + navigation state (extracted controller) ──
  // See use-lorebook-editor-state.ts. Destructured under the original names
  // so the handlers and render below read identically to the pre-extraction
  // code — this is a relocation, not a redesign.
  const {
    view,
    tab,
    scope,
    setView,
    setTab,
    setScope,
    activeEntryId,
    activeLorebookIdForEntry,
    setActiveEntryId,
    setActiveLorebookIdForEntry,
    lorebooks,
    lorebookLinksMap,
    activeEntry,
    existingGroups,
    refreshEntries,
    savingState,
    flushSave,
    refreshLorebooks,
    handleSetLinks,
    form,
  } = useLorebookEditorState({ characterId, chatId, personaId });

  // Transition animations — event-driven phase machine (no setTimeout chain):
  //   handlePick → phase "fading" → pick card onAnimationEnd (lbFadeOut) →
  //   phase "done" + view "list" → list onAnimationEnd (lbFadeIn) → phase "idle".
  const [phase, setPhase] = useState<"idle" | "fading" | "done">("idle");
  const [fadingTab, setFadingTab] = useState<Tab | null>(null);

  // ── Expanded accordions ──
  const [expandedLorebooks, setExpandedLorebooks] = useState<Set<string>>(
    new Set()
  );

  const toggleLorebook = (id: string) => {
    setExpandedLorebooks((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  useEffect(() => {
    window.__setLorebookView = setView;
    window.__setLorebookTab = setTab;
    window.__getLorebookView = () => view;
    return () => {
      delete (window as Partial<Window>).__setLorebookView;
      delete (window as Partial<Window>).__setLorebookTab;
      delete (window as Partial<Window>).__getLorebookView;
    };
  }, [view]);

  // ── pick → list transition ──
  const handlePick = (target: Tab) => {
    setTab(target);
    writeStickyWorldLoreTab(target);
    setFadingTab(target);
    setPhase("fading");
    // The view swap is driven by the pick card's onAnimationEnd (lbFadeOut)
    // below — no setTimeout coordination. The 260/300ms magic delays are gone;
    // only the legitimate keyframe durations remain in the class strings.
  };

  const handleBackToPick = () => {
    void discardCreatedLorebookDraft();
    writeStickyWorldLoreTab(null);
    setView("pick");
    setActiveEntryId(null);
    scriptPanel.setActiveScriptId(null);
    setPhase("idle");
  };

  const handleSwitchTab = (target: Tab) => {
    if (target === tab) return;
    writeStickyWorldLoreTab(target);
    setTab(target);
    setView("list");
    setActiveEntryId(null);
    scriptPanel.setActiveScriptId(null);
    setPhase("idle");
    setFadingTab(null);
  };

  // ── Lorebook meta editing (inline in the accordion) ──
  const [editingLorebookId, setEditingLorebookId] = useState<string | null>(
    null
  );
  const [editLbName, setEditLbName] = useState("");
  const [editLbScope, setEditLbScope] = useState<Scope>("character");
  const [createdDraftLorebookId, setCreatedDraftLorebookId] = useState<string | null>(null);

  // ── Mobile context menu ──
  const [actionMenuLorebookId, setActionMenuLorebookId] = useState<
    string | null
  >(null);

  // ── Scripts hook ──
  const scriptPanel = useScriptPanel({
    characterId,
    chatId,
    personaId,
    scope,
    onOpenEditor: () => setView("editor"),
    onBackToList: () => setView("list"),
  });

  // ── Lorebook delete confirmation ──
  const [confirmDeleteLorebook, setConfirmDeleteLorebook] = useState<
    string | null
  >(null);
  useKeyDown("Escape", () => setConfirmDeleteLorebook(null), { enabled: !!confirmDeleteLorebook });

  // ── Import modal ──
  const [importOpen, setImportOpen] = useState(false);

  // ── Reference data for link popover ──
  const allCharacters = useAllCharacters();
  const personas = useBootstrapStore((s) => s.personas) ?? [];
  const linkCharacters: LinkTarget[] = allCharacters.map((c) => ({
    id: c.id,
    name: c.name,
    avatarAssetId: c.avatarAssetId,
    kind: "characters",
    avatarExt: c.avatarExt,
    avatarFullExt: c.avatarFullExt,
    avatarFullAssetId: c.avatarFullAssetId,
    updatedAt: c.updatedAt,
  }));
  const linkPersonas: LinkTarget[] = personas.map((p) => ({
    id: p.id,
    name: p.name,
    avatarAssetId: p.avatarAssetId,
    kind: "personas",
    avatarExt: p.avatarExt,
    avatarFullExt: p.avatarFullExt,
    updatedAt: p.updatedAt,
  }));

  // ═══ Lorebook mutations ═══

  async function discardCreatedLorebookDraft(): Promise<void> {
    const draftId = createdDraftLorebookId;
    if (!draftId) return;
    setCreatedDraftLorebookId(null);
    setEditingLorebookId((current) => current === draftId ? null : current);
    setExpandedLorebooks((prev) => {
      const next = new Set(prev);
      next.delete(draftId);
      return next;
    });
    try {
      await deleteLorebook(draftId);
      await refreshLorebooks();
    } catch {
      // Best-effort cleanup on cancel/back; avoid blocking navigation.
    }
  }

  const handleCreateLb = async (body: {
    name: string;
    scopeType: string;
    characterId?: string;
    personaId?: string;
    chatId?: string;
  }) => {
    await discardCreatedLorebookDraft();
    const newLb = await createLorebook(body);
    setCreatedDraftLorebookId(newLb.id);
    await refreshLorebooks();
    setExpandedLorebooks((prev) => new Set([...prev, newLb.id]));
    setEditingLorebookId(newLb.id);
    setEditLbName(newLb.name);
    // Mirror onStartEdit: seed the scope picker so the inline edit form that
    // opens immediately reflects the just-created scope (not a stale leftover).
    setEditLbScope(newLb.scopeType as Scope);
  };

  const handleUpdateLb = async (
    id: string,
    body: Parameters<typeof updateLorebookMeta>[1]
  ) => {
    await updateLorebookMeta(id, body);
    if (createdDraftLorebookId === id) setCreatedDraftLorebookId(null);
    await refreshLorebooks();
    setEditingLorebookId(null);
  };

  const handleReorderEntries = async (
    lorebookId: string,
    updates: Array<{ id: string; sortOrder: number; position?: string }>
  ) => {
    return reorderLoreEntries(lorebookId, updates);
  };

  // Entry-level enabled toggle, called from the entry list row switch.
  // Returns the updated record so the accordion can patch its local list.
  const handleToggleEntryEnabled = async (
    lorebookId: string,
    entryId: string,
    enabled: boolean,
  ): Promise<LoreEntryRecord> => {
    return updateLoreEntry(lorebookId, entryId, { enabled });
  };

  const handleDeleteLb = async (id: string) => {
    await deleteLorebook(id);
    if (createdDraftLorebookId === id) setCreatedDraftLorebookId(null);
    await refreshLorebooks();
    setConfirmDeleteLorebook(null);
  };

  // ── Duplicate lorebook ──
  const handleDuplicateLb = async (lorebookId: string) => {
    const result = await duplicateLorebook(lorebookId);
    await refreshLorebooks();
    setExpandedLorebooks((prev) => new Set([...prev, result.lorebook.id]));
  };

  // ── Export lorebook (ST format download) ──
  const handleExportLb = async (lorebookId: string) => {
    const lb = lorebooks.find((l) => l.id === lorebookId);
    const data = await exportLorebookSt(lorebookId);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(lb?.name ?? "lorebook").replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ═══ Entry mutations ═══

  const handleAddEntry = (lorebookId: string) => {
    const newEntry: Partial<LoreEntryRecord> = {
      title: t("lore_add_entry"),
      keys: [],
      secondaryKeys: [],
      content: "",
      logic: "AND_ANY",
      position: "before_char",
      depth: 4,
      priority: 10,
      stickyWindow: 0,
      cooldownWindow: 0,
      delayWindow: 0,
      enabled: true,
      constant: false,
      probability: 100,
      ignoreBudget: false,
      role: "system",
      groupName: "",
      groupWeight: 100,
      prioritizeInclusion: false,
      useGroupScoring: false,
      excludeRecursion: false,
      preventRecursion: false,
      delayUntilRecursion: false,
      recursionLevel: 0,
      scanDepthOverride: null,
      caseSensitive: false,
      matchWholeWords: false,
      characterFilter: [],
      characterFilterExclude: false,
      matchSources: [],
    };
    void createLoreEntry(lorebookId, newEntry).then(async (created) => {
      if (created) {
        // Refetch so the new entry lands in `entries` before we switch to it.
        // activeLorebookIdForEntry may already be this lorebook (e.g. adding
        // after returning to the list from an editor), in which case the
        // entry-loading effect won't refetch on its own and activeEntry would
        // resolve to null. No-op when activeLorebookIdForEntry is null (first
        // open): setActiveLorebookIdForEntry below triggers the effect.
        await refreshEntries();
        setActiveEntryId(created.id);
        setActiveLorebookIdForEntry(lorebookId);
        setView("editor");
      }
    });
  };

  const handleEntryClick = (lorebookId: string, entryId: string) => {
    setActiveEntryId(entryId);
    setActiveLorebookIdForEntry(lorebookId);
    setView("editor");
  };

  const handleDuplicateEntry = (lorebookId: string) => {
    // Snapshot the form's current values (includes any uncommitted edits) and
    // strip the non-editable identity fields — the backend assigns fresh ones
    // for the copy. createLoreEntry resolves to the created record; switching
    // to it via setActiveEntryId flushes the SOURCE entry's pending edits first
    // (the autosave invariant), so the original is persisted with the same
    // edits the copy was created from — nothing is lost.
    const { id: _id, lorebookId: _lb, sortOrder: _so, ...fields } = form.getValues();
    void createLoreEntry(lorebookId, fields).then(async (created) => {
      if (!created) return;
      // We're already in this lorebook's editor, so activeLorebookIdForEntry
      // won't change and the entry-loading effect won't refetch on its own —
      // without this, the copy never enters `entries`, activeEntry resolves to
      // null, and the editor view falls through to the script panel (a blank
      // screen until a full page reload).
      await refreshEntries();
      setActiveEntryId(created.id);
      setActiveLorebookIdForEntry(lorebookId);
      setView("editor");
    });
  };

  // ═══ Helpers ═══

  const handleAddLorebook = () => {
    // `scope` is the list filter (may be "all"); buildLorebookCreateBody
    // coerces "all" → "character" so creation works from every filter,
    // including the overview. The new lorebook opens in the inline edit
    // form where its scope can be changed.
    const body = buildLorebookCreateBody(
      scope,
      { characterId, personaId, chatId },
      t("new_lorebook"),
    );
    handleCreateLb(body);
  };

  const saveLorebookEdit = () => {
    if (!editingLorebookId) return;
    handleUpdateLb(editingLorebookId, {
      name: editLbName,
      scopeType: editLbScope,
    });
  };

  // ══════════════════════════════════════════════════════════════════════
  // UI fragments
  // ══════════════════════════════════════════════════════════════════════

  // ── Scope column (desktop: vertical with icons) ──
  // The "all" label depends on the active tab — "All lorebooks" / "All scripts".
  // Other scope names (Global/Character/...) are invariant across tabs.
  const allLabel = tab === "lorebooks" ? t("scope_all") : t("scope_all_scripts");
  const scopeItems: { id: Scope; icon: ReactNode; label: string }[] = [
    { id: "all", icon: <Ic.stack />, label: allLabel },
    { id: "global", icon: <Ic.globe />, label: t("scope_global") },
    { id: "character", icon: <Ic.book />, label: t("scope_char") },
    { id: "persona", icon: <Ic.user />, label: t("scope_persona") },
    { id: "chat", icon: <Ic.chat />, label: t("scope_chat") },
  ];

  const scopeColumn = !isMobile ? (
    <div
      className="flex shrink-0 flex-col items-center gap-1 border-r border-border bg-surface"
      style={{ width: 48, padding: "12px 0" }}
    >
      {scopeItems.map((s) => (
        <CustomTooltip content={s.label} key={s.id}>
          <div
            className={cn(
              "relative flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg transition-all hover:bg-s2",
              scope === s.id && "bg-accent-dim text-accent-t"
            )}
            onClick={() => setScope(s.id)}
          >
            {s.icon}
          </div>
        </CustomTooltip>
      ))}
    </div>
  ) : null;

  // ── Scope bar (mobile: horizontal chips) ──
  const scopeBarMobile = isMobile ? (
    <div
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-border scrollbar-hide"
      style={{ padding: "8px 12px" }}
    >
      {scopeItems.map((s) => (
        <div
          key={s.id}
          className={cn(
            "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 font-ui text-[11px] font-medium transition-all select-none",
            scope === s.id
              ? "bg-accent text-on-accent"
              : "text-t3 bg-transparent hover:bg-s2 active:bg-s3"
          )}
          onClick={() => setScope(s.id)}
        >
          <span className="flex h-4 w-4 items-center justify-center">
            {s.icon}
          </span>
          <span className="whitespace-nowrap">{s.label}</span>
        </div>
      ))}
    </div>
  ) : null;

  // ── View: Pick (choose Lorebooks / Scripts) ──
  const pickView = (
    <div
      className="flex h-full flex-col items-center justify-center"
      style={{ padding: isMobile ? 16 : 40 }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "280px 280px",
          gap: 24,
        }}
      >
        <div
          className={cn(
            "flex cursor-pointer flex-col items-center rounded-xl border-2 border-border bg-surface transition-[border-color,box-shadow] hover:border-accent hover:shadow-theme-md",
            phase === "fading" &&
              fadingTab === "lorebooks" &&
              "animate-[lbFadeOut_250ms_ease-in_forwards]"
          )}
          style={{ padding: isMobile ? "28px 24px" : "40px 36px" }}
          onClick={() => phase === "idle" && handlePick("lorebooks")}
          onAnimationEnd={() => {
            if (phase === "fading") {
              setView("list");
              setPhase("done");
            }
          }}
        >
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent-dim text-accent-t">
            <Ic.book />
          </div>
          <div className="font-ui text-[15px] font-semibold text-t1">
            {t("lorebooks_card_title")}
          </div>
          <div className="mt-2 text-center font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t3">
            {t("lorebooks_card_desc")}
          </div>
        </div>
        <div
          className={cn(
            "flex cursor-pointer flex-col items-center rounded-xl border-2 border-border bg-surface transition-[border-color,box-shadow] hover:border-accent hover:shadow-theme-md",
            phase === "fading" &&
              fadingTab === "scripts" &&
              "animate-[lbFadeOut_250ms_ease-in_forwards]"
          )}
          style={{ padding: isMobile ? "28px 24px" : "40px 36px" }}
          onClick={() => phase === "idle" && handlePick("scripts")}
          onAnimationEnd={() => {
            if (phase === "fading") {
              setView("list");
              setPhase("done");
            }
          }}
        >
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent-dim text-accent-t">
            <Ic.terminal />
          </div>
          <div className="font-ui text-[15px] font-semibold text-t1">
            {t("scripts_card_title")}
          </div>
          <div className="mt-2 text-center font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t3">
            {t("scripts_card_desc")}
          </div>
        </div>
      </div>
    </div>
  );

  // ── Lorebook list ──
  const lorebookListContent = (
    <div
      className={cn(
        "flex-1 overflow-y-auto pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]",
        isMobile &&
          "[&_button]:min-h-[44px] [&_input]:text-base [&_textarea]:text-base [&_select]:text-base"
      )}
      style={{ padding: isMobile ? "12px" : "20px 24px" }}
    >
      {/* Empty state */}
      {lorebooks.length === 0 && (
        <div className="py-10 text-center">
          <div className="mb-2 text-[13px] text-t3">
            {t("lore_no_entries")}
          </div>
          <div className="mx-auto flex justify-center gap-2">
            <AddButton onClick={handleAddLorebook}>
              <Ic.plus /> {t("new_lorebook")}
            </AddButton>
            <AddButton onClick={() => setImportOpen(true)}>
              <Ic.import /> {t("import_lorebook_title")}
            </AddButton>
          </div>
        </div>
      )}

      {/* Accordion list */}
      {lorebooks.map((lb) => (
        <LorebookAccordion
          key={lb.id}
          lorebook={lb}
          links={lorebookLinksMap.get(lb.id) ?? []}
          characters={linkCharacters}
          personas={linkPersonas}
          expanded={expandedLorebooks.has(lb.id)}
          editing={editingLorebookId === lb.id}
          editLbName={editLbName}
          editLbScope={editLbScope}
          activeEntryId={view === "editor" ? activeEntryId : null}
          isMobile={isMobile}
          actionMenuOpen={actionMenuLorebookId === lb.id}
          onToggleActionMenu={() =>
            setActionMenuLorebookId((prev) =>
              prev === lb.id ? null : lb.id
            )
          }
          t={t}
          onToggle={() => toggleLorebook(lb.id)}
          onStartEdit={() => {
            setEditingLorebookId(lb.id);
            setEditLbName(lb.name);
            setEditLbScope(lb.scopeType as Scope);
          }}
          onSaveEdit={saveLorebookEdit}
          onCancelEdit={() => {
            if (editingLorebookId === createdDraftLorebookId) {
              void discardCreatedLorebookDraft();
              return;
            }
            setEditingLorebookId(null);
          }}
          onEditLbName={setEditLbName}
          onEditLbScope={(s: string) => setEditLbScope(s as Scope)}
          onDelete={() => setConfirmDeleteLorebook(lb.id)}
          onAddEntry={() => handleAddEntry(lb.id)}
          onEntryClick={(entryId) => handleEntryClick(lb.id, entryId)}
          onToggleEnabled={() =>
            handleUpdateLb(lb.id, { enabled: !lb.enabled })
          }
          onUpdateMeta={(body) => handleUpdateLb(lb.id, body)}
          onReorderEntries={(updates) => handleReorderEntries(lb.id, updates)}
          onToggleEntryEnabled={(entryId, enabled) => handleToggleEntryEnabled(lb.id, entryId, enabled)}
          onSetLinks={(links) => handleSetLinks(lb.id, links)}
          onDuplicate={() => handleDuplicateLb(lb.id)}
          onExport={() => handleExportLb(lb.id)}
        />
      ))}

      {/* Bottom list buttons */}
      {lorebooks.length > 0 && (
        <div className="mt-2 flex gap-2">
          <AddButton onClick={handleAddLorebook}>
            <Ic.plus /> {t("new_lorebook")}
          </AddButton>
          <AddButton onClick={() => setImportOpen(true)}>
            <Ic.import /> {t("import_lorebook_title")}
          </AddButton>
        </div>
      )}
    </div>
  );

  // ── Header bar (list) ──
  const headerBar = (
    <div
      className="w-full flex shrink-0 items-center gap-2 border-b border-border bg-surface"
      style={{ padding: isMobile ? "10px 12px" : "10px 20px" }}
    >
      <div
        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1"
        onClick={handleBackToPick}
      >
        {Ic.caret("l")}
      </div>
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-dim text-accent-t">
        {tab === "lorebooks" ? <Ic.book /> : <Ic.terminal />}
      </div>
      <span className="font-ui text-[14px] font-semibold text-t1">
        {tab === "lorebooks"
          ? t("lorebooks_card_title")
          : t("scripts_card_title")}
      </span>
      {/* Breadcrumb: active scope from the mini-sidebar. Desktop only — on
          mobile the scope labels are already visible in the bottom chip bar.
          Works for both tabs (Lorebooks and Scripts) since scope is shared. */}
      {!isMobile && (() => {
        const activeScope = scopeItems.find((s) => s.id === scope);
        if (!activeScope) return null;
        return (
          <>
            <span className="text-t4">/</span>
            <span className="flex min-w-0 items-center gap-1 font-ui text-[13px] font-medium text-t3">
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">{activeScope.icon}</span>
              <span className="truncate">{activeScope.label}</span>
            </span>
          </>
        );
      })()}
      <div className="ml-auto flex gap-1">
        <CustomTooltip
          content={tab === "lorebooks" ? t("scripts_card_title") : t("lorebooks_card_title")}
        >
          <button type="button"
            className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 font-ui text-[12px] text-t3 transition-all hover:bg-s2 hover:text-t1"
            aria-label={tab === "lorebooks" ? t("scripts_card_title") : t("lorebooks_card_title")}
            onClick={() => handleSwitchTab(tab === "lorebooks" ? "scripts" : "lorebooks")}
          >
            {tab === "lorebooks" ? <Ic.terminal /> : <Ic.book />}
            {!isMobile && (
              <span>{tab === "lorebooks" ? t("scripts_card_title") : t("lorebooks_card_title")}</span>
            )}
          </button>
        </CustomTooltip>
        <div className="mx-1 h-8 w-px bg-border" />
        {tab === "lorebooks" && (
          <>
            <CustomTooltip content={t("new_lorebook")}>
              <div
                className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1"
                onClick={handleAddLorebook}
              >
                <Ic.plus />
              </div>
            </CustomTooltip>
            <CustomTooltip content={t("import_lorebook_title")}>
              <div
                className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1"
                onClick={() => setImportOpen(true)}
              >
                <Ic.import />
              </div>
            </CustomTooltip>
          </>
        )}
        {tab === "scripts" && (
          <>
            <CustomTooltip content={t("new_script")}>
              <div
                className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1"
                onClick={scriptPanel.handleAdd}
              >
                <Ic.plus />
              </div>
            </CustomTooltip>
            <CustomTooltip content={t("script_import")}>
              <div
                className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1"
                onClick={scriptPanel.handleImportOpen}
              >
                <Ic.import />
              </div>
            </CustomTooltip>
          </>
        )}
      </div>
    </div>
  );

  // ── Header bar (editor) ──
  // Autosave indicator state. form.formState.isDirty (read during render)
  // subscribes this component to dirty changes; `autosaveStatus` drives the
  // passive indicator — mirrors ProviderModal: no manual save button, the
  // debounced flushSave persists edits (floppy flashes on save, fades when
  // idle + clean; error stays red and self-heals on the next edit / leave).
  const dirty = form.formState.isDirty;
  const autosaveStatus =
    savingState === "saving"
      ? "saving"
      : savingState === "saved"
        ? "saved"
        : savingState === "error"
          ? "error"
          : dirty
            ? "pending"
            : "idle";
  const editorHeader = (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-border bg-surface"
      style={{ padding: isMobile ? "10px 12px" : "10px 20px" }}
    >
      <div
        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1"
        onClick={() => {
          flushSave();
          setView("list");
          setActiveEntryId(null);
          scriptPanel.setActiveScriptId(null);
        }}
      >
        {Ic.caret("l")}
      </div>
      <span className="flex-1 truncate font-ui text-[14px] font-semibold text-t1">
        {tab === "lorebooks" ? activeEntry?.title || "" : ""}
      </span>
      {/* Autosave indicator — passive (mirrors ProviderModal): no manual
          save button; the debounced flushSave persists edits. Floppy while
          pending / saving, a check on saved; fades out when idle + clean.
          Error stays red — the next edit or leaving the entry re-flushes. */}
      <div
        data-testid="autosave-indicator"
        data-state={autosaveStatus}
        className={cn(
          "flex items-center gap-1.5 font-ui text-[12px] transition-opacity duration-300",
          autosaveStatus === "idle"
            ? "opacity-0"
            : autosaveStatus === "saved"
              ? "text-success-t opacity-100"
              : autosaveStatus === "error"
                ? "text-danger opacity-100"
                : "text-t3 opacity-100",
        )}
      >
        {autosaveStatus === "saved" ? Ic.check() : Ic.floppy()}
        <span>
          {autosaveStatus === "saving"
            ? t("lore_saving")
            : autosaveStatus === "saved"
              ? t("lore_saved")
              : autosaveStatus === "error"
                ? t("retry")
                : t("autosaving")}
        </span>
      </div>
    </div>
  );

  // ── Lorebook delete confirmation modal ──
  const confirmDeleteLorebookModal = confirmDeleteLorebook && (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      onClick={() => setConfirmDeleteLorebook(null)}
    >
      <div
        className="flex w-[400px] max-w-[90vw] flex-col overflow-hidden rounded-xl border border-border bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between border-b border-border"
          style={{ padding: "16px 20px" }}
        >
          <span className="text-sm font-semibold text-t1">
            {t("delete_lorebook_confirm")}
          </span>
          <div
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1"
            onClick={() => setConfirmDeleteLorebook(null)}
          >
            <Ic.close />
          </div>
        </div>
        <div className="p-5 text-[13px] text-t2">
          {t("delete_lorebook_msg")}
        </div>
        <div
          className="flex justify-end gap-2 border-t border-border"
          style={{ padding: "12px 20px" }}
        >
          <button type="button"
            className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1"
            onClick={() => setConfirmDeleteLorebook(null)}
          >
            {t("lore_cancel_edit")}
          </button>
          <button type="button"
            className="h-9 cursor-pointer rounded-md border-0 bg-danger px-4 font-ui text-xs font-medium text-on-danger transition-all"
            onClick={() => handleDeleteLb(confirmDeleteLorebook)}
          >
            {t("delete_lorebook_confirm")}
          </button>
        </div>
      </div>
    </div>
  );

  // ══════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════

  const listAnim =
    phase === "done" ? "animate-[lbFadeIn_300ms_ease-out]" : "";
  const headerAnim =
    phase === "done" ? "animate-[lbSlideIn_250ms_ease-out]" : "";

  if (view === "pick")
    return (
      <div className="flex h-full w-full flex-col overflow-hidden">
        {pickView}
      </div>
    );

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden min-h-0">
      {/* Modals */}
      {scriptPanel.modals}
      <LorebookImportModal
        open={importOpen}
        lorebooks={lorebooks}
        scope={scope}
        characterId={characterId}
        personaId={personaId}
        chatId={chatId}
        onClose={() => setImportOpen(false)}
        onImportComplete={refreshLorebooks}
        t={t}
      />
      {confirmDeleteLorebookModal}

      {/* ── Mobile layout ── */}
      {isMobile ? (
        <>
          {/* List */}
          {view === "list" && (
            <div
              className={cn(
                "w-full flex flex-1 flex-col overflow-hidden",
                listAnim
              )}
              onAnimationEnd={(e) => {
                if (e.animationName === "lbFadeIn") {
                  setPhase("idle");
                  setFadingTab(null);
                }
              }}
            >
              <div className={cn("w-full", headerAnim)}>{headerBar}</div>
              {scopeBarMobile}
              {tab === "lorebooks"
                ? lorebookListContent
                : scriptPanel.scriptListContent}
            </div>
          )}

          {/* Editor */}
          {view === "editor" && (
            <div className="animate-[lbFadeIn_250ms_ease-out] flex min-h-0 flex-1 flex-col overflow-hidden">
              {editorHeader}
              <div
                className="min-h-0 flex-1 overflow-y-auto"
                style={{
                  padding: "12px",
                  paddingBottom:
                    "calc(2rem + env(safe-area-inset-bottom, 0px))",
                  WebkitOverflowScrolling: "touch",
                  overflowAnchor: "none",
                }}
              >
                {tab === "lorebooks" && activeEntry ? (
                  <FormProvider {...form}>
                    <LoreEntryEditor
                      entryId={activeEntry.id}
                      lorebookId={activeLorebookIdForEntry!}
                      existingGroups={existingGroups}
                      onDuplicate={() => handleDuplicateEntry(activeLorebookIdForEntry!)}
                      onDeleted={() => {
                        setActiveEntryId(null);
                        setView("list");
                      }}
                      isMobile={isMobile}
                      t={t}
                    />
                  </FormProvider>
                ) : (
                  scriptPanel.scriptEditorPanel
                )}
              </div>
            </div>
          )}
        </>
      ) : (
        /* ── Desktop layout ── */
        <>
          {view === "list" && (
            <div
              className={cn("flex flex-1 flex-col overflow-hidden", listAnim)}
              onAnimationEnd={(e) => {
                if (e.animationName === "lbFadeIn") {
                  setPhase("idle");
                  setFadingTab(null);
                }
              }}
            >
              <div className={headerAnim}>{headerBar}</div>
              <div className="flex flex-1 overflow-hidden">
                {scopeColumn}
                {tab === "lorebooks"
                  ? lorebookListContent
                  : scriptPanel.scriptListContent}
              </div>
            </div>
          )}

          {view === "editor" && (
            <div className="animate-[lbFadeIn_250ms_ease-out] flex min-h-0 flex-1 flex-col overflow-hidden">
              {editorHeader}
              <div className="flex min-h-0 flex-1 overflow-hidden">
                <div
                  className="min-h-0 flex-1 overflow-y-auto"
                  style={{ padding: "24px 32px" }}
                >
                  {tab === "lorebooks" && activeEntry ? (
                    <FormProvider {...form}>
                      <LoreEntryEditor
                        entryId={activeEntry.id}
                        lorebookId={activeLorebookIdForEntry!}
                        existingGroups={existingGroups}
                        onDuplicate={() => handleDuplicateEntry(activeLorebookIdForEntry!)}
                        onDeleted={() => {
                          setActiveEntryId(null);
                          setView("list");
                        }}
                        isMobile={isMobile}
                        t={t}
                      />
                    </FormProvider>
                  ) : (
                    scriptPanel.scriptEditorPanel
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
