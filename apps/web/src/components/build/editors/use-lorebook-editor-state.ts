/**
 * useLorebookEditorState — the data + navigation controller for LorebookEditor.
 *
 * Extracted from LorebookEditor.tsx (god-object state decomposition — see
 * reports/LOREBOOK_EDITOR_GOD_OBJECT_AUDIT.md). Owns the three state concerns
 * that are pure data/navigation and have no render shape of their own:
 *
 *   - Navigation: view (pick → list → editor), tab (lorebooks / scripts),
 *     scope (all / global / character / persona / chat) + the sticky-tab
 *     sessionStorage persistence.
 *   - Active entry: which lorebook's entry is open in the editor, with
 *     ref-mirrored setters so the autosave flush reads non-stale ids.
 *   - Lorebook / link / entry data + the debounced entry autosave.
 *
 * What stays in the component: the view-transition animation (phase/fadingTab),
 * accordion expand, inline lorebook-meta edit, action menu, delete/import
 * modals, and the render itself. Those orchestrate local UI state plus this
 * hook's primitives, so they remain where the render is.
 *
 * Behavior is preserved byte-for-byte from the original inline declarations —
 * this is a relocation, not a redesign. The LorebookEditor characterization
 * tests (LorebookEditor.test.tsx) pin the observable contract.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { useDebouncedCallback } from "use-debounce";
import {
  listAllLorebooks,
  listLorebooks,
  listLoreEntries,
  updateLoreEntry,
  getLorebookLinks,
  setLorebookLinks,
  type LorebookRecord,
  type LoreEntryRecord,
  type LorebookLinkRecord,
} from "../../../app-client.js";
import type { Scope } from "./LorebookAccordion.js";

// ── Types ──────────────────────────────────────────────────────────────

export type Tab = "lorebooks" | "scripts";
export type View = "pick" | "list" | "editor";

// ── Active-entry form values (react-hook-form) ─────────────────────────

/**
 * The RHF form-values shape for the active-entry editor. It is the whole
 * `LoreEntryRecord`: non-editable fields (`id`, `lorebookId`, `sortOrder`)
 * are carried as defaultValues and simply never registered, so they never
 * become dirty. Keeping the full record lets `form.reset(activeEntry)` work
 * directly with no stripping/projection.
 */
export type LoreEntryDraft = LoreEntryRecord;

/**
 * Placeholder defaultValues before any entry is open (activeEntry is null).
 * Its values are never rendered — the editor only mounts once an entry
 * resolves, and the reset effect repopulates the form on open — so the exact
 * placeholders are immaterial; they just satisfy `useForm`'s defaultValues
 * and keep every field non-undefined.
 */
const EMPTY_ENTRY_DRAFT: LoreEntryDraft = {
  id: "",
  lorebookId: "",
  title: "",
  content: "",
  keys: [],
  secondaryKeys: [],
  logic: "AND_ANY",
  position: "before_char",
  depth: 0,
  priority: 0,
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
  sortOrder: 0,
};

// ── Sticky-tab persistence (sessionStorage) ────────────────────────────

const WORLD_LORE_TAB_KEY = "vibe-tavern.world-lore-tab";

export function readStickyWorldLoreTab(): Tab | null {
  if (typeof window === "undefined") return null;
  const value = window.sessionStorage.getItem(WORLD_LORE_TAB_KEY);
  return value === "lorebooks" || value === "scripts" ? value : null;
}

export function writeStickyWorldLoreTab(tab: Tab | null): void {
  if (typeof window === "undefined") return;
  if (tab) window.sessionStorage.setItem(WORLD_LORE_TAB_KEY, tab);
  else window.sessionStorage.removeItem(WORLD_LORE_TAB_KEY);
}

// ── Hook args / return ─────────────────────────────────────────────────

export interface UseLorebookEditorStateArgs {
  characterId: string;
  chatId: string | null;
  personaId: string | null;
}

export interface LorebookEditorState {
  // Navigation
  view: View;
  tab: Tab;
  scope: Scope;
  setView: (view: View) => void;
  setTab: (tab: Tab) => void;
  setScope: (scope: Scope) => void;
  // Active entry (editor target)
  activeEntryId: string | null;
  activeLorebookIdForEntry: string | null;
  setActiveEntryId: (id: string | null) => void;
  setActiveLorebookIdForEntry: (id: string | null) => void;
  // Lorebook data
  lorebooks: LorebookRecord[];
  refreshLorebooks: () => Promise<void>;
  // Links data
  lorebookLinksMap: Map<string, LorebookLinkRecord[]>;
  handleSetLinks: (
    lorebookId: string,
    links: Array<{ targetType: "character" | "persona"; targetId: string }>,
  ) => Promise<void>;
  // Entry data (for the active lorebook)
  activeEntry: LoreEntryRecord | null;
  existingGroups: string[];
  // Entry autosave
  savingState: "idle" | "saving" | "saved" | "error";
  dirtyCount: number;
  flushSave: () => Promise<void>;
  updateAct: (field: string, value: unknown) => void;
  // Active-entry edit form (react-hook-form) — Step 2 scaffolding; Steps 3–4
  // bind fields to it and rewire autosave onto form.formState.
  form: UseFormReturn<LoreEntryDraft>;
}

// ── Hook ───────────────────────────────────────────────────────────────

export function useLorebookEditorState({
  characterId,
  chatId,
  personaId,
}: UseLorebookEditorStateArgs): LorebookEditorState {
  // ── Navigation ──
  const stickyInitialTab = useRef<Tab | null>(readStickyWorldLoreTab());
  const [view, setView] = useState<View>(() =>
    stickyInitialTab.current ? "list" : "pick",
  );
  const [tab, setTab] = useState<Tab>(
    () => stickyInitialTab.current ?? "lorebooks",
  );
  const [scope, setScope] = useState<Scope>("all");

  // ── Active entry ──
  const [activeEntryId, _setActiveEntryId] = useState<string | null>(null);
  const [activeLorebookIdForEntry, _setActiveLorebookId] = useState<
    string | null
  >(null);

  // Refs for current values (stale-closure guard in updateAct / flushSave).
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

  // ── Scope → ownerId ──
  const getOwnerId = useCallback(
    (s: Scope): string | undefined => {
      if (s === "character") return characterId;
      if (s === "persona") return personaId ?? undefined;
      if (s === "chat") return chatId ?? undefined;
      return undefined;
    },
    [characterId, personaId, chatId],
  );

  // ═══ Lorebook loading ═══
  const [lorebooks, setLorebooks] = useState<LorebookRecord[]>([]);
  const [loadingLorebooks, setLoadingLorebooks] = useState(false);

  const refreshLorebooks = useCallback(async () => {
    setLoadingLorebooks(true);
    try {
      // "all" is a display filter, not a real scopeType — it lists every
      // lorebook regardless of binding. The dedicated endpoint returns the
      // unfiltered set; ownerId is irrelevant for it.
      setLorebooks(
        scope === "all"
          ? await listAllLorebooks()
          : await listLorebooks(scope, getOwnerId(scope)),
      );
    } finally {
      setLoadingLorebooks(false);
    }
  }, [scope, getOwnerId(scope)]);

  useEffect(() => {
    if (view !== "pick") void refreshLorebooks();
  }, [view, refreshLorebooks]);

  // ── Links state: per-lorebook link data ──
  const [lorebookLinksMap, setLorebookLinksMap] = useState<
    Map<string, LorebookLinkRecord[]>
  >(new Map());

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
    return () => {
      cancelled = true;
    };
  }, [lorebooks]);

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

  // ═══ Entry loading (for the active lorebook) ═══
  const [entries, setEntries] = useState<LoreEntryRecord[]>([]);
  const activeEntry = entries.find((e) => e.id === activeEntryId) ?? null;
  // Distinct non-empty group names in the current lorebook — used by the
  // entry editor's group-name input autocomplete (datalist).
  const existingGroups = useMemo(
    () =>
      Array.from(
        new Set(
          entries.map((e) => e.groupName).filter((g): g is string => !!g),
        ),
      ).sort(),
    [entries],
  );

  const refreshEntries = useCallback(async () => {
    if (!activeLorebookIdForEntry) return;
    setEntries(await listLoreEntries(activeLorebookIdForEntry));
  }, [activeLorebookIdForEntry]);

  useEffect(() => {
    if (activeLorebookIdForEntry) void refreshEntries();
  }, [activeLorebookIdForEntry, refreshEntries]);

  // ═══ Active-entry edit form (react-hook-form) ═══
  // The form owns the active entry's field state. defaultValues come from the
  // active entry (or an empty placeholder before one is open); a reset effect
  // repopulates it whenever the active entry *id* changes (open / switch).
  // The dep is the id, not the entry object, so in-flight edits — which mutate
  // `entries` but keep the id — do not wipe the form. Field binding and the
  // autosave rewire onto form.formState land in Steps 3–4; this step only
  // establishes the form instance + the <FormProvider> context the editor
  // view wraps in.
  const form = useForm<LoreEntryDraft>({
    defaultValues: activeEntry ?? EMPTY_ENTRY_DRAFT,
  });
  useEffect(() => {
    if (activeEntry) form.reset(activeEntry);
    // dep: entry id only — see the block comment above.
  }, [activeEntry?.id]);

  // ═══ Entry autosave (debounced) ═══
  const [savingState, setSavingState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const dirtyFieldsRef = useRef<Record<string, unknown>>({});
  const [dirtyCount, setDirtyCount] = useState(0);

  const flushSave = useCallback(async () => {
    const entryId = activeEntryIdRef.current;
    const lbId = activeLorebookIdRef.current;
    if (!entryId || !lbId) return;
    const fields = { ...dirtyFieldsRef.current };
    if (Object.keys(fields).length === 0) return;
    setSavingState("saving");
    try {
      await updateLoreEntry(lbId, entryId, fields as Partial<LoreEntryRecord>);
      dirtyFieldsRef.current = {};
      setDirtyCount(0);
      setSavingState("saved");
      setTimeout(
        () => setSavingState((prev) => (prev === "saved" ? "idle" : prev)),
        2000,
      );
    } catch {
      setSavingState("error");
    }
  }, []);

  // Debounced save trigger: 1s after the last edit. `useDebouncedCallback`
  // owns the timer + unmount cleanup internally and exposes `.flush()` — used
  // below to fire any pending save on unmount/leave instead of dropping it.
  const debouncedSave = useDebouncedCallback(flushSave, 1000);

  const updateAct = useCallback(
    (field: string, value: unknown) => {
      const entryId = activeEntryIdRef.current;
      const lbId = activeLorebookIdRef.current;
      if (!entryId || !lbId) return;

      setEntries((prev) =>
        prev.map((e) => (e.id === entryId ? { ...e, [field]: value } : e)),
      );

      dirtyFieldsRef.current[field] = value;
      setDirtyCount((c) => c + 1);
      setSavingState("idle");

      debouncedSave();
    },
    [debouncedSave],
  );

  // Fire any pending save on unmount.
  useEffect(() => {
    return () => {
      void debouncedSave.flush();
    };
  }, [debouncedSave]);

  return {
    // Navigation
    view,
    tab,
    scope,
    setView,
    setTab,
    setScope,
    // Active entry
    activeEntryId,
    activeLorebookIdForEntry,
    setActiveEntryId,
    setActiveLorebookIdForEntry,
    // Lorebook data
    lorebooks,
    refreshLorebooks,
    // Links data
    lorebookLinksMap,
    handleSetLinks,
    // Entry data
    activeEntry,
    existingGroups,
    // Autosave
    savingState,
    dirtyCount,
    flushSave,
    updateAct,
    form,
  };
}
