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
  /** Refetch the active lorebook's entries. Used after creating an entry
   * (add / duplicate) so the new record lands in `entries` before the editor
   * switches to it — otherwise `activeEntry` resolves to null and the editor
   * view falls through to the script panel (a stale-`entries` blank screen). */
  refreshEntries: () => Promise<void>;
  // Entry autosave
  savingState: "idle" | "saving" | "saved" | "error";
  flushSave: () => Promise<void>;
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

  // Refs for current values (stale-closure guard in flushSave).
  const activeEntryIdRef = useRef<string | null>(null);
  const activeLorebookIdRef = useRef<string | null>(null);

  const setActiveEntryId = (id: string | null) => {
    if (id !== activeEntryIdRef.current) {
      // Persist the outgoing entry's pending edits BEFORE swapping the active
      // id. Without this, the entry-switch reset (form.reset in the effect
      // below) would clear the outgoing entry's dirty state before the 1s
      // debounce fires, silently dropping the edit — the ref would already
      // point at the new entry when the timer fires, so flushSave would build
      // an empty patch. flush() captures the outgoing form state synchronously;
      // the PATCH then completes in the background, and flushSave guards its
      // post-save reset so a backgrounded save never clobbers the now-active
      // entry's form. flush() returns early when the outgoing entry is clean,
      // so clean switches stay instant.
      debouncedSave.flush();
      // The new entry loads clean (form.reset in the switch effect); clear any
      // "saving" the outgoing flush just armed so the indicator reflects the
      // new entry, not the backgrounded save.
      setSavingState("idle");
    }
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

  const flushSave = useCallback(async () => {
    const entryId = activeEntryIdRef.current;
    const lbId = activeLorebookIdRef.current;
    if (!entryId || !lbId) return;
    // Build the partial patch from the form's dirty fields. RHF's
    // dirtyFields is a boolean tree mirroring the values shape (arrays and
    // objects become sub-trees); we only need top-level truthiness to know
    // which fields the user touched since the last reset. This replaces the
    // hand-rolled dirtyFieldsRef accumulator — form.formState.dirtyFields is
    // the project-standard source of "what is dirty".
    const values = form.getValues();
    const dirty = form.formState.dirtyFields as unknown as Record<
      string,
      unknown
    >;
    const patch: Record<string, unknown> = {};
    for (const k of Object.keys(values)) {
      if (dirty[k]) patch[k] = values[k as keyof LoreEntryDraft];
    }
    if (Object.keys(patch).length === 0) return;
    setSavingState("saving");
    try {
      await updateLoreEntry(lbId, entryId, patch as Partial<LoreEntryRecord>);
      // Only mark the form clean / flash "saved" if this entry is STILL active.
      // A save flushed just before an entry switch completes in the background
      // while the user is already on a different entry; resetting the (shared)
      // form to this entry's values would clobber the active one, and flashing
      // "saved" would mislabel its indicator. The PATCH itself landed — that is
      // the load-bearing part.
      if (activeEntryIdRef.current !== entryId) return;
      // Mark the form clean: reset defaults to the just-saved values so
      // formState.isDirty clears and the save button leaves its dirty state.
      form.reset(values);
      setSavingState("saved");
      setTimeout(
        () => setSavingState((prev) => (prev === "saved" ? "idle" : prev)),
        2000,
      );
    } catch {
      // Only surface the error if this entry is still active — a backgrounded
      // save of an entry the user already left shouldn't hijack the indicator.
      if (activeEntryIdRef.current === entryId) setSavingState("error");
    }
  }, [form]);

  // Debounced save trigger: 1s after the last edit. `useDebouncedCallback`
  // owns the timer + unmount cleanup internally and exposes `.flush()` — used
  // to fire any pending save on unmount/leave AND on entry switch
  // (setActiveEntryId flushes the outgoing entry before swapping), so a pending
  // edit is never dropped.
  const debouncedSave = useDebouncedCallback(flushSave, 1000);

  // Form → entries mirror + debounced-autosave arm. The form is the direct
  // input for the active entry's fields (register / ControlledField in the
  // editor). This mirrors form changes back into `entries` so the master list
  // (title / enabled / group / keys / content …) stays live while editing, and
  // re-arms the debounced autosave on every field change. `reset` notifications
  // carry no field `name`, so the `!name` guard skips entry switches (no entries
  // storm / spurious save arm).
  useEffect(() => {
    const sub = form.watch((data, { name }) => {
      if (!name) return;
      const entryId = activeEntryIdRef.current;
      if (!entryId) return;
      setEntries((prev) =>
        prev.map((e) =>
          e.id === entryId
            ? { ...e, [name]: (data as Record<string, unknown>)[name] }
            : e,
        ),
      );
      setSavingState("idle");
      debouncedSave();
    });
    return () => sub.unsubscribe();
  }, [form, debouncedSave]);

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
    refreshEntries,
    // Autosave
    savingState,
    flushSave,
    form,
  };
}
