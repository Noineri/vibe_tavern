/**
 * Session-local agent feed row UI state (AFP-3, AGENT_FEED_PERFORMANCE_PLAN
 * Wave 1 step 5): disclosures (tool accordions, caption reasoning toggles,
 * lazy event details), restored inner scroll positions and dirty inline
 * edit drafts — keyed by the row's STABLE logical identity (the window's
 * unit id), so a row's UI state survives virtual unmount, prepend and
 * viewport remount WITHOUT keeping invisible row DOM alive.
 *
 * Deliberately NOT a zustand slice and NOT persisted: the state lives in a
 * plain per-session store owned by `AgentFeedUiStateProvider`. A REAL
 * session change (`sessionKey` prop) swaps the store — expanded cards and
 * drafts clear there; busy/deletion/discard rules (AFP-4) call the row-level
 * operations. Nothing here survives a reload or touches storage.
 *
 * Subscription contract: the context exposes the STABLE store reference and
 * per-item hooks built on `useSyncExternalStore` with a per-key
 * subscription — a draft keystroke in one row re-renders THAT row only,
 * never the whole feed (no whole-map subscription anywhere).
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/** One row's retained UI state. Absent fields mean "default/unset". */
export interface AgentFeedRowUiEntry {
  /** Disclosure for collapsible rows (accordion open, reasoning expanded,
   *  event detail open). Absent = collapsed (the default). */
  disclosed?: boolean;
  /** A dirty inline edit draft — present while a draft is open. Cleared on
   *  commit, explicit discard or the busy/deletion rules (AFP-4). */
  draft?: string;
  /** The row's inner scroll position to restore when it remounts expanded
   *  (lazy detail bodies — AFP-16). */
  scrollTop?: number;
}

/** The per-session store. Plain and dependency-free on purpose. */
export interface AgentFeedUiStateStore {
  /** The row's retained state — a STABLE reference between patches
   *  (`undefined` while the row has no retained state). */
  getRowState(key: string): AgentFeedRowUiEntry | undefined;
  /** Merge one patch into a row's state; `undefined` values REMOVE their
   *  field. A patch that changes nothing is a no-op (no notification). */
  setRowState(key: string, patch: Partial<AgentFeedRowUiEntry>): void;
  /** Drop a row's state entirely (discard / row deleted). */
  clearRowState(key: string): void;
  /** Per-key subscription for `useSyncExternalStore`. */
  subscribeRow(key: string, listener: () => void): () => void;
  /** Clear EVERY row — a real session change (never a remount). */
  reset(): void;
}

export function createAgentFeedUiStateStore(): AgentFeedUiStateStore {
  const rows = new Map<string, AgentFeedRowUiEntry>();
  const listeners = new Map<string, Set<() => void>>();
  const emit = (key: string) => {
    const set = listeners.get(key);
    if (set !== undefined) for (const listener of set) listener();
  };
  return {
    getRowState: (key) => rows.get(key),
    setRowState(key, patch) {
      const prev = rows.get(key);
      const next: AgentFeedRowUiEntry = { ...(prev ?? {}) };
      const fields = ["disclosed", "draft", "scrollTop"] as const;
      for (const field of fields) {
        if (!(field in patch)) continue;
        if (field === "disclosed") {
          if (patch.disclosed === undefined) delete next.disclosed;
          else next.disclosed = patch.disclosed;
        } else if (field === "draft") {
          if (patch.draft === undefined) delete next.draft;
          else next.draft = patch.draft;
        } else {
          if (patch.scrollTop === undefined) delete next.scrollTop;
          else next.scrollTop = patch.scrollTop;
        }
      }
      const unchanged =
        next.disclosed === (prev?.disclosed as boolean | undefined) &&
        next.draft === (prev?.draft as string | undefined) &&
        next.scrollTop === (prev?.scrollTop as number | undefined);
      if (unchanged) return;
      const hasAny = fields.some((field) => field in next);
      if (hasAny) rows.set(key, next);
      else rows.delete(key);
      emit(key);
    },
    clearRowState(key) {
      if (!rows.delete(key)) return;
      emit(key);
    },
    subscribeRow(key, listener) {
      let set = listeners.get(key);
      if (set === undefined) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      return () => {
        set!.delete(listener);
        if (set!.size === 0) listeners.delete(key);
      };
    },
    reset() {
      const keys = [...rows.keys()];
      rows.clear();
      for (const key of keys) emit(key);
    },
  };
}

// ─── React binding ───────────────────────────────────────────────────────────

const AgentFeedUiStateContext = createContext<AgentFeedUiStateStore | null>(null);

/**
 * Owns one UI-state store per session. Changing `sessionKey` creates a
 * FRESH store (the old state is dropped with the old store — expanded
 * cards and drafts do not leak across sessions); re-renders with the same
 * key keep the same store instance.
 */
export function AgentFeedUiStateProvider({
  sessionKey,
  children,
}: {
  /** Identity of the open session (kind + threadId) — a change is a REAL
   *  session switch and resets all retained row state. */
  sessionKey: string;
  children: ReactNode;
}) {
  const store = useMemo(() => createAgentFeedUiStateStore(), [sessionKey]);
  return <AgentFeedUiStateContext.Provider value={store}>{children}</AgentFeedUiStateContext.Provider>;
}

/** The session's store — stable reference (for AFP-4 adapters that batch
 *  row updates outside the render path). */
export function useAgentFeedUiStateStore(): AgentFeedUiStateStore {
  const store = useContext(AgentFeedUiStateContext);
  if (store === null) {
    throw new Error("useAgentFeedUiStateStore requires AgentFeedUiStateProvider");
  }
  return store;
}

/** No-op store backing the OPTIONAL consumer access (AFP-4): reads return
 * nothing, writes/subscriptions are no-ops, so a consumer mounted OUTSIDE a
 * feed session (the RP chat, provider-less tests, the pre-AFP-6 list) keeps
 * exactly its local fallback semantics. */
const NOOP_FEED_UI_STATE_STORE: AgentFeedUiStateStore = {
  getRowState: () => undefined,
  setRowState: () => {},
  clearRowState: () => {},
  subscribeRow: () => () => {},
  reset: () => {},
};

/** Stable empty entry for rows with no retained state (so consumers never
 *  see `undefined` and the snapshot identity is constant). */
const EMPTY_ROW_ENTRY: Readonly<AgentFeedRowUiEntry> = Object.freeze({});

export interface AgentFeedRowUiState {
  /** The row's retained state (stable object; the frozen empty entry while
   *  nothing is retained). */
  entry: Readonly<AgentFeedRowUiEntry>;
  setDisclosed: (disclosed: boolean) => void;
  /** `undefined` clears the draft (commit/discard). */
  setDraft: (draft: string | undefined) => void;
  setScrollTop: (scrollTop: number) => void;
  /** Drop all retained state for this row. */
  clear: () => void;
}

function useRowUiState(store: AgentFeedUiStateStore, key: string): AgentFeedRowUiState {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeRow(key, listener),
    [store, key],
  );
  const getSnapshot = useCallback(() => store.getRowState(key), [store, key]);
  const entry = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setDisclosed = useCallback(
    (disclosed: boolean) => store.setRowState(key, { disclosed }),
    [store, key],
  );
  const setDraft = useCallback(
    (draft: string | undefined) => store.setRowState(key, { draft }),
    [store, key],
  );
  const setScrollTop = useCallback(
    (scrollTop: number) => store.setRowState(key, { scrollTop }),
    [store, key],
  );
  const clear = useCallback(() => store.clearRowState(key), [store, key]);
  return { entry: entry ?? EMPTY_ROW_ENTRY, setDisclosed, setDraft, setScrollTop, clear };
}

/**
 * One row's retained UI state, subscribed by the row's key ONLY — a patch
 * to any other row (or the whole-map `reset`) does not re-render this row
 * unless its own state actually changed.
 */
export function useAgentFeedRowUiState(key: string): AgentFeedRowUiState {
  return useRowUiState(useAgentFeedUiStateStore(), key);
}

/**
 * AFP-4 consumer access: the row's retained state, or `null` when no
 * `AgentFeedUiStateProvider` wraps the tree — the caller then keeps its
 * local fallback (identical default/toggle/write semantics, nothing
 * retained). Never throws, so shared components (`MessageReasoning`,
 * `AgentToolAccordion`, …) render unchanged in non-feed surfaces.
 */
export function useOptionalAgentFeedRowUiState(key: string): AgentFeedRowUiState | null {
  const store = useContext(AgentFeedUiStateContext);
  const row = useRowUiState(store ?? NOOP_FEED_UI_STATE_STORE, key);
  return store === null ? null : row;
}

/**
 * AFP-4 convenience: one collapsible row's open state — retained in the
 * session store (the entry's `disclosed` field) when a provider is present,
 * plain `useState` otherwise. Both arms have identical default/toggle
 * semantics; the retained arm survives row unmount/remount.
 */
export function useAgentFeedDisclosure(
  key: string,
  defaultOpen: boolean,
): { open: boolean; toggle: () => void; setOpen: (open: boolean) => void } {
  const row = useOptionalAgentFeedRowUiState(key);
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  if (row === null) {
    return {
      open: localOpen,
      toggle: () => setLocalOpen((v) => !v),
      setOpen: setLocalOpen,
    };
  }
  const open = row.entry.disclosed ?? defaultOpen;
  return { open, toggle: () => row.setDisclosed(!open), setOpen: row.setDisclosed };
}
