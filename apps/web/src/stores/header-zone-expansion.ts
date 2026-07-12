import { create } from "zustand";

// ────────────────────────────────────────────────────────────────────────────
// Header Zone Expansion — per-message expansion state for the assistant
// message's adaptive context header (AssistantContextHeader).
// ────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS
//   The cross-zone coordination channel between the adaptive header (which owns
//   geometry) and the insight zones registered at `assistant_header_zone`
//   (Objective / Scene, supplied by INSIGHTS_PLAN). Each zone expands
//   independently and toggles ITS flag here; the header reads the aggregate
//   `anyExpanded` to grow the avatar into a portrait, switch to the multi-column
//   panel, and render separators. Identity (avatar + name) is built into the
//   header and is NOT an expansion key.
//
// WHY A STORE (not local header state)
//   The zones render through the message-slot-registry as opaque `render(ctx)`
//   fragments — they are not children the header can lift state from. A tiny
//   keyed store lets a zone and the header subscribe to the same per-message
//   state independently, with primitive-returning selectors that preserve the
//   render-isolation contract (a non-target message shows 0 commits).
//
// CONTRACT FOR CONSUMERS (INSIGHTS_PLAN INS-6 / INS-11)
//   - Objective zone toggles `objectiveOpen`.
//   - Scene zone toggles `sceneOpen`.
//   - The header reads `useAnyHeaderZoneOpen(messageId)` for avatar growth +
//     layout mode + separators.
//   - Keys are intentionally fixed to the two insight zones this header hosts;
//     if a third zone is ever added, extend HeaderZoneKey + the anyExpanded
//     reducer rather than introducing a parallel mechanism.
// ────────────────────────────────────────────────────────────────────────────

/** Expansion keys — one per insight zone the adaptive header hosts. */
export type HeaderZoneKey = "objectiveOpen" | "sceneOpen";

interface HeaderZoneExpansionState {
  /** messageId → which zones are open (absent key = collapsed). */
  open: Record<string, Partial<Record<HeaderZoneKey, boolean>>>;
  /** Set a single zone's open state for a message. */
  set: (messageId: string, zone: HeaderZoneKey, value: boolean) => void;
  /** Toggle a single zone's open state for a message. */
  toggle: (messageId: string, zone: HeaderZoneKey) => void;
  /** Drop a message's entry entirely (call on header unmount to avoid leaks). */
  clear: (messageId: string) => void;
}

export const useHeaderZoneExpansionStore = create<HeaderZoneExpansionState>((set) => ({
  open: {},
  set: (messageId, zone, value) => {
    set((s) => {
      const cur = s.open[messageId];
      // No-op when the value already matches — avoids a spurious re-render of
      // every subscriber (including the header's anyExpanded selector).
      if (cur?.[zone] === value) return s;
      return { open: { ...s.open, [messageId]: { ...cur, [zone]: value } } };
    });
  },
  toggle: (messageId, zone) => {
    set((s) => {
      const cur = s.open[messageId]?.[zone] ?? false;
      return { open: { ...s.open, [messageId]: { ...s.open[messageId], [zone]: !cur } } };
    });
  },
  clear: (messageId) => {
    set((s) => {
      if (!s.open[messageId]) return s;
      const next = { ...s.open };
      delete next[messageId];
      return { open: next };
    });
  },
}));

// ────────────────────────────────────────────────────────────────────────────
// Selector hooks — all return primitives so a non-target message never
// re-renders (render-isolation contract).
// ────────────────────────────────────────────────────────────────────────────

/** Read one zone's open state for a message (false when absent). Zones use this. */
export function useHeaderZoneOpen(messageId: string, zone: HeaderZoneKey): boolean {
  return useHeaderZoneExpansionStore((s) => s.open[messageId]?.[zone] ?? false);
}

/** Read whether ANY hosted zone is open for a message. The header uses this. */
export function useAnyHeaderZoneOpen(messageId: string): boolean {
  return useHeaderZoneExpansionStore(
    (s) => !!(s.open[messageId]?.objectiveOpen || s.open[messageId]?.sceneOpen),
  );
}

// Debug helper — mirrors the window.__ exposure pattern used by the other
// ephemeral stores. Lets a live Playwright / dev-console session inspect the
// expansion state to diagnose "avatar not growing" / "zone won't expand".
if (typeof window !== "undefined") {
  (window as unknown as { __useHeaderZoneExpansionStore?: unknown }).__useHeaderZoneExpansionStore =
    useHeaderZoneExpansionStore;
}
