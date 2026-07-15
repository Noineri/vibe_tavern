import { create } from "zustand";

// ────────────────────────────────────────────────────────────────────────────
// Scene Generation Status — frontend cache of currently-generating variants.
// ────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS
//   A primitive Set of immutable variant IDs whose Scene record is currently
//   being generated (by the header's Generate/Update, the auto background
//   starter, or the pre-send forward-state attempt). It drives the Scene zone's
//   loading/Cancel affordance and (in SCN-13) the message-edit lock.
//
// WHY A STORE (not local component state)
//   The Scene zone renders through the message-slot-registry as an opaque
//   `render(ctx)` fragment — it cannot lift state to a parent, and the same
//   variant's generation may be started by one control and observed by another
//   (the header vs. the edit lock in MessageBlock). A tiny keyed store lets
//   independent observers subscribe to the same generating set with primitive
//   selectors that preserve the render-isolation contract (a non-generating
//   variant's header shows 0 commits).
//
// AUTHORITY
//   The SERVER coordinator is the source of truth. This cache is a UX hint:
//   it is populated optimistically when the user fires a header Generate/Update
//   and reconciled on settle/cancel; it is hydrated/revalidated through the
//   target status endpoint on mount/focus/reload (SCN-12 zone) so a reload or
//   another tab's job is reflected. It is NEVER the correctness boundary — the
//   server-side freshness/ownership guards remain the final backstop.
// ────────────────────────────────────────────────────────────────────────────

interface SceneGenerationState {
  /** Immutable variant IDs whose Scene record is currently generating. */
  generating: Set<string>;
  /** Mark a variant as generating (idempotent). */
  markGenerating: (variantId: string) => void;
  /** Clear a variant's generating flag (idempotent). */
  clearGenerating: (variantId: string) => void;
  /** Clear every generating flag (used on chat switch). */
  clearAll: () => void;
}

export const useSceneGenerationStore = create<SceneGenerationState>((set) => ({
  generating: new Set<string>(),
  markGenerating: (variantId) => {
    set((s) => {
      if (s.generating.has(variantId)) return s;
      const next = new Set(s.generating);
      next.add(variantId);
      return { generating: next };
    });
  },
  clearGenerating: (variantId) => {
    set((s) => {
      if (!s.generating.has(variantId)) return s;
      const next = new Set(s.generating);
      next.delete(variantId);
      return { generating: next };
    });
  },
  clearAll: () => {
    set((s) => (s.generating.size === 0 ? s : { generating: new Set<string>() }));
  },
}));

/** Hook: is the given immutable variant currently generating? Returns a stable
 *  boolean (Object.is) so a non-generating variant's header never re-renders. */
export function useIsSceneGenerating(variantId: string): boolean {
  return useSceneGenerationStore((s) => s.generating.has(variantId));
}

/** Non-hook imperative check — for click-time guards / preflight in event
 *  handlers (e.g. the SCN-13 edit lock in MessageBlock) that must read the
 *  current generating set outside the render cycle. */
export function isVariantSceneGenerating(variantId: string): boolean {
  return useSceneGenerationStore.getState().generating.has(variantId);
}

// Debug helper — mirrors the window.__ exposure pattern used by the other
// ephemeral stores. Lets a live Playwright / dev-console session inspect which
// variants are generating to diagnose "header stuck loading".
if (typeof window !== "undefined") {
  (window as unknown as { __useSceneGenerationStore?: unknown }).__useSceneGenerationStore =
    useSceneGenerationStore;
}
