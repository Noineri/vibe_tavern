import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Ic, Icons } from "../shared/icons.js";
import { MobileExpandTextarea } from "../shared/MobileExpandTextarea.js";
import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";
import {
  listLorebooks,
  createLorebook,
  updateLorebookMeta,
  deleteLorebook,
  listLoreEntries,
  createLoreEntry,
  updateLoreEntry,
  deleteLoreEntry,
  testLoreActivation,
  importLorebookEntries,
  type LorebookRecord,
  type LoreEntryRecord,
} from "../../app-client.js";

import { useScriptPanel } from "./ScriptEditor.js";
import { CustomTooltip } from "../shared/Tooltip.js";

// ── Types ──────────────────────────────────────────────────────────────

interface LorebookEditorProps {
  characterId: string;
  chatId: string | null;
  personaId: string | null;
}

type Scope = "global" | "character" | "persona" | "chat";
type Tab = "lorebooks" | "scripts";
type View = "pick" | "list" | "editor";

// ── Inline keyframes (injected once) ────────────────────────────────────

const STYLE_ID = "lb-anim-style";
function ensureAnimStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
@keyframes lbFadeOut{to{opacity:0;transform:scale(.96) translateY(6px)}}
@keyframes lbFadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes lbSlideIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
`;
  document.head.appendChild(s);
}

function useIsMobile() {
  const [mobile, setMobile] = useState(typeof window !== "undefined" ? window.innerWidth < 768 : false);
  useEffect(() => {
    const handler = () => setMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return mobile;
}

// ── Component ──────────────────────────────────────────────────────────

export function LorebookEditor({ characterId, chatId, personaId }: LorebookEditorProps) {
  const { t } = useT();
  const isMobile = useIsMobile();
  // ── State ────────────────────────────────────────────────
  const [view, setView] = useState<View>("pick");
  const [tab, setTab] = useState<Tab>("lorebooks");
  const [scope, setScope] = useState<Scope>("character");
  const [phase, setPhase] = useState<"idle" | "fading" | "done">("idle");
  const [fadingTab, setFadingTab] = useState<Tab | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => { ensureAnimStyle(); return () => clearTimeout(timer.current); }, []);

  // Expose internal state for automated testing/screenshots
  useEffect(() => {
    (window as any).__setLorebookView = setView;
    (window as any).__setLorebookTab = setTab;
    (window as any).__getLorebookView = () => view;
    return () => { delete (window as any).__setLorebookView; delete (window as any).__setLorebookTab; delete (window as any).__getLorebookView; };
  }, [view]);

  const handlePick = (target: Tab) => {
    setTab(target);
    setFadingTab(target);
    setPhase("fading");
    timer.current = setTimeout(() => {
      setView("list");
      setPhase("done");
      timer.current = setTimeout(() => { setPhase("idle"); setFadingTab(null); }, 300);
    }, 260);
  };

  const handleBackToPick = () => {
    setView("pick");
    setActiveEntryId(null);
    scriptPanel.setActiveScriptId(null);
    setPhase("idle");
  };

  // ── Lorebook state ───────────────────────────────────────
  const [expandedLorebooks, setExpandedLorebooks] = useState<Set<string>>(new Set());
  const [editingLorebookId, setEditingLorebookId] = useState<string | null>(null);
  const [editLbName, setEditLbName] = useState("");
  const [editLbScope, setEditLbScope] = useState<Scope>("character");

  // ── Script panel hook ───────────────────────────────────────
  const scriptPanel = useScriptPanel({ characterId, chatId, personaId, scope, onOpenEditor: () => setView("editor"), onBackToList: () => setView("list") });

  // Entry state
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [secKeyInput, setSecKeyInput] = useState("");
  const [testText, setTestText] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [confirmDeleteEntry, setConfirmDeleteEntry] = useState<string | null>(null);
  const [confirmDeleteLorebook, setConfirmDeleteLorebook] = useState<string | null>(null);
  const [actionMenuLorebookId, setActionMenuLorebookId] = useState<string | null>(null);

  // ── Import state ─────────────────────────────────────────
  const [importOpen, setImportOpen] = useState(false);
  const [importStep, setImportStep] = useState<1 | 2 | 3>(1);
  const [importData, setImportData] = useState<Record<string, unknown> | null>(null);
  const [importFileName, setImportFileName] = useState("");
  const [importEntryCount, setImportEntryCount] = useState(0);
  const [importMode, setImportMode] = useState<"new" | "merge" | "replace">("new");
  const [importTargetLorebookId, setImportTargetLorebookId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // ── Scope → ownerId ──────────────────────────────────────
  const getOwnerId = useCallback((s: Scope): string | undefined => {
    if (s === "character") return characterId;
    if (s === "persona") return personaId ?? undefined;
    if (s === "chat") return chatId ?? undefined;
    return undefined;
  }, [characterId, personaId, chatId]);

  // ── Queries (replaced with local state + async fetch) ────
  const [lorebooks, setLorebooks] = useState<LorebookRecord[]>([]);
  const [loadingLorebooks, setLoadingLorebooks] = useState(false);

  const refreshLorebooks = useCallback(async () => {
    setLoadingLorebooks(true);
    try { setLorebooks(await listLorebooks(scope, getOwnerId(scope))); }
    finally { setLoadingLorebooks(false); }
  }, [scope, getOwnerId(scope)]);

  useEffect(() => {
    if (view !== "pick") void refreshLorebooks();
  }, [view, refreshLorebooks]);

  // Find which lorebook the active entry belongs to
  const activeLorebookId = activeEntryId
    ? lorebooks.find(lb => {
        // We don't have entries in lorebooks list, need to check entries query
        return true; // placeholder, resolved below via entries queries
      })?.id
    : null;

  // ── Mutations (replaced with async handlers) ─────────────
  const [creatingLb, setCreatingLb] = useState(false);
  const [savingLb, setSavingLb] = useState(false);
  const [deletingLb, setDeletingLb] = useState(false);
  const [creatingEntry, setCreatingEntry] = useState(false);
  const [savingEntry, setSavingEntry] = useState(false);
  const [deletingEntry, setDeletingEntry] = useState(false);
  const [testingActivation, setTestingActivation] = useState(false);
  const [importing, setImporting] = useState(false);
  const [testMutData, setTestMutData] = useState<{ activatedIds: string[]; totalEntries: number } | null>(null);
  const [importMutError, setImportMutError] = useState<string | null>(null);

  const handleCreateLb = async (body: { name: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string }) => {
    setCreatingLb(true);
    try {
      const newLb = await createLorebook(body);
      await refreshLorebooks();
      setExpandedLorebooks(prev => new Set([...prev, newLb.id]));
      setEditingLorebookId(newLb.id);
      setEditLbName(newLb.name);
    } finally { setCreatingLb(false); }
  };

  const handleUpdateLb = async (id: string, body: Parameters<typeof updateLorebookMeta>[1]) => {
    setSavingLb(true);
    try {
      await updateLorebookMeta(id, body);
      await refreshLorebooks();
      setEditingLorebookId(null);
    } finally { setSavingLb(false); }
  };

  const handleDeleteLb = async (id: string) => {
    setDeletingLb(true);
    try {
      await deleteLorebook(id);
      await refreshLorebooks();
      setConfirmDeleteLorebook(null);
    } finally { setDeletingLb(false); }
  };

  const handleCreateEntry = async (lorebookId: string, entry: Partial<LoreEntryRecord>): Promise<LoreEntryRecord | null> => {
    setCreatingEntry(true);
    try {
      const created = await createLoreEntry(lorebookId, entry);
      await refreshEntries();
      return created;
    } catch { return null; }
    finally { setCreatingEntry(false); }
  };

  const handleUpdateEntry = async (lorebookId: string, entryId: string, entry: Partial<LoreEntryRecord>) => {
    setSavingEntry(true);
    try {
      await updateLoreEntry(lorebookId, entryId, entry);
      await refreshEntries();
    } finally { setSavingEntry(false); }
  };

  const handleDeleteEntry = async (lorebookId: string, entryId: string) => {
    setDeletingEntry(true);
    try {
      await deleteLoreEntry(lorebookId, entryId);
      await refreshEntries();
      if (activeEntryId === entryId) { setActiveEntryId(null); setTestResult(null); setView("list"); }
      setConfirmDeleteEntry(null);
    } finally { setDeletingEntry(false); }
  };

  const handleTestActivation = async (lorebookId: string, text: string) => {
    setTestingActivation(true);
    try {
      const result = await testLoreActivation(lorebookId, text);
      setTestMutData(result);
    } finally { setTestingActivation(false); }
  };

  const handleImportEntries = async (lorebookId: string, body: { format: string; data: unknown; mode: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string; fallbackName?: string }) => {
    setImporting(true);
    setImportMutError(null);
    try {
      await importLorebookEntries(lorebookId, body);
      await refreshLorebooks();
      closeImportModal();
    } catch (err) {
      setImportMutError(err instanceof Error ? err.message : String(err));
    } finally { setImporting(false); }
  };

  // ── Import helpers ──────────────────────────────────────
  const parseFileContent = (text: string, fileName: string) => {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) {
        setImportError(t("import_invalid_json"));
        return;
      }
      const entries = parsed.entries;
      const count = Array.isArray(entries) ? entries.length : (typeof entries === "object" && entries !== null ? Object.keys(entries).length : 0);
      setImportData(parsed as Record<string, unknown>);
      setImportFileName(fileName);
      setImportEntryCount(count);
      setImportError(null);
      setImportStep(2);
    } catch {
      setImportError(t("import_invalid_json"));
    }
  };

  const handleImportFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") parseFileContent(reader.result, file.name);
    };
    reader.readAsText(file);
  };

  const handleImportPaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      parseFileContent(text, "clipboard.json");
    } catch {
      setImportError(t("import_invalid_json"));
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files[0];
    if (file) handleImportFile(file);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleImportFile(file);
  };

  const closeImportModal = () => {
    setImportOpen(false);
    setImportStep(1);
    setImportData(null);
    setImportFileName("");
    setImportEntryCount(0);
    setImportMode("new");
    setImportTargetLorebookId(null);
    setImportError(null);
  };

  const runImport = () => {
    if (!importData) return;
    const lorebookId = importMode === "new" ? "new" : importTargetLorebookId;
    if (!lorebookId) return;
    const body: { format: string; data: unknown; mode: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string; fallbackName?: string } = {
      format: "st",
      data: importData,
      mode: importMode,
    };
    if (importMode === "new") {
      body.scopeType = scope;
      if (scope === "character") body.characterId = characterId;
      if (scope === "persona" && personaId) body.personaId = personaId;
      if (scope === "chat" && chatId) body.chatId = chatId;
    }
    if (importFileName) body.fallbackName = importFileName.replace(/\.json$/i, "");
    handleImportEntries(lorebookId, body);
  };

  // ── Helpers ───────────────────────────────────────────────
  const handleAddLorebook = () => {
    const body: { name: string; scopeType: string; characterId?: string; personaId?: string; chatId?: string } = {
      name: t("new_lorebook"),
      scopeType: scope,
    };
    if (scope === "character") body.characterId = characterId;
    if (scope === "persona" && personaId) body.personaId = personaId;
    if (scope === "chat" && chatId) body.chatId = chatId;
    handleCreateLb(body);
  };

  const saveLorebookEdit = () => {
    if (!editingLorebookId) return;
    handleUpdateLb(editingLorebookId, { name: editLbName, scopeType: editLbScope });
  };

  const toggleLorebook = (id: string) => {
    setExpandedLorebooks(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  const runTest = () => {
    if (!testText.trim() || !activeEntryId || !activeLorebookIdForEntry) return;
    handleTestActivation(activeLorebookIdForEntry, testText);
  };

  // ── Resolve active entry and its lorebook ─────────────────
  // We need entries from each lorebook to find the active one.
  // For simplicity, track which lorebook's entry was clicked.
  const [activeLorebookIdForEntry, setActiveLorebookIdForEntry] = useState<string | null>(null);

  const handleEntryClick = (lorebookId: string, entryId: string) => {
    setActiveEntryId(entryId);
    setActiveLorebookIdForEntry(lorebookId);
    setTestResult(null);
    setView("editor");
  };

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
      role: "system",
      groupName: "",
      groupWeight: 100,
      prioritizeInclusion: false,
      excludeRecursion: false,
      preventRecursion: false,
      delayUntilRecursion: false,
      recursionLevel: 0,
      scanDepthOverride: null,
      caseSensitive: false,
      matchWholeWords: false,
      characterFilter: [],
      characterFilterExclude: false,
      triggers: ["normal", "continue", "swipe", "regenerate"],
      matchSources: [],
    };
    void handleCreateEntry(lorebookId, newEntry).then(created => {
      if (created) {
        setActiveEntryId(created.id);
        setActiveLorebookIdForEntry(lorebookId);
        setTestResult(null);
        setView("editor");
      }
    });
  };

  // ── Active entry data ─────────────────────────────────────
  const [entries, setEntries] = useState<LoreEntryRecord[]>([]);
  const activeEntry = entries.find(e => e.id === activeEntryId) ?? null;

  const refreshEntries = useCallback(async () => {
    if (!activeLorebookIdForEntry) return;
    setEntries(await listLoreEntries(activeLorebookIdForEntry));
  }, [activeLorebookIdForEntry]);

  useEffect(() => {
    if (activeLorebookIdForEntry) void refreshEntries();
  }, [activeLorebookIdForEntry, refreshEntries]);

  // ── Debounced auto-save + explicit save button ────────────
  const [savingState, setSavingState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dirtyFieldsRef = useRef<Record<string, unknown>>({});
  const [dirtyCount, setDirtyCount] = useState(0);

  // Apply locally immediately, debounce save to server
  const updateAct = (field: string, value: unknown) => {
    if (!activeEntryId || !activeLorebookIdForEntry) return;
    // Optimistic local update
    setEntries(prev => prev.map(e =>
      e.id === activeEntryId ? { ...e, [field]: value } : e
    ));
    // Track dirty fields (ref for reliability)
    dirtyFieldsRef.current[field] = value;
    setDirtyCount(c => c + 1);
    setSavingState("idle");

    // Debounced auto-save (1s after last change)
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => flushSave(), 1000);
  };

  const flushSave = async () => {
    if (!activeEntryId || !activeLorebookIdForEntry) return;
    const fields = { ...dirtyFieldsRef.current };
    if (Object.keys(fields).length === 0) return;
    setSavingState("saving");
    try {
      await updateLoreEntry(activeLorebookIdForEntry, activeEntryId, fields as Partial<LoreEntryRecord>);
      dirtyFieldsRef.current = {};
      setDirtyCount(0);
      setSavingState("saved");
      setTimeout(() => setSavingState(prev => prev === "saved" ? "idle" : prev), 2000);
      // Refresh entries to confirm server state
      void refreshEntries();
    } catch {
      setSavingState("error");
    }
  };

  // Cleanup timer
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const handleKeyAdd = (e: React.KeyboardEvent, type: "keys" | "secondaryKeys") => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const val = (type === "keys" ? keyInput : secKeyInput).trim().toLowerCase();
    if (!val || !activeEntry) return;
    const arr = activeEntry[type];
    if (!arr.includes(val)) updateAct(type, [...arr, val]);
    type === "keys" ? setKeyInput("") : setSecKeyInput("");
  };

  const removeKey = (type: "keys" | "secondaryKeys", keyToRemove: string) => {
    if (!activeEntry) return;
    const arr = activeEntry[type];
    updateAct(type, arr.filter(k => k !== keyToRemove));
  };

  // ── Scope column ─────────────────────────────────────────
  const scopeItems: { id: Scope; icon: ReactNode; label: string }[] = [
    { id: "global", icon: <Ic.stack />, label: t("scope_global") },
    { id: "character", icon: <Ic.book />, label: t("scope_char") },
    { id: "persona", icon: <Ic.user />, label: t("scope_persona") },
    { id: "chat", icon: <Ic.chat />, label: t("scope_chat") },
  ];

  const scopeColumn = !isMobile ? (
    <div className="flex shrink-0 flex-col items-center gap-1 border-r border-border bg-surface" style={{ width: 48, padding: "12px 0" }}>
      {scopeItems.map(s => (
        <CustomTooltip content={s.label} key={s.id}>
          <div className={cn("relative flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg transition-all hover:bg-s2", scope === s.id && "bg-accent-dim text-accent-t")} onClick={() => setScope(s.id)}>
            {s.icon}
          </div>
        </CustomTooltip>
      ))}
    </div>
  ) : null;

  const scopeBarMobile = isMobile ? (
    <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border scrollbar-hide" style={{ padding: "8px 12px" }}>
      {scopeItems.map(s => (
        <div
          key={s.id}
          className={cn(
            "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 font-ui text-[11px] font-medium transition-all select-none",
            scope === s.id
              ? "bg-accent text-white"
              : "text-t3 bg-transparent hover:bg-s2 active:bg-s3"
          )}
          onClick={() => setScope(s.id)}
        >
          <span className="flex h-4 w-4 items-center justify-center">{s.icon}</span>
          <span className="whitespace-nowrap">{s.label}</span>
        </div>
      ))}
    </div>
  ) : null;

  // ── STEP 0: Pick ─────────────────────────────────────────
  const pickView = (
    <div className="flex h-full flex-col items-center justify-center" style={{ padding: isMobile ? 16 : 40 }}>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "280px 280px", gap: 24 }}>
        <div className={cn("flex cursor-pointer flex-col items-center rounded-xl border-2 border-border bg-surface transition-[border-color,box-shadow] hover:border-accent hover:shadow-theme-md", phase === "fading" && fadingTab === "lorebooks" && "animate-[lbFadeOut_250ms_ease-in_forwards]")} style={{ padding: isMobile ? "28px 24px" : "40px 36px" }} onClick={() => phase === "idle" && handlePick("lorebooks")}>
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent-dim text-accent-t"><Ic.book /></div>
          <div className="font-ui text-[15px] font-semibold text-t1">{t("lorebooks_card_title")}</div>
          <div className="mt-2 text-center font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t3">{t("lorebooks_card_desc")}</div>
        </div>
        <div className={cn("flex cursor-pointer flex-col items-center rounded-xl border-2 border-border bg-surface transition-[border-color,box-shadow] hover:border-accent hover:shadow-theme-md", phase === "fading" && fadingTab === "scripts" && "animate-[lbFadeOut_250ms_ease-in_forwards]")} style={{ padding: isMobile ? "28px 24px" : "40px 36px" }} onClick={() => phase === "idle" && handlePick("scripts")}>
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent-dim text-accent-t"><Ic.terminal /></div>
          <div className="font-ui text-[15px] font-semibold text-t1">{t("scripts_card_title")}</div>
          <div className="mt-2 text-center font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t3">{t("scripts_card_desc")}</div>
        </div>
      </div>
    </div>
  );

  // ── Lorebook list ─────────────────────────────────────────
  const lorebookListContent = (
    <div className={cn("flex-1 overflow-y-auto pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]", isMobile && "[&_button]:min-h-[44px] [&_input]:text-base [&_textarea]:text-base [&_select]:text-base")} style={{ padding: isMobile ? "12px" : "20px 24px" }}>
      {lorebooks.length === 0 && (
        <div className="py-10 text-center">
          <div className="mb-2 text-[13px] text-t3">{t("lore_no_entries")}</div>
          <div className="mx-auto flex justify-center gap-2">
            <button className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border2 bg-transparent px-3 font-ui text-[12px] text-t3 transition-all hover:border-accent hover:text-accent" onClick={handleAddLorebook}>
              <Ic.plus /> {t("new_lorebook")}
            </button>
            <button className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border2 bg-transparent px-3 font-ui text-[12px] text-t3 transition-all hover:border-accent hover:text-accent" onClick={() => { setImportOpen(true); setImportStep(1); }}>
              <Ic.import /> {t("import_lorebook_title")}
            </button>
          </div>
        </div>
      )}
      {lorebooks.map(lb => {
        const expanded = expandedLorebooks.has(lb.id);
        const editing = editingLorebookId === lb.id;
        return (
          <LorebookAccordion
            key={lb.id}
            lorebook={lb}
            expanded={expanded}
            editing={editing}
            editLbName={editLbName}
            editLbScope={editLbScope}
            activeEntryId={view === "editor" ? activeEntryId : null}
            isMobile={isMobile}
            actionMenuOpen={actionMenuLorebookId === lb.id}
            onToggleActionMenu={() => setActionMenuLorebookId(prev => prev === lb.id ? null : lb.id)}
            t={t}
            onToggle={() => toggleLorebook(lb.id)}
            onStartEdit={() => { setEditingLorebookId(lb.id); setEditLbName(lb.name); setEditLbScope(lb.scopeType as Scope); }}
            onSaveEdit={saveLorebookEdit}
            onCancelEdit={() => setEditingLorebookId(null)}
            onEditLbName={setEditLbName}
            onEditLbScope={(s: string) => setEditLbScope(s as Scope)}
            onDelete={() => setConfirmDeleteLorebook(lb.id)}
            onAddEntry={() => handleAddEntry(lb.id)}
            onEntryClick={(entryId) => handleEntryClick(lb.id, entryId)}
            onToggleEnabled={() => handleUpdateLb(lb.id, { enabled: !lb.enabled })}
          />
        );
      })}
      {lorebooks.length > 0 && (
        <div className="mt-2 flex gap-2">
          <button className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border2 bg-transparent px-3 font-ui text-[12px] text-t3 transition-all hover:border-accent hover:text-accent" onClick={handleAddLorebook}>
            <Ic.plus /> {t("new_lorebook")}
          </button>
          <button className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border2 bg-transparent px-3 font-ui text-[12px] text-t3 transition-all hover:border-accent hover:text-accent" onClick={() => { setImportOpen(true); setImportStep(1); }}>
            <Ic.import /> {t("import_lorebook_title")}
          </button>
        </div>
      )}
    </div>
  );

  // ── Entry editor ──────────────────────────────────────────
  const entryEditor = activeEntry ? (
    <div className="mx-auto max-w-[860px]">
      <div className="flex items-center gap-3" style={{ marginBottom: 20 }}>
        <div className="flex-1"><input className="w-full rounded-md border border-border bg-s2 px-2.5 py-1.5 text-[15px] font-semibold text-t1 outline-none focus:border-accent" type="text" value={activeEntry.title} onChange={e => updateAct("title", e.target.value)} placeholder={t("lore_entry_title")} /></div>
        <div className="flex shrink-0 items-center gap-2">
          <div
            className="shrink-0 cursor-pointer rounded-full transition-all"
            style={{
              width: 36,
              height: 20,
              backgroundColor: activeEntry.enabled ? 'var(--accent)' : 'var(--s3)',
              position: 'relative',
            }}
            onClick={() => updateAct("enabled", !activeEntry.enabled)}
          >
            <div
              className="rounded-full transition-all"
              style={{
                position: 'absolute',
                top: 3,
                left: activeEntry.enabled ? 19 : 3,
                width: 14,
                height: 14,
                backgroundColor: activeEntry.enabled ? '#fff' : 'var(--t3)',
              }}
            />
          </div>
          <CustomTooltip content={t("lore_save_entry")}>
            <div className="flex h-8 w-8 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={() => setConfirmDeleteEntry(activeEntryId)}><Ic.del /></div>
          </CustomTooltip>
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("lore_entry_keys")}</label>
        <div className="flex flex-1 flex-wrap items-center gap-1.5 rounded-md border border-border bg-s2" style={{ padding: "6px 10px", minHeight: 38 }}>
          {activeEntry.keys.map(k => <span key={k} className="cursor-pointer flex items-center gap-1 rounded bg-accent-dim px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-3px)] text-accent-t transition-all hover:bg-border2 hover:text-t1" onClick={() => removeKey("keys", k)}>{k} <Icons.Close /></span>)}
          <input className="min-w-[80px] flex-1 border-0 bg-transparent font-ui text-t1 outline-none" style={{ fontSize: "calc(var(--ui-fs) - 1px)" }} value={keyInput} onChange={e => setKeyInput(e.target.value)} onKeyDown={e => handleKeyAdd(e, "keys")} placeholder={activeEntry.keys.length === 0 ? t("lore_entry_keys_placeholder") : ""} />
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("lore_entry_content")}</label>
        <MobileExpandTextarea value={activeEntry.content} onChange={(v) => updateAct("content", v)} label={t("lore_entry_content")}>
          <textarea className="w-full min-h-[180px] rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-t1 outline-none focus:border-accent leading-[1.6]" value={activeEntry.content} onChange={e => updateAct("content", e.target.value)} placeholder={t("lore_entry_content_placeholder")} />
        </MobileExpandTextarea>
      </div>

      <button className="mb-4 flex items-center gap-1.5 font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-accent-t transition-all hover:text-accent" onClick={() => setAdvancedOpen(v => !v)}>
        {advancedOpen ? "\u25B2" : "\u25BC"} {advancedOpen ? t("lore_cancel_edit") : t("lore_advanced_settings")}
      </button>

      {advancedOpen && (
        <div className="mb-5 flex flex-col gap-4">
          {/* Activation */}
          <div className="rounded-lg border border-border bg-s2" style={{ padding: 16 }}>
            <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">{t("lore_activation_section")}</div>
            <div className="mb-4">
              <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("lore_entry_secondary_keys")}</label>
              <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-bg" style={{ padding: "6px 10px", minHeight: 38 }}>
                {activeEntry.secondaryKeys.map(k => <span key={k} className="cursor-pointer flex items-center gap-1 rounded bg-accent-dim px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-3px)] text-accent-t transition-all hover:bg-border2 hover:text-t1" onClick={() => removeKey("secondaryKeys", k)}>{k} <Icons.Close /></span>)}
                <input className="min-w-[80px] flex-1 border-0 bg-transparent font-ui text-t1 outline-none" style={{ fontSize: "calc(var(--ui-fs) - 1px)" }} value={secKeyInput} onChange={e => setSecKeyInput(e.target.value)} onKeyDown={e => handleKeyAdd(e, "secondaryKeys")} />
              </div>
            </div>
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
              <div><label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("lore_logic_label")}</label><select className="h-[38px] w-full rounded-md border border-border bg-bg px-2.5 font-ui text-t1 outline-none" value={activeEntry.logic} onChange={e => updateAct("logic", e.target.value)}><option value="AND_ANY">AND ANY</option><option value="AND_ALL">AND ALL</option><option value="NOT_ANY">NOT ANY</option><option value="NOT_ALL">NOT ALL</option></select></div>
              <div><label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("lore_position_label")}</label><select className="h-[38px] w-full rounded-md border border-border bg-bg px-2.5 font-ui text-t1 outline-none" value={activeEntry.position} onChange={e => updateAct("position", e.target.value)}><option value="before_char">Before Char</option><option value="after_char">After Char</option><option value="before_examples">Before Examples</option><option value="after_examples">After Examples</option><option value="top_an">Top of AN</option><option value="bottom_an">Bottom of AN</option><option value="at_depth">@ Depth</option><option value="outlet">Outlet</option></select></div>
              <div><label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("lore_depth_label")}</label><input className="h-[38px] w-full rounded-md border border-border bg-bg px-2.5 font-ui text-t1 outline-none focus:border-accent" type="number" min="0" value={activeEntry.depth} onChange={e => updateAct("depth", parseInt(e.target.value))} /></div>
              <div><label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("lore_priority_label")}</label><input className="h-[38px] w-full rounded-md border border-border bg-bg px-2.5 font-ui text-t1 outline-none focus:border-accent" type="number" min="0" value={activeEntry.priority} onChange={e => updateAct("priority", parseInt(e.target.value))} /></div>
              <CustomTooltip content={t("role_hint")}>
                <div><label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("lore_role_label")}</label><select className="h-[38px] w-full rounded-md border border-border bg-bg px-2.5 font-ui text-t1 outline-none" value={activeEntry.role} onChange={e => updateAct("role", e.target.value)}><option value="system">System</option><option value="user">User</option><option value="assistant">Assistant</option></select></div>
              </CustomTooltip>
            </div>
          </div>

          {/* Strategy */}
          <div className="rounded-lg border border-border bg-s2" style={{ padding: 16 }}>
            <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">{t("lore_strategy_section")}</div>
            <div className="flex flex-wrap gap-x-6 gap-y-3">
              <CustomTooltip content={t("constant_hint")}>
                <label className="flex items-center gap-2 text-[13px] text-t1"><input type="checkbox" checked={activeEntry.constant} onChange={e => updateAct("constant", e.target.checked)} /> {t("lore_constant")}</label>
              </CustomTooltip>
              <CustomTooltip content={t("case_sensitive_hint")}>
                <label className="flex items-center gap-2 text-[13px] text-t1"><input type="checkbox" checked={activeEntry.caseSensitive} onChange={e => updateAct("caseSensitive", e.target.checked)} /> {t("lore_case_sensitive")}</label>
              </CustomTooltip>
              <CustomTooltip content={t("match_whole_words_hint")}>
                <label className="flex items-center gap-2 text-[13px] text-t1"><input type="checkbox" checked={activeEntry.matchWholeWords} onChange={e => updateAct("matchWholeWords", e.target.checked)} /> {t("lore_match_whole_words")}</label>
              </CustomTooltip>
            </div>
            <div className="mt-3 grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
              <CustomTooltip content={t("probability_hint")}>
                <div><label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("lore_probability")}</label><input className="h-[38px] w-full rounded-md border border-border bg-bg px-2.5 font-ui text-t1 outline-none focus:border-accent" type="number" min="0" max="100" value={activeEntry.probability} onChange={e => updateAct("probability", parseInt(e.target.value))} /></div>
              </CustomTooltip>
              <CustomTooltip content={t("scan_depth_override_hint")}>
                <div><label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("lore_scan_depth_override")}</label><input className="h-[38px] w-full rounded-md border border-border bg-bg px-2.5 font-ui text-t1 outline-none focus:border-accent" type="number" min="-1" value={activeEntry.scanDepthOverride ?? -1} onChange={e => updateAct("scanDepthOverride", parseInt(e.target.value))} /></div>
              </CustomTooltip>
            </div>
          </div>

          {/* Timed Effects */}
          <div className="rounded-lg border border-border bg-s2" style={{ padding: 16 }}>
            <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">{t("lore_timed_section")}</div>
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
              <CustomTooltip content={t("sticky_win_hint")}>
                <div><label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("lore_sticky_window")}</label><input className="h-[38px] w-full rounded-md border border-border bg-bg px-2.5 font-ui text-t1 outline-none focus:border-accent" type="number" min="0" value={activeEntry.stickyWindow} onChange={e => updateAct("stickyWindow", parseInt(e.target.value))} /></div>
              </CustomTooltip>
              <CustomTooltip content={t("cooldown_hint")}>
                <div><label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("lore_cooldown_window")}</label><input className="h-[38px] w-full rounded-md border border-border bg-bg px-2.5 font-ui text-t1 outline-none focus:border-accent" type="number" min="0" value={activeEntry.cooldownWindow} onChange={e => updateAct("cooldownWindow", parseInt(e.target.value))} /></div>
              </CustomTooltip>
              <CustomTooltip content={t("delay_hint")}>
                <div><label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("lore_delay_window")}</label><input className="h-[38px] w-full rounded-md border border-border bg-bg px-2.5 font-ui text-t1 outline-none focus:border-accent" type="number" min="0" value={activeEntry.delayWindow} onChange={e => updateAct("delayWindow", parseInt(e.target.value))} /></div>
              </CustomTooltip>
            </div>
          </div>

          {/* Recursion */}
          <div className="rounded-lg border border-border bg-s2" style={{ padding: 16 }}>
            <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">{t("lore_recursion_section")}</div>
            <div className="flex flex-wrap gap-x-6 gap-y-3">
              <CustomTooltip content={t("exclude_recursion_hint")}>
                <label className="flex items-center gap-2 text-[13px] text-t1"><input type="checkbox" checked={activeEntry.excludeRecursion} onChange={e => updateAct("excludeRecursion", e.target.checked)} /> {t("lore_exclude_recursion")}</label>
              </CustomTooltip>
              <CustomTooltip content={t("prevent_recursion_hint")}>
                <label className="flex items-center gap-2 text-[13px] text-t1"><input type="checkbox" checked={activeEntry.preventRecursion} onChange={e => updateAct("preventRecursion", e.target.checked)} /> {t("lore_prevent_recursion")}</label>
              </CustomTooltip>
              <CustomTooltip content={t("delay_until_recursion_hint")}>
                <label className="flex items-center gap-2 text-[13px] text-t1"><input type="checkbox" checked={activeEntry.delayUntilRecursion} onChange={e => updateAct("delayUntilRecursion", e.target.checked)} /> {t("lore_delay_until_recursion")}</label>
              </CustomTooltip>
            </div>
            {activeEntry.delayUntilRecursion && (
              <div className="mt-3" style={{ maxWidth: 200 }}>
                <CustomTooltip content={t("recursion_level_hint")}>
                  <label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("lore_recursion_label")}</label>
                </CustomTooltip>
                <input className="h-[38px] w-full rounded-md border border-border bg-bg px-2.5 font-ui text-t1 outline-none focus:border-accent" type="number" min="0" value={activeEntry.recursionLevel} onChange={e => updateAct("recursionLevel", parseInt(e.target.value))} />
              </div>
            )}
          </div>

          {/* Inclusion Group */}
          <div className="rounded-lg border border-border bg-s2" style={{ padding: 16 }}>
            <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">{t("lore_inclusion_section")}</div>
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
              <CustomTooltip content={t("group_hint")}>
                <div><label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("lore_group_name")}</label><input className="h-[38px] w-full rounded-md border border-border bg-bg px-2.5 font-ui text-t1 outline-none focus:border-accent" type="text" value={activeEntry.groupName} onChange={e => updateAct("groupName", e.target.value)} /></div>
              </CustomTooltip>
              <CustomTooltip content={t("group_weight_hint")}>
                <div><label className="mb-1.5 block font-ui text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.05em] text-t3">{t("lore_group_weight")}</label><input className="h-[38px] w-full rounded-md border border-border bg-bg px-2.5 font-ui text-t1 outline-none focus:border-accent" type="number" min="0" value={activeEntry.groupWeight} onChange={e => updateAct("groupWeight", parseInt(e.target.value))} /></div>
              </CustomTooltip>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-3">
              <CustomTooltip content={t("prioritize_inclusion_hint")}>
                <label className="flex items-center gap-2 text-[13px] text-t1"><input type="checkbox" checked={activeEntry.prioritizeInclusion} onChange={e => updateAct("prioritizeInclusion", e.target.checked)} /> {t("lore_prioritize_inclusion")}</label>
              </CustomTooltip>
            </div>
          </div>

          {/* Triggers */}
          <div className="rounded-lg border border-border bg-s2" style={{ padding: 16 }}>
            <CustomTooltip content={t("trigger_hint")}>
              <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">{t("lore_triggers_section")} <span className="font-normal text-t3">(?)</span></div>
            </CustomTooltip>
            <div className="flex flex-wrap gap-x-5 gap-y-3">
              {(["normal", "continue", "impersonate", "swipe", "regenerate", "quiet"] as const).map(trig => (
                <label key={trig} className="flex items-center gap-2 text-[13px] text-t1"><input type="checkbox" checked={activeEntry.triggers.includes(trig)} onChange={e => { const next = e.target.checked ? [...activeEntry.triggers, trig] : activeEntry.triggers.filter((t2) => t2 !== trig); updateAct("triggers", next); }} /> {t("trigger_" + trig)}</label>
              ))}
            </div>
          </div>

          {/* Character Filter */}
          <div className="rounded-lg border border-border bg-s2" style={{ padding: 16 }}>
            <CustomTooltip content={t("char_filter_hint")}>
              <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">{t("lore_charfilter_section")} <span className="font-normal text-t3">(?)</span></div>
            </CustomTooltip>
            <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-bg" style={{ padding: "6px 10px", minHeight: 38 }}>
              {activeEntry.characterFilter.map(c => <span key={c} className="cursor-pointer rounded bg-accent-dim px-2 py-0.5 font-ui text-[calc(var(--ui-fs)-3px)] text-accent-t transition-all hover:bg-border2 hover:text-t1" onClick={() => updateAct("characterFilter", activeEntry.characterFilter.filter(x => x !== c))}>{c} \u2715</span>)}
              <input className="min-w-[80px] flex-1 border-0 bg-transparent font-ui text-t1 outline-none" style={{ fontSize: "calc(var(--ui-fs) - 1px)" }} placeholder="Add character..." onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); const v = (e.target as HTMLInputElement).value.trim(); if (v && !activeEntry.characterFilter.includes(v)) { updateAct("characterFilter", [...activeEntry.characterFilter, v]); } (e.target as HTMLInputElement).value = ""; } }} />
            </div>
            <CustomTooltip content={t("char_filter_exclude_hint")}>
              <label className="mt-2 flex items-center gap-2 text-[13px] text-t1"><input type="checkbox" checked={activeEntry.characterFilterExclude} onChange={e => updateAct("characterFilterExclude", e.target.checked)} /> {t("lore_char_filter_exclude")}</label>
            </CustomTooltip>
          </div>

          {/* Match Sources */}
          <div className="rounded-lg border border-border bg-s2" style={{ padding: 16 }}>
            <CustomTooltip content={t("match_sources_hint")}>
              <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent-t">{t("lore_matchsources_section")} <span className="font-normal text-t3">(?)</span></div>
            </CustomTooltip>
            <div className="flex flex-wrap gap-x-5 gap-y-3">
              {(["char_desc", "char_personality", "scenario", "persona_desc", "char_note", "creator_notes"] as const).map(src => (
                <label key={src} className="flex items-center gap-2 text-[13px] text-t1"><input type="checkbox" checked={activeEntry.matchSources.includes(src)} onChange={e => { const next = e.target.checked ? [...activeEntry.matchSources, src] : activeEntry.matchSources.filter(s2 => s2 !== src); updateAct("matchSources", next); }} /> {t("match_src_" + src)}</label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Test panel */}
      <div className="rounded-lg border border-border bg-s2" style={{ padding: 16 }}>
        <div className="font-ui text-[13px] font-medium text-t1" style={{ marginBottom: 8 }}>{t("lore_test_activation")}</div>
        <div className="flex gap-2.5">
          <input className="h-9 flex-1 rounded-md border border-border bg-bg px-3 font-ui text-t1 outline-none" type="text" value={testText} onChange={e => setTestText(e.target.value)} onKeyDown={e => e.key === "Enter" && runTest()} placeholder={t("lore_test_placeholder")} />
          <button className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-3.5 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1" onClick={runTest}>{t("lore_test_run")}</button>
        </div>
        {testResult && (
          <div className={cn("mt-3 flex items-center gap-2 rounded-md font-ui text-xs font-medium", testResult.ok ? "border border-success bg-success-dim text-success-text" : "border border-danger bg-danger-dim text-danger-text")} style={{ padding: 10 }}>
            {testResult.ok ? <Ic.check /> : <Ic.close />} {testResult.msg}
          </div>
        )}
        {testMutData && (
          <div className="mt-3 rounded-md border border-success bg-success-dim font-ui text-xs font-medium text-success-text" style={{ padding: 10 }}>
            <Ic.check /> Activated: {testMutData.activatedIds.length} / {testMutData.totalEntries} entries
          </div>
        )}
      </div>
    </div>
  ) : null;

  // ── Confirm modals ────────────────────────────────────────
  const confirmDeleteEntryModal = confirmDeleteEntry && (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onClick={() => setConfirmDeleteEntry(null)}>
      <div className="flex w-[400px] max-w-[90vw] flex-col overflow-hidden rounded-xl border border-border bg-surface" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border" style={{ padding: "16px 20px" }}>
          <span className="text-sm font-semibold text-t1">{t("delete_entry_confirm")}</span>
          <div className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={() => setConfirmDeleteEntry(null)}><Ic.close /></div>
        </div>
        <div className="p-5 text-[13px] text-t2">{t("delete_entry_msg")}</div>
        <div className="flex justify-end gap-2 border-t border-border" style={{ padding: "12px 20px" }}>
          <button className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1" onClick={() => setConfirmDeleteEntry(null)}>{t("lore_cancel_edit")}</button>
          <button className="h-9 cursor-pointer rounded-md border-0 bg-danger px-4 font-ui text-xs font-medium text-white transition-all" onClick={() => { if (activeLorebookIdForEntry && confirmDeleteEntry) handleDeleteEntry(activeLorebookIdForEntry, confirmDeleteEntry); }}>{t("delete_entry_confirm")}</button>
        </div>
      </div>
    </div>
  );

  const confirmDeleteLorebookModal = confirmDeleteLorebook && (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onClick={() => setConfirmDeleteLorebook(null)}>
      <div className="flex w-[400px] max-w-[90vw] flex-col overflow-hidden rounded-xl border border-border bg-surface" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border" style={{ padding: "16px 20px" }}>
          <span className="text-sm font-semibold text-t1">{t("delete_lorebook_confirm")}</span>
          <div className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={() => setConfirmDeleteLorebook(null)}><Ic.close /></div>
        </div>
        <div className="p-5 text-[13px] text-t2">{t("delete_lorebook_msg")}</div>
        <div className="flex justify-end gap-2 border-t border-border" style={{ padding: "12px 20px" }}>
          <button className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1" onClick={() => setConfirmDeleteLorebook(null)}>{t("lore_cancel_edit")}</button>
          <button className="h-9 cursor-pointer rounded-md border-0 bg-danger px-4 font-ui text-xs font-medium text-white transition-all" onClick={() => handleDeleteLb(confirmDeleteLorebook)}>{t("delete_lorebook_confirm")}</button>
        </div>
      </div>
    </div>
  );

  // ── Import modal ─────────────────────────────────────────
  const importModal = importOpen && (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onClick={closeImportModal}>
      <div className="flex w-[520px] max-w-[90vw] flex-col overflow-hidden rounded-xl border border-border bg-surface" style={{ maxHeight: '80vh' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border" style={{ padding: '16px 20px' }}>
          <span className="text-sm font-semibold text-t1">{t("import_lorebook_title")}</span>
          <div className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={closeImportModal}><Ic.close /></div>
        </div>
        <div className="flex-1 overflow-y-auto" style={{ padding: 20 }}>
          <div className="mb-5 flex gap-2">{([1, 2, 3] as const).map(s => <div key={s} className={cn('h-1 flex-1 rounded-sm', importStep >= s ? 'bg-accent' : 'bg-s3')} />)}</div>

          {importStep === 1 && (
            <>
              <div className="mb-3 text-sm font-medium text-t1">{t("import_step1_title")}</div>
              <div className="mb-4 text-xs text-t2">{t("import_step1_desc")}</div>
              <div
                className="flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed border-border2 p-10 text-center text-t3 transition-all hover:border-accent hover:bg-s2 hover:text-t2"
                onDrop={handleDrop}
                onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                onClick={() => document.getElementById('lb-import-file')?.click()}
              >
                <input id="lb-import-file" type="file" accept=".json" className="hidden" onChange={handleFileInput} />
                <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-s3 text-t2 transition-all"><Ic.import /></div>
                <div className="text-[13px] text-t2">{t("import_drop_browse")}</div>
              </div>
              <button className="mt-4 h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1" onClick={handleImportPaste}>{t("import_paste_clipboard")}</button>
              {importError && <div className="mt-3 text-xs text-danger">{importError}</div>}
            </>
          )}

          {importStep === 2 && (
            <>
              <div className="mb-3 text-sm font-medium text-t1">{t("import_step2_title")}</div>
              <div className="mb-4 text-xs text-t2">{t("import_step2_desc")}</div>
              <div className="mb-4 rounded-lg border border-border bg-s2" style={{ padding: 12 }}>
                <div className="text-[13px] font-medium text-t1" style={{ marginBottom: 4 }}>{t("import_detected_format")}</div>
                <div className="text-xs text-t3">{importEntryCount} {t("import_entries_found")}</div>
                {importFileName && <div className="mt-1 text-xs text-t3">{importFileName}</div>}
              </div>
              <div className="mb-3 text-xs text-t3">{t("import_target_lorebook")}</div>
              <div className="mb-4 flex flex-col gap-1">
                <div
                  className={cn("cursor-pointer rounded-lg border px-3 py-2 text-[13px] transition-all", importTargetLorebookId === null ? "border-accent bg-accent-dim text-accent-t" : "border-border hover:bg-s2 text-t1")}
                  onClick={() => { setImportTargetLorebookId(null); setImportMode("new"); }}
                >
                  {t("import_create_new")}
                </div>
                {lorebooks.map(lb => (
                  <div
                    key={lb.id}
                    className={cn("cursor-pointer rounded-lg border px-3 py-2 text-[13px] transition-all", importTargetLorebookId === lb.id ? "border-accent bg-accent-dim text-accent-t" : "border-border hover:bg-s2 text-t1")}
                    onClick={() => { setImportTargetLorebookId(lb.id); setImportMode("merge"); }}
                  >
                    {lb.name}
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <button className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1" onClick={() => setImportStep(1)}>{t("import_back")}</button>
                <button className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1" onClick={() => setImportStep(3)}>{t("import_next")}</button>
              </div>
            </>
          )}

          {importStep === 3 && (
            <>
              <div className="mb-3 text-sm font-medium text-t1">{t("import_step3_title")}</div>
              {importTargetLorebookId === null ? (
                <>
                  <div className="mb-4 text-xs text-t2">{t("import_new_desc")}</div>
                </>
              ) : (
                <>
                  <div className="mb-4 text-xs text-t2">{t("import_step3_desc")}</div>
                  <div className="mb-4 flex flex-col gap-2">
                    <label className="flex items-center gap-2 text-[13px] text-t1"><input type="radio" name="importMode" checked={importMode === "merge"} onChange={() => setImportMode("merge")} /> {t("import_merge")}</label>
                    <div className="ml-6 text-xs text-t3">{t("import_merge_desc")}</div>
                    <label className="flex items-center gap-2 text-[13px] text-t1"><input type="radio" name="importMode" checked={importMode === "replace"} onChange={() => setImportMode("replace")} /> {t("import_replace")}</label>
                    <div className="ml-6 text-xs text-t3">{t("import_replace_desc")}</div>
                  </div>
                </>
              )}
              <div className="flex gap-2">
                <button className="h-9 cursor-pointer rounded-md border-0 bg-s3 px-4 font-ui text-xs font-medium text-t2 transition-all hover:bg-border2 hover:text-t1" onClick={() => setImportStep(2)}>{t("import_back")}</button>
                <button className="h-9 cursor-pointer rounded-md border-0 bg-accent px-4 font-ui text-xs font-medium text-on-accent transition-all" disabled={importing} onClick={runImport}>{t("import_btn")}</button>
              </div>
              {importMutError && <div className="mt-3 text-xs text-danger">{importMutError}</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );

  // ── Header bar ───────────────────────────────────────────
  const headerBar = (
    <div className="w-full flex shrink-0 items-center gap-2 border-b border-border bg-surface" style={{ padding: isMobile ? "10px 12px" : "10px 20px" }}>
      <div className="flex h-8 w-8 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={handleBackToPick}>{Ic.caret("l")}</div>
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-dim text-accent-t">{tab === "lorebooks" ? <Ic.book /> : <Ic.terminal />}</div>
      <span className="font-ui text-[14px] font-semibold text-t1">{tab === "lorebooks" ? t("lorebooks_card_title") : t("scripts_card_title")}</span>
      <div className="ml-auto flex gap-1">
        {tab === "lorebooks" && (
          <>
            <CustomTooltip content={t("new_lorebook")}>
              <div className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={handleAddLorebook}><Ic.plus /></div>
            </CustomTooltip>
            <CustomTooltip content={t("import_lorebook_title")}>
              <div className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={() => { setImportOpen(true); setImportStep(1); }}><Ic.import /></div>
            </CustomTooltip>
          </>
        )}
        {tab === "scripts" && (
          <>
            <CustomTooltip content={t("new_script")}>
              <div className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={scriptPanel.handleAdd}><Ic.plus /></div>
            </CustomTooltip>
            <CustomTooltip content={t("script_import")}>
              <div className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={scriptPanel.handleImportOpen}><Ic.import /></div>
            </CustomTooltip>
          </>
        )}
      </div>
    </div>
  );

  const editorHeader = (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface" style={{ padding: isMobile ? "10px 12px" : "10px 20px" }}>
      <div className="flex h-8 w-8 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={() => { flushSave(); setView("list"); setActiveEntryId(null); scriptPanel.setActiveScriptId(null); }}>{Ic.caret("l")}</div>
      <span className="flex-1 truncate font-ui text-[14px] font-semibold text-t1">{tab === "lorebooks" ? (activeEntry?.title || "") : ""}</span>
      {/* Save status */}
      <button
        className={cn(
          "h-8 cursor-pointer rounded-md px-3 font-ui text-xs font-medium transition-all select-none",
          savingState === "saving" ? "bg-s3 text-t3" :
          savingState === "saved" ? "bg-success-dim text-success-text" :
          savingState === "error" ? "bg-danger-dim text-danger-text cursor-pointer" :
          dirtyCount > 0 ? "bg-accent text-on-accent" : "bg-s3 text-t3"
        )}
        onClick={savingState === "error" || dirtyCount > 0 ? flushSave : undefined}
      >
        {savingState === "saving" ? t("lore_saving") :
         savingState === "saved" ? t("lore_saved") :
         savingState === "error" ? t("retry") :
         dirtyCount > 0 ? t("lore_save_entry") : t("lore_saved")}
      </button>
    </div>
  );

  // ── RENDER ────────────────────────────────────────────────
  const listAnim = phase === "done" ? "animate-[lbFadeIn_300ms_ease-out]" : "";
  const headerAnim = phase === "done" ? "animate-[lbSlideIn_250ms_ease-out]" : "";

  if (view === "pick") return <div className="flex h-full w-full flex-col overflow-hidden">{pickView}</div>;

  const modals = <>{scriptPanel.modals}{importModal}{confirmDeleteEntryModal}{confirmDeleteLorebookModal}</>;

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden min-h-0">
      {modals}
      {isMobile ? (
        <>
          {view === "list" && (
            <div className={cn("w-full flex flex-1 flex-col overflow-hidden", listAnim)}>
              <div className={cn("w-full", headerAnim)}>{headerBar}</div>
              {scopeBarMobile}
              {tab === "lorebooks" ? lorebookListContent : scriptPanel.scriptListContent}
            </div>
          )}
          {view === "editor" && (
            <div className="flex flex-1 flex-col overflow-hidden">
              {editorHeader}
              <div className="flex-1 overflow-y-auto pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]" style={{ padding: "12px" }}>{tab === "lorebooks" ? entryEditor : scriptPanel.scriptEditorPanel}</div>
            </div>
          )}
        </>
      ) : (
        <>
          {view === "list" && (
            <div className={cn("flex flex-1 flex-col overflow-hidden", listAnim)}>
              <div className={headerAnim}>{headerBar}</div>
              <div className="flex flex-1 overflow-hidden">
                {scopeColumn}
                {tab === "lorebooks" ? lorebookListContent : scriptPanel.scriptListContent}
              </div>
            </div>
          )}
          {view === "editor" && (
            <div className="flex flex-1 flex-col overflow-hidden">
              {editorHeader}
              <div className="flex flex-1 overflow-hidden">
                <div className="flex-1 overflow-y-auto" style={{ padding: "24px 32px" }}>{tab === "lorebooks" ? entryEditor : scriptPanel.scriptEditorPanel}</div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Lorebook Accordion sub-component ───────────────────────────────────

interface LorebookAccordionProps {
  lorebook: LorebookRecord;
  expanded: boolean;
  editing: boolean;
  editLbName: string;
  editLbScope: string;
  activeEntryId: string | null;
  isMobile: boolean;
  actionMenuOpen: boolean;
  onToggleActionMenu: () => void;
  t: (key: string) => string;
  onToggle: () => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onEditLbName: (name: string) => void;
  onEditLbScope: (scope: string) => void;
  onDelete: () => void;
  onAddEntry: () => void;
  onEntryClick: (entryId: string) => void;
  onToggleEnabled: () => void;
}

function LorebookAccordion({
  lorebook, expanded, editing, editLbName, editLbScope, activeEntryId, isMobile, actionMenuOpen, onToggleActionMenu, t,
  onToggle, onStartEdit, onSaveEdit, onCancelEdit, onEditLbName, onEditLbScope,
  onDelete, onAddEntry, onEntryClick, onToggleEnabled,
}: LorebookAccordionProps) {
  const [entries, setEntries] = useState<LoreEntryRecord[]>([]);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    listLoreEntries(lorebook.id).then(data => { if (!cancelled) setEntries(data); });
    return () => { cancelled = true; };
  }, [expanded, lorebook.id]);

  return (
    <div className="mb-3 rounded-xl border border-border bg-surface">
      <div className="flex items-center gap-1.5" style={{ padding: isMobile ? "12px 12px" : "10px 12px", borderRadius: expanded ? "12px 12px 0 0" : 12 }}>
        <div className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2" onClick={onToggle}>
          {expanded ? <span className="text-[10px]">{"\u25BC"}</span> : <span className="text-[10px]">{"\u25B6"}</span>}
        </div>
        {editing ? (
          <div className="flex flex-1 items-center gap-2">
            <input className="flex-1 rounded border border-accent bg-bg px-2 py-0.5 text-[13px] font-medium text-t1 outline-none" value={editLbName} onChange={e => onEditLbName(e.target.value)} onKeyDown={e => e.key === "Enter" && onSaveEdit()} autoFocus />
            <select className="h-7 rounded border border-accent bg-bg px-1.5 text-[11px] text-t1 outline-none" value={editLbScope} onChange={e => onEditLbScope(e.target.value)}>
              <option value="global">{t("scope_global")}</option>
              <option value="character">{t("scope_char")}</option>
              <option value="persona">{t("scope_persona")}</option>
              <option value="chat">{t("scope_chat")}</option>
            </select>
            <div className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-accent-t hover:bg-s2" onClick={onSaveEdit}><Ic.check /></div>
            <div className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-t3 hover:bg-s2" onClick={onCancelEdit}><Ic.close /></div>
          </div>
        ) : (
          <>
            <span className="flex-1 cursor-pointer truncate text-[13px] font-medium text-t1" onClick={onToggle}>{lorebook.name}</span>
            {/* Enabled toggle */}
            <div
              className="relative ml-1 mr-1 h-[22px] w-[40px] shrink-0 cursor-pointer rounded-full transition-[background-color] duration-200 ease-out"
              style={{ backgroundColor: lorebook.enabled ? 'var(--accent)' : 'var(--s3)' }}
              onClick={e => { e.stopPropagation(); onToggleEnabled(); }}
            >
              <div
                className="absolute top-[3px] h-4 w-4 rounded-full shadow-sm transition-[left,background-color] duration-200 ease-out"
                style={{ left: lorebook.enabled ? 19 : 3, backgroundColor: lorebook.enabled ? '#fff' : 'var(--t3)' }}
              />
            </div>
            <span className="shrink-0 rounded-full bg-s3 px-2 py-0.5 font-ui text-[11px] text-t3">{entries.length}</span>
            {isMobile ? (
              <div className="relative ml-1">
                <div
                  className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded text-t2 text-xl leading-none transition-all hover:bg-s2 select-none"
                  onClick={e => { e.stopPropagation(); onToggleActionMenu(); }}
                >
                  ⋮
                </div>
                {actionMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-[99]" onClick={e => { e.stopPropagation(); onToggleActionMenu(); }} />
                    <div
                      className="absolute right-0 top-full z-[100] mt-1 min-w-[160px] overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-theme-lg"
                      onClick={e => e.stopPropagation()}
                    >
                      <div className="flex cursor-pointer items-center gap-2 px-4 py-3 font-ui text-[14px] text-t1 transition-colors hover:bg-s2 active:bg-s3" onClick={e => { e.stopPropagation(); onAddEntry(); onToggleActionMenu(); }}>
                        <Ic.plus /> {t("lore_add_entry")}
                      </div>
                      <div className="flex cursor-pointer items-center gap-2 px-4 py-3 font-ui text-[14px] text-t1 transition-colors hover:bg-s2 active:bg-s3" onClick={e => { e.stopPropagation(); onStartEdit(); onToggleActionMenu(); }}>
                        <Ic.edit /> Edit
                      </div>
                      <div className="flex cursor-pointer items-center gap-2 px-4 py-3 font-ui text-[14px] text-danger transition-colors hover:bg-s2 active:bg-s3" onClick={e => { e.stopPropagation(); onDelete(); onToggleActionMenu(); }}>
                        <Ic.del /> {t("delete_lorebook_confirm")}
                      </div>
                    </div>
                  </>
                )}
              </div>
            ) : (
            <div className="flex shrink-0 items-center gap-0.5 ml-1">
              <CustomTooltip content={t("lore_add_entry")}>
                <div className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={e => { e.stopPropagation(); onAddEntry(); }}><Ic.plus /></div>
              </CustomTooltip>
              <CustomTooltip content={"Edit"}>
                <div className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-t1" onClick={e => { e.stopPropagation(); onStartEdit(); }}><Ic.edit /></div>
              </CustomTooltip>
              <CustomTooltip content={t("delete_lorebook_confirm")}>
                <div className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-t3 transition-all hover:bg-s2 hover:text-danger" onClick={e => { e.stopPropagation(); onDelete(); }}><Ic.del /></div>
              </CustomTooltip>
            </div>
            )}
          </>
        )}
      </div>
      {expanded && !editing && (
        <div className="flex flex-col gap-2 border-t border-border" style={{ padding: "10px 12px" }}>
          {entries.length === 0 && <div className="py-3 text-center font-ui text-[calc(var(--ui-fs)-2px)] text-t3">{t("lore_no_entries")}</div>}
          {entries.map(e => (
            <div key={e.id} className={cn("cursor-pointer rounded-lg border transition-all min-h-[44px]", e.id === activeEntryId ? "border-accent bg-accent-dim" : "border-border bg-surface hover:bg-s2")} style={{ padding: "10px 14px" }} onClick={() => onEntryClick(e.id)}>
              <div className="flex items-center gap-2">
                <div className={cn("h-2 w-2 shrink-0 rounded-full", e.enabled ? "bg-success" : "bg-t3")} />
                <span className={cn("flex-1 truncate text-[13px] font-medium", e.enabled ? "text-t1" : "text-t3 line-through")}>{e.title || t("lore_no_entries")}</span>
              </div>
              <div className="mt-1 truncate font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{e.keys.length > 0 ? `keys: ${e.keys.join(", ")}` : t("lore_no_entries")}</div>
              {e.content && <div className="mt-1.5 font-ui text-[calc(var(--ui-fs)-2px)] leading-relaxed text-t2" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{e.content}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
