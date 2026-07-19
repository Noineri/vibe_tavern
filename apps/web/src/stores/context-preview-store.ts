/**
 * Branch-scoped live context-preview cache.
 *
 * The context preview used to be embedded in every navigation/mutation
 * response (`getSnapshot`, branch/message/variant/chat-switch/chat-create/
 * config-patch builders). On heavy chats that synchronous prompt assembly
 * dominated the response (>99% of a 7s branch response), so switching chats or
 * branches blocked on it. The preview is now a standalone branch-scoped query
 * (`POST /api/chats/:chatId/branches/:branchId/context-preview`) hydrated
 * lazily by this cache — navigation commits immediately and the preview
 * arrives in the background, cancellable.
 *
 * Mirrors the trace-history cache (`trace-history-store.ts`, TL-B2): entries
 * keyed by `${chatId}::${branchId}`. Keying by branch is what keeps fork/
 * activate/delete correct without explicit invalidation — they change
 * `activeBranchId`, which changes the key, so the fetcher pulls the new
 * branch's preview rather than showing the previous branch's stale value.
 *
 * Request cancellation is CLIENT-side only: aborting a fetch stops the result
 * from being applied, but the already-running server assembly is not
 * interrupted (no AbortSignal is threaded through the assembly stack yet). A
 * late-arriving result is rejected unless BOTH its key and request generation
 * are still current, so a slow request can never overwrite a newer branch's
 * value. AbortControllers and generation counters are kept module-private, not
 * in reactive Zustand state.
 */
import { create } from "zustand";
import type { AssemblePromptResponse, ChatBranchId, ChatId } from "@vibe-tavern/domain";
import { fetchContextPreview } from "../api/chat-api.js";
import { useSnapshotStore } from "./snapshot-store.js";

export type ContextPreviewStatus = "idle" | "loading" | "error" | "success";

export interface ContextPreviewEntry {
  status: ContextPreviewStatus;
  preview: AssemblePromptResponse | null;
  error: string | null;
}

interface ContextPreviewState {
  entries: Record<string, ContextPreviewEntry>;
  /** Fetch the preview for a (chatId, branchId) pair. No-op if already loaded/loading. */
  fetch: (chatId: string, branchId: string) => Promise<void>;
  /** Drop every cached entry for a chat (all its branches). */
  invalidateChat: (chatId: string) => void;
  /** Drop one cached entry so the next read refetches. */
  invalidateEntry: (chatId: string, branchId: string) => void;
}

const entryKey = (chatId: string, branchId: string): string => `${chatId}::${branchId}`;

// Module-private: the in-flight controller + generation counter per key. A new
// fetch for a key aborts a still-running fetch for the SAME key; an
// active-key change lets the old key's request finish but its result is
// rejected by generation mismatch at write time. Not reactive state.
const controllers = new Map<string, AbortController>();
const generations = new Map<string, number>();

export const useContextPreviewStore = create<ContextPreviewState>((set, get) => ({
  entries: {},

  fetch: async (chatId, branchId) => {
    const key = entryKey(chatId, branchId);
    const existing = get().entries[key];
    // Skip if a fetch is in flight or already succeeded (caller must
    // invalidateEntry first to force a refresh).
    if (existing?.status === "loading" || existing?.status === "success") return;

    // Abort any in-flight request for the SAME key and bump its generation so
    // the aborted request's late result cannot write.
    controllers.get(key)?.abort();
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    const controller = new AbortController();
    controllers.set(key, controller);

    set((state) => ({
      entries: {
        ...state.entries,
        [key]: { status: "loading", preview: existing?.preview ?? null, error: null },
      },
    }));

    try {
      const { preview } = await fetchContextPreview(chatId as ChatId, branchId as ChatBranchId, controller.signal);
      // Reject a late result: either this request was aborted, or a newer
      // request for the same key superseded it.
      if (controller.signal.aborted || generations.get(key) !== generation) return;
      set((state) => ({
        entries: { ...state.entries, [key]: { status: "success", preview, error: null } },
      }));
    } catch (err) {
      if (controller.signal.aborted || generations.get(key) !== generation) return;
      const message = err instanceof Error ? err.message : String(err);
      const prior = get().entries[key];
      set((state) => ({
        entries: {
          ...state.entries,
          [key]: { status: "error", preview: prior?.preview ?? null, error: message },
        },
      }));
    } finally {
      if (controllers.get(key) === controller) controllers.delete(key);
    }
  },

  invalidateChat: (chatId) =>
    set((state) => {
      const prefix = `${chatId}::`;
      const next: Record<string, ContextPreviewEntry> = {};
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
}));

/** Read the cached entry for a (chatId, branchId) pair (null if not cached). */
export function useContextPreviewEntry(chatId: string | null, branchId: string | null): ContextPreviewEntry | null {
  return useContextPreviewStore((state) => {
    if (!chatId || !branchId) return null;
    return state.entries[entryKey(chatId, branchId)] ?? null;
  });
}

/**
 * Drop the cached preview for the snapshot's active (chatId, branchId) so the
 * next read refetches. Call this at prompt-affecting API action boundaries
 * (message/variant/summary edits, persona/preset/character/memory changes) —
 * NOT inside ingestSnapshot, so the canonical store never guesses derived-query
 * semantics. No-op when there is no active chat/branch or no cached entry.
 * Branch fork/activate/delete need no call: they change activeBranchId, which
 * changes the cache key, so the new branch fetches fresh.
 */
export function invalidateActiveContextPreview(): void {
  const snap = useSnapshotStore.getState();
  if (snap.activeChat && snap.activeBranch) {
    useContextPreviewStore.getState().invalidateEntry(snap.activeChat.id, snap.activeBranch.id);
  }
}
