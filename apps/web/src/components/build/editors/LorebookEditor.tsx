/**
 * LorebookEditor — корневой компонент управления лорбуками и скриптами.
 *
 * Отвечает за:
 *   - Навигацию между view: pick → list → editor
 *   - Выбор scope (global / character / persona / chat)
 *   - Переключение вкладок lorebooks / scripts
 *   - CRUD лорбуков (создание, обновление мета, удаление)
 *   - CRUD записей (создание, автосохранение, удаление)
 *
 * Визуальные подкомпоненты вынесены в отдельные файлы:
 *   - LorebookAccordion — раскрытый аккордеон одного лорбука
 *   - LoreEntryEditor — форма редактирования записи
 *   - LorebookImportModal — 3-шаговый мастер импорта
 *   - ScriptEditor (useScriptPanel) — редактор скриптов
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Ic } from "../../shared/icons.js";
import { cn } from "../../../lib/cn.js";
import { useT } from "../../../i18n/context.js";
import {
  listLorebooks,
  createLorebook,
  updateLorebookMeta,
  deleteLorebook,
  listLoreEntries,
  createLoreEntry,
  updateLoreEntry,
  reorderLoreEntries,
  getLorebookLinks,
  setLorebookLinks,
  duplicateLorebook,
  exportLorebookSt,
  type LorebookRecord,
  type LoreEntryRecord,
  type LorebookLinkRecord,
} from "../../../app-client.js";

import { useScriptPanel } from "./ScriptEditor.js";
import { CustomTooltip } from "../../shared/Tooltip.js";
import { LorebookAccordion } from "./LorebookAccordion.js";
import type { Scope } from "./LorebookAccordion.js";
import type { LinkTarget } from "../../shared/LinkBindingPopover.js";
import { LoreEntryEditor } from "./LoreEntryEditor.js";
import { LorebookImportModal } from "./LorebookImportModal.js";
import { useAllCharacters } from "../../../stores/snapshot-store.js";
import { useBootstrapStore } from "../../../stores/api-actions/bootstrap-actions.js";

// ── Types ──────────────────────────────────────────────────────────────

type Tab = "lorebooks" | "scripts";
type View = "pick" | "list" | "editor";

const WORLD_LORE_TAB_KEY = "vibe-tavern.world-lore-tab";

function readStickyWorldLoreTab(): Tab | null {
  if (typeof window === "undefined") return null;
  const value = window.sessionStorage.getItem(WORLD_LORE_TAB_KEY);
  return value === "lorebooks" || value === "scripts" ? value : null;
}

function writeStickyWorldLoreTab(tab: Tab | null): void {
  if (typeof window === "undefined") return;
  if (tab) window.sessionStorage.setItem(WORLD_LORE_TAB_KEY, tab);
  else window.sessionStorage.removeItem(WORLD_LORE_TAB_KEY);
}

interface LorebookEditorProps {
  characterId: string;
  chatId: string | null;
  personaId: string | null;
}

// ── Inline keyframes (инжектится один раз) ────────────────────────────

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

// ── Хук определения мобильного устройства ──

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
// Главный компонент
// ════════════════════════════════════════════════════════════════════════

export function LorebookEditor({
  characterId,
  chatId,
  personaId,
}: LorebookEditorProps) {
  const { t, locale } = useT();
  const isMobile = useIsMobile();
  const isRu = locale === "ru";

  // ── Навигация ──
  const stickyInitialTab = useRef<Tab | null>(readStickyWorldLoreTab());
  const [view, setView] = useState<View>(() => stickyInitialTab.current ? "list" : "pick");
  const [tab, setTab] = useState<Tab>(() => stickyInitialTab.current ?? "lorebooks");
  const [scope, setScope] = useState<Scope>("character");

  // Анимация переходов
  const [phase, setPhase] = useState<"idle" | "fading" | "done">("idle");
  const [fadingTab, setFadingTab] = useState<Tab | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    ensureAnimStyle();
    return () => clearTimeout(timer.current);
  }, []);

  // ── Раскрытые аккордеоны ──
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

  // ── Переход pick → list ──
  const handlePick = (target: Tab) => {
    setTab(target);
    writeStickyWorldLoreTab(target);
    setFadingTab(target);
    setPhase("fading");
    timer.current = setTimeout(() => {
      setView("list");
      setPhase("done");
      timer.current = setTimeout(() => {
        setPhase("idle");
        setFadingTab(null);
      }, 300);
    }, 260);
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

  // ── Редактирование мета лорбука (inline в аккордеоне) ──
  const [editingLorebookId, setEditingLorebookId] = useState<string | null>(
    null
  );
  const [editLbName, setEditLbName] = useState("");
  const [editLbScope, setEditLbScope] = useState<Scope>("character");
  const [createdDraftLorebookId, setCreatedDraftLorebookId] = useState<string | null>(null);

  // ── Контекстное меню на мобиле ──
  const [actionMenuLorebookId, setActionMenuLorebookId] = useState<
    string | null
  >(null);

  // ── Хук скриптов ──
  const scriptPanel = useScriptPanel({
    characterId,
    chatId,
    personaId,
    scope,
    onOpenEditor: () => setView("editor"),
    onBackToList: () => setView("list"),
  });

  // ── Активная запись ──
  const [activeEntryId, _setActiveEntryId] = useState<string | null>(null);
  const [activeLorebookIdForEntry, _setActiveLorebookId] = useState<
    string | null
  >(null);

  // Refs для актуальных значений (защита от stale closure в updateAct)
  const activeEntryIdRef = useRef<string | null>(null);
  const activeLorebookIdRef = useRef<string | null>(null);

  const setActiveEntryId = (id: string | null) => {
    _setActiveEntryId(id);
    activeEntryIdRef.current = id;
  };
  const setActiveLorebookIdForEntry = (id: string | null) => {
    _setActiveLorebookId(id);
    activeLorebookIdRef.current = id;
  };

  // ── Подтверждение удаления лорбука ──
  const [confirmDeleteLorebook, setConfirmDeleteLorebook] = useState<
    string | null
  >(null);

  // ── Модалка импорта ──
  const [importOpen, setImportOpen] = useState(false);

  // ── Scope → ownerId ──
  const getOwnerId = useCallback(
    (s: Scope): string | undefined => {
      if (s === "character") return characterId;
      if (s === "persona") return personaId ?? undefined;
      if (s === "chat") return chatId ?? undefined;
      return undefined;
    },
    [characterId, personaId, chatId]
  );

  // ═══ Загрузка лорбуков ═══
  const [lorebooks, setLorebooks] = useState<LorebookRecord[]>([]);
  const [loadingLorebooks, setLoadingLorebooks] = useState(false);

  const refreshLorebooks = useCallback(async () => {
    setLoadingLorebooks(true);
    try {
      setLorebooks(await listLorebooks(scope, getOwnerId(scope)));
    } finally {
      setLoadingLorebooks(false);
    }
  }, [scope, getOwnerId(scope)]);

  useEffect(() => {
    if (view !== "pick") void refreshLorebooks();
  }, [view, refreshLorebooks]);

  // ── Links state: per-lorebook link data ──
  const [lorebookLinksMap, setLorebookLinksMap] = useState<Map<string, LorebookLinkRecord[]>>(new Map());

  // ── Reference data for link popover ──
  const allCharacters = useAllCharacters();
  const personas = useBootstrapStore((s) => s.personas) ?? [];
  const linkCharacters: LinkTarget[] = allCharacters.map((c) => ({
    id: c.id,
    name: c.name,
    avatarAssetId: c.avatarAssetId,
  }));
  const linkPersonas: LinkTarget[] = personas.map((p) => ({
    id: p.id,
    name: p.name,
    avatarAssetId: p.avatarAssetId,
  }));

  // Load links when lorebooks change
  useEffect(() => {
    if (lorebooks.length === 0) {
      setLorebookLinksMap(new Map());
      return;
    }
    let cancelled = false;
    Promise.all(
      lorebooks.map(async (lb) => {
        try {
          const links = await getLorebookLinks(lb.id);
          return [lb.id, links] as const;
        } catch {
          return [lb.id, [] as LorebookLinkRecord[]] as const;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      const map = new Map<string, LorebookLinkRecord[]>();
      for (const [id, links] of results) map.set(id, links);
      setLorebookLinksMap(map);
    });
    return () => { cancelled = true; };
  }, [lorebooks]);

  // ═══ Загрузка записей (для активного лорбука) ═══
  const [entries, setEntries] = useState<LoreEntryRecord[]>([]);
  const activeEntry = entries.find((e) => e.id === activeEntryId) ?? null;

  const refreshEntries = useCallback(async () => {
    if (!activeLorebookIdForEntry) return;
    setEntries(await listLoreEntries(activeLorebookIdForEntry));
  }, [activeLorebookIdForEntry]);

  useEffect(() => {
    if (activeLorebookIdForEntry) void refreshEntries();
  }, [activeLorebookIdForEntry, refreshEntries]);

  // ═══ Мутации лорбуков ═══

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

  const handleDeleteLb = async (id: string) => {
    await deleteLorebook(id);
    if (createdDraftLorebookId === id) setCreatedDraftLorebookId(null);
    await refreshLorebooks();
    setConfirmDeleteLorebook(null);
  };

  // ── Link management ──
  const handleSetLinks = async (
    lorebookId: string,
    links: Array<{ targetType: "character" | "persona"; targetId: string }>,
  ) => {
    const updated = await setLorebookLinks(lorebookId, links);
    setLorebookLinksMap((prev) => {
      const next = new Map(prev);
      next.set(lorebookId, updated);
      return next;
    });
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

  // ═══ Мутации записей ═══

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
      triggers: ["normal", "continue", "swipe", "regenerate"],
      matchSources: [],
    };
    void createLoreEntry(lorebookId, newEntry).then((created) => {
      if (created) {
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

  // ═══ Автосохранение записи (debounce) ═══

  const [savingState, setSavingState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dirtyFieldsRef = useRef<Record<string, unknown>>({});
  const [dirtyCount, setDirtyCount] = useState(0);

  const updateAct = useCallback((field: string, value: unknown) => {
    const entryId = activeEntryIdRef.current;
    const lbId = activeLorebookIdRef.current;
    if (!entryId || !lbId) return;

    setEntries((prev) =>
      prev.map((e) => (e.id === entryId ? { ...e, [field]: value } : e))
    );

    dirtyFieldsRef.current[field] = value;
    setDirtyCount((c) => c + 1);
    setSavingState("idle");

    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => flushSave(), 1000);
  }, []);

  const flushSave = useCallback(async () => {
    const entryId = activeEntryIdRef.current;
    const lbId = activeLorebookIdRef.current;
    if (!entryId || !lbId) return;
    const fields = { ...dirtyFieldsRef.current };
    if (Object.keys(fields).length === 0) return;
    setSavingState("saving");
    try {
      await updateLoreEntry(
        lbId,
        entryId,
        fields as Partial<LoreEntryRecord>
      );
      dirtyFieldsRef.current = {};
      setDirtyCount(0);
      setSavingState("saved");
      setTimeout(
        () => setSavingState((prev) => (prev === "saved" ? "idle" : prev)),
        2000
      );
    } catch {
      setSavingState("error");
    }
  }, []);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  // ═══ Помощники ═══

  const handleAddLorebook = () => {
    const body: {
      name: string;
      scopeType: string;
      characterId?: string;
      personaId?: string;
      chatId?: string;
    } = {
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
    handleUpdateLb(editingLorebookId, {
      name: editLbName,
      scopeType: editLbScope,
    });
  };

  // ══════════════════════════════════════════════════════════════════════
  // UI-фрагменты
  // ══════════════════════════════════════════════════════════════════════

  // ── Scope column (десктоп: вертикальный с иконками) ──
  const scopeItems: { id: Scope; icon: ReactNode; label: string }[] = [
    { id: "global", icon: <Ic.stack />, label: t("scope_global") },
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

  // ── Scope bar (мобильный: горизонтальные чипсы) ──
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

  // ── View: Pick (выбор Lorebooks / Scripts) ──
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

  // ── Список лорбуков ──
  const lorebookListContent = (
    <div
      className={cn(
        "flex-1 overflow-y-auto pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]",
        isMobile &&
          "[&_button]:min-h-[44px] [&_input]:text-base [&_textarea]:text-base [&_select]:text-base"
      )}
      style={{ padding: isMobile ? "12px" : "20px 24px" }}
    >
      {/* Пустое состояние */}
      {lorebooks.length === 0 && (
        <div className="py-10 text-center">
          <div className="mb-2 text-[13px] text-t3">
            {t("lore_no_entries")}
          </div>
          <div className="mx-auto flex justify-center gap-2">
            <button type="button"
              className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border2 bg-transparent px-3 font-ui text-[12px] text-t3 transition-all hover:border-accent hover:text-accent"
              onClick={handleAddLorebook}
            >
              <Ic.plus /> {t("new_lorebook")}
            </button>
            <button type="button"
              className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border2 bg-transparent px-3 font-ui text-[12px] text-t3 transition-all hover:border-accent hover:text-accent"
              onClick={() => setImportOpen(true)}
            >
              <Ic.import /> {t("import_lorebook_title")}
            </button>
          </div>
        </div>
      )}

      {/* Список аккордеонов */}
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
          onSetLinks={(links) => handleSetLinks(lb.id, links)}
          onDuplicate={() => handleDuplicateLb(lb.id)}
          onExport={() => handleExportLb(lb.id)}
          isRu={isRu}
        />
      ))}

      {/* Кнопки внизу списка */}
      {lorebooks.length > 0 && (
        <div className="mt-2 flex gap-2">
          <button type="button"
            className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border2 bg-transparent px-3 font-ui text-[12px] text-t3 transition-all hover:border-accent hover:text-accent"
            onClick={handleAddLorebook}
          >
            <Ic.plus /> {t("new_lorebook")}
          </button>
          <button type="button"
            className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border2 bg-transparent px-3 font-ui text-[12px] text-t3 transition-all hover:border-accent hover:text-accent"
            onClick={() => setImportOpen(true)}
          >
            <Ic.import /> {t("import_lorebook_title")}
          </button>
        </div>
      )}
    </div>
  );

  // ── Header bar (список) ──
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
      {/* Индикатор автосохранения */}
      <button type="button"
        className={cn(
          "h-8 cursor-pointer rounded-md px-3 font-ui text-xs font-medium transition-all select-none",
          savingState === "saving"
            ? "bg-s3 text-t3"
            : savingState === "saved"
              ? "bg-success-dim text-success-text"
              : savingState === "error"
                ? "bg-danger-dim text-danger-text cursor-pointer"
                : dirtyCount > 0
                  ? "bg-accent text-on-accent"
                  : "bg-s3 text-t3"
        )}
        onClick={
          savingState === "error" || dirtyCount > 0 ? flushSave : undefined
        }
      >
        {savingState === "saving"
          ? t("lore_saving")
          : savingState === "saved"
            ? t("lore_saved")
            : savingState === "error"
              ? t("retry")
              : dirtyCount > 0
                ? t("lore_save_entry")
                : t("lore_saved")}
      </button>
    </div>
  );

  // ── Модалка подтверждения удаления лорбука ──
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
      {/* Модалки */}
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

      {/* ── Мобильная раскладка ── */}
      {isMobile ? (
        <>
          {/* Список */}
          {view === "list" && (
            <div
              className={cn(
                "w-full flex flex-1 flex-col overflow-hidden",
                listAnim
              )}
            >
              <div className={cn("w-full", headerAnim)}>{headerBar}</div>
              {scopeBarMobile}
              {tab === "lorebooks"
                ? lorebookListContent
                : scriptPanel.scriptListContent}
            </div>
          )}

          {/* Редактор */}
          {view === "editor" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
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
                  <LoreEntryEditor
                    entry={activeEntry}
                    entryId={activeEntry.id}
                    lorebookId={activeLorebookIdForEntry!}
                    updateAct={updateAct}
                    onDeleted={() => {
                      setActiveEntryId(null);
                      setView("list");
                    }}
                    isMobile={isMobile}
                    t={t}
                  />
                ) : (
                  scriptPanel.scriptEditorPanel
                )}
              </div>
            </div>
          )}
        </>
      ) : (
        /* ── Десктопная раскладка ── */
        <>
          {view === "list" && (
            <div
              className={cn("flex flex-1 flex-col overflow-hidden", listAnim)}
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
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {editorHeader}
              <div className="flex min-h-0 flex-1 overflow-hidden">
                <div
                  className="min-h-0 flex-1 overflow-y-auto"
                  style={{ padding: "24px 32px" }}
                >
                  {tab === "lorebooks" && activeEntry ? (
                    <LoreEntryEditor
                      entry={activeEntry}
                      entryId={activeEntry.id}
                      lorebookId={activeLorebookIdForEntry!}
                      updateAct={updateAct}
                      onDeleted={() => {
                        setActiveEntryId(null);
                        setView("list");
                      }}
                      isMobile={isMobile}
                      t={t}
                    />
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
