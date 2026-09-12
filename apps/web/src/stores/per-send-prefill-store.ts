import { create } from "zustand";

/**
 * Per-send prefill override (LOCAL_SUPPORT_PLAN LS-4b) — the one-shot value
 * typed into the collapsible strip above the chat input.
 *
 * Semantics: the value arms the NEXT reply's prefill, overriding the prompt
 * preset's persistent `prefill` for that one send, then clears itself. The
 * preset value is never read or written here — the strip is purely the
 * per-send entry point on top of the existing preset mechanism.
 *
 * Consumed imperatively by `handleSend` (use-chat-controller) via
 * {@link usePerSendPrefillStore.getState}.consume() at send time — read +
 * clear in one step so a send can never observe the same override twice.
 */
interface PerSendPrefillState {
  /** The armed one-shot value, or null when nothing is armed. */
  value: string | null;
  setValue: (value: string) => void;
  /** Explicit disarm (the strip's Clear button). */
  clear: () => void;
  /** One-shot read: returns the armed value (or null) and clears the store. */
  consume: () => string | null;
}

export const usePerSendPrefillStore = create<PerSendPrefillState>((set, get) => ({
  value: null,
  setValue: (value) => set({ value: value.length > 0 ? value : null }),
  clear: () => set({ value: null }),
  consume: () => {
    const value = get().value;
    if (value !== null) set({ value: null });
    return value;
  },
}));
