/**
 * TL-B2 — branch-scoped prompt-trace history cache.
 *
 * Replaces the `promptTraceHistory` field that used to ship in every
 * SessionSnapshot (removed in TL-A2). Trace history is now lazy-loaded via
 * GET /api/chats/:chatId/traces (TL-A1) and cached here, keyed by
 * `${chatId}::${branchId}`.
 *
 * Keying by branch is what fixes the branch-vanish defects
 * (reports/trace-branch-vanish.md):
 *   - Defect A: switching branches changes the key, so the fetcher pulls the
 *     new branch's traces rather than showing the previous branch's stale
 *     cached set. No explicit invalidation hook is needed for fork/activate/
 *     delete — they all change activeBranchId, which changes the key.
 *   - Defect B: because the cached list is already branch-scoped, BuildMode's
 *     prev/next navigation indexes the correct list (no client-side filtering
 *     divergence).
 *
 * The single latest trace still lives on the snapshot store (`promptTrace`)
 * so the post-generation badge lights up immediately without a refetch; this
 * cache only holds the HISTORY list for navigation.
 */
import { create } from "zustand";
import { useCallback, useEffect, useMemo } from "react";
import type { ChatId, PromptTraceRecordDto } from "@vibe-tavern/domain";
import { fetchTraceHistory } from "../api/chat-api.js";

export type TraceHistoryStatus = "idle" | "loading" | "error" | "success";

export interface TraceHistoryEntry {
  status: TraceHistoryStatus;
  traces: PromptTraceRecordDto[];
  error: string | null;
}

interface TraceHistoryState {
  entries: Record<string, TraceHistoryEntry>;
  /** Fetch the history for a (chatId, branchId) pair. No-op if already loaded/loading. */
  fetch: (chatId: string, branchId: string) => Promise<void>;
  /** Drop every cached entry for a chat (all its branches). */
  invalidateChat: (chatId: string) => void;
  /** Drop one cached entry so the next read refetches. */
  invalidateEntry: (chatId: string, branchId: string) => void;
  /**
   * Optimistically prepend the snapshot's freshly-produced trace to a
   * populated cache entry, so the post-generation view is immediate. Only
   * acts on an already-success entry (don't populate an unopened tab).
   * No-op if the trace is already present.
   */
  upsertLatest: (chatId: string, branchId: string, trace: PromptTraceRecordDto) => void;
}

const entryKey = (chatId: string, branchId: string): string => `${chatId}::${branchId}`;

export const useTraceHistoryStore = create<TraceHistoryState>((set, get) => ({
  entries: {},

  fetch: async (chatId, branchId) => {
    const key = entryKey(chatId, branchId);
    const existing = get().entries[key];
    // Skip if a fetch is in flight or already succeeded (caller must
    // invalidateEntry first to force a refresh).
    if (existing?.status === "loading" || existing?.status === "success") return;

    set((state) => ({
      entries: {
        ...state.entries,
        [key]: { status: "loading", traces: existing?.traces ?? [], error: null },
      },
    }));

    try {
      const traces = await fetchTraceHistory(chatId as ChatId, { branchId });
      set((state) => ({
        entries: { ...state.entries, [key]: { status: "success", traces, error: null } },
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        entries: {
          ...state.entries,
          [key]: { status: "error", traces: existing?.traces ?? [], error: message },
        },
      }));
    }
  },

  invalidateChat: (chatId) =>
    set((state) => {
      const prefix = `${chatId}::`;
      const next: Record<string, TraceHistoryEntry> = {};
      for (const [k, v] of Object.entries(state.entries)) {
        if (!k.startsWith(prefix)) next[k] = v;
      }
      return { entries: next };
    }),

  invalidateEntry: (chatId, branchId) =>
    set((state) => {
      const key = entryKey(chatId, branchId);
      if (!state.entries[key]) return state;
      const next = { ...state.entries };
      delete next[key];
      return { entries: next };
    }),

  upsertLatest: (chatId, branchId, trace) =>
    set((state) => {
      const key = entryKey(chatId, branchId);
      const existing = state.entries[key];
      if (!existing || existing.status !== "success") return state;
      if (existing.traces.some((t) => t.id === trace.id)) return state;
      return {
        entries: { ...state.entries, [key]: { ...existing, traces: [trace, ...existing.traces] } },
      };
    }),
}));

/** Read the cached entry for a (chatId, branchId) pair (null if not cached). */
export function useTraceHistoryEntry(chatId: string | null, branchId: string | null): TraceHistoryEntry | null {
  return useTraceHistoryStore((state) => {
    if (!chatId || !branchId) return null;
    return state.entries[entryKey(chatId, branchId)] ?? null;
  });
}

/**
 * Read + auto-fetch the trace history for a branch. Triggers a fetch on mount
 * and whenever (chatId, branchId) changes; returns the cached list + status.
 * Call this from the Trace tab (BuildMode). Non-trace consumers should read
 * `promptTrace` (latest) from the snapshot store instead.
 *
 * `enabled` gates the fetch (not the cache read): pass false when the Trace
 * tab is closed so we don't fetch history the user isn't looking at. The
 * cached entry is still returned so a previously-fetched list survives a
 * tab toggle without a refetch.
 */
export function useTraceHistory(
  chatId: string | null,
  branchId: string | null,
  enabled = true,
): {
  traces: PromptTraceRecordDto[];
  status: TraceHistoryStatus;
  error: string | null;
  refetch: () => void;
} {
  const entry = useTraceHistoryEntry(chatId, branchId);
  const fetch = useTraceHistoryStore((s) => s.fetch);

  useEffect(() => {
    if (enabled && chatId && branchId) void fetch(chatId, branchId);
  }, [enabled, chatId, branchId, fetch]);

  const refetch = useCallback(() => {
    if (!chatId || !branchId) return;
    useTraceHistoryStore.getState().invalidateEntry(chatId, branchId);
    void fetch(chatId, branchId);
  }, [chatId, branchId, fetch]);

  return useMemo(
    () => ({
      traces: entry?.traces ?? [],
      status: entry?.status ?? "idle",
      error: entry?.error ?? null,
      refetch,
    }),
    [entry, refetch],
  );
}
