import { useCallback } from "react";
import { create } from "zustand";

/**
 * The sidechat's ONE open flag (SIDECHAT_PLAN, Wave 5 / SC-18a) — the shared
 * home of the per-chat open state the desktop panel (SC-14) and the mobile
 * tabs (SC-15) used to hold in two independent `usePersistedBoolean`
 * instances. A third writer (SC-18's RP-message entry) changes neither
 * instance, so the sidechat would not open — every surface and every future
 * entry reads and writes through this store instead.
 *
 * - Persisted per chat under the SAME `vt.sidechat.open.<chatId>` key SC-14
 *   established (default closed; absent/unparseable → closed). Stored values
 *   from before this unit carry over unchanged — the spelling and the
 *   `"true"`/`"false"` encoding are untouched.
 * - The key's single spelling lives HERE (re-exported by `sidechat-host.tsx`
 *   for the pair's owner module), not in either surface, so the two never
 *   fork it — and no store imports from components (the intra-app layering
 *   runs components → stores, never the reverse).
 * - SC-14's key-change semantics are preserved: a chat switch reads the NEW
 *   chat's stored value during render (no stale frame commits) and never
 *   writes one chat's state under another chat's key (writes always carry
 *   the chat they were called with). The store map stays sparse — a chat
 *   with no entry reads straight from its key.
 *
 * Plain zustand store (UI state, not canonical data — the exemplar is
 * `sidechat-mobile-store.ts`). SC-18 imports `useSidechatOpenStore` and calls
 * `getState().setOpen(chatId, true)` to open the sidechat from outside
 * React; surfaces render through `useSidechatOpen(chatId)`.
 */

/** Storage key prefix for the per-chat open state (chat id appended). */
export const SIDECHAT_OPEN_KEY_PREFIX = "vt.sidechat.open.";

/** Setter value: a literal or an updater, mirroring `useState`. */
export type SidechatOpenUpdate = boolean | ((prev: boolean) => boolean);

interface SidechatOpenState {
  /** In-memory open flag per chat id (sparse — absent means "read the key"). */
  openByChat: Record<string, boolean>;
  /** Writes one chat's flag (storage + map); a no-op for a null chat id never reaches here. */
  setOpen: (chatId: string, open: SidechatOpenUpdate) => void;
}

/** Pure read of one chat's stored flag (default closed; guarded, never throws). */
export function readSidechatOpen(chatId: string | null): boolean {
  if (chatId === null) return false;
  try {
    const stored = localStorage.getItem(`${SIDECHAT_OPEN_KEY_PREFIX}${chatId}`);
    return stored === null ? false : stored === "true";
  } catch {
    return false;
  }
}

function writeSidechatOpen(chatId: string, open: boolean): void {
  try {
    localStorage.setItem(`${SIDECHAT_OPEN_KEY_PREFIX}${chatId}`, open ? "true" : "false");
  } catch {
    /* ignore quota / private mode — the in-memory state still updates below */
  }
}

export const useSidechatOpenStore = create<SidechatOpenState>((set, get) => ({
  openByChat: {},
  setOpen: (chatId, update) => {
    const prev = get().openByChat[chatId] ?? readSidechatOpen(chatId);
    const next = typeof update === "function" ? (update as (prev: boolean) => boolean)(prev) : update;
    if (get().openByChat[chatId] === next) return;
    writeSidechatOpen(chatId, next);
    set((s) => ({ openByChat: { ...s.openByChat, [chatId]: next } }));
  },
}));

/**
 * One chat's open flag as a `[value, setValue]` tuple — the same shape as the
 * `usePersistedBoolean` pair this replaces, so both surfaces keep their call
 * sites. The value re-reads on chat switch (the map holds per-chat entries,
 * unknown chats read their key during render); the setter no-ops for a null
 * chat (no panel owns the flag while no chat is active).
 */
export function useSidechatOpen(chatId: string | null): readonly [boolean, (update: SidechatOpenUpdate) => void] {
  const stored = useSidechatOpenStore((s) => (chatId === null ? undefined : s.openByChat[chatId]));
  const open = stored ?? readSidechatOpen(chatId);
  const setOpenForChat = useCallback(
    (update: SidechatOpenUpdate) => {
      if (chatId === null) return;
      useSidechatOpenStore.getState().setOpen(chatId, update);
    },
    [chatId],
  );
  return [open, setOpenForChat] as const;
}

// Debug helper — mirrors the window.__ exposure pattern used by the other
// ephemeral stores. Lets a live Playwright / dev-console session inspect the
// open flag to diagnose "sidechat did not open" reports.
if (typeof window !== "undefined") {
  (window as unknown as { __useSidechatOpenStore?: unknown }).__useSidechatOpenStore =
    useSidechatOpenStore;
}
