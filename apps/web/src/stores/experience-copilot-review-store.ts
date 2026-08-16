import { create } from "zustand";

/**
 * Experience-copilot review ROUND store — the per-thread, mount-independent
 * half of the editor review state (CD-2 + the "hanging diffs live until
 * accepted" contract).
 *
 * WHY A STORE (not Shell/hook useState): the round must survive the copilot
 * shell UNMOUNTING. The user can leave a proposal unaccepted, navigate to
 * another pane (prompt tracing, tester, …) and come back — the pending diff,
 * the per-hunk accept/dismiss progress and the turn-start snapshot (the diff
 * "before" side) all have to reappear exactly as they were. Activities
 * already live in the module-level turn store; before this store existed the
 * round lived in React state, so `buildBufferReview` got `base === undefined`
 * after a remount and the review silently vanished while the chat history
 * still showed the turn's cards. Everything here is keyed by threadId, and a
 * thread belongs to exactly one script — so per-thread keying also replaces
 * the old `resetKey` (script) reset, which would otherwise wipe the restored
 * round on the mount-time "" → threadId transition.
 *
 * LIFETIME: a round is NOT cleared when a new turn starts — the shell
 * captures the still-pending proposal into `dangling` right before the send
 * (CD-8) and the live proposal wins per buffer once the new turn lands. The
 * round resolves when every hunk of both buffers is accepted/dismissed (the
 * review objects simply go null) or is dropped wholesale by the toolbar
 * revert. Persistence across page reloads (localStorage envelope v2) is
 * wired via `syncPersistedCopilotRound` in `experience-copilot-draft.ts`,
 * called from a Shell effect on every round/activity mutation.
 */

/** CD-2 snapshot of one turn's starting buffers — the revert target AND the
 *  diff "before" side for the inline review (the editor is frozen while the
 *  model works, so the buffers at proposal time equal the snapshot). */
export interface CopilotReviewSnapshot {
  /** Monotonic per-thread id (turn order within the round). */
  id: number;
  rules: string;
  visual: string;
}

/** CD-8 dangling capture: the still-pending proposal frozen right before a
 *  new turn's send clears the live turn store. Per-buffer `rules`/`visual`
 *  carry the proposal texts; `base*` carry the diff bases they were captured
 *  against. Buffers the live turn later touches fall back to this. */
export interface CopilotDanglingCapture {
  rules?: string;
  visual?: string;
  baseRules: string;
  baseVisual: string;
}

/** Which buffer a per-buffer piece of round state belongs to. */
export type CopilotReviewBuffer = "rules" | "visual";

/** The serializable round record. Hunk selections are arrays (not Sets) so
 *  the record round-trips through the localStorage envelope unchanged. */
export interface CopilotReviewRound {
  /** Turn-start snapshots, oldest first (a future checkpoint timeline can use
   *  the stack; revert + diff base read only the last one). */
  snapshots: CopilotReviewSnapshot[];
  /** Id for the NEXT snapshot (per-thread monotonic; serialized with the
   *  round so rehydration keeps ids increasing). */
  nextSnapshotId: number;
  /** CD-6: accepted hunk ids per buffer (RV-1 tooLarge sentinel id included). */
  acceptedRules: number[];
  acceptedVisual: number[];
  /** RV-2: dismissed hunk ids per buffer. */
  dismissedRules: number[];
  dismissedVisual: number[];
  /** RV-1: the review key (`base\0proposed`) each buffer's sets belong to.
   *  `ensureReviewKey` resets a buffer's sets ONLY when the key actually
   *  changed (a new proposal) — a remount with the same proposal must keep
   *  the progress. Null while no proposal is pending for that buffer. */
  rulesKey: string | null;
  visualKey: string | null;
  /** CD-8 dangling capture, if any. */
  dangling: CopilotDanglingCapture | null;
}

export const EMPTY_REVIEW_ROUND: CopilotReviewRound = Object.freeze({
  snapshots: [],
  nextSnapshotId: 1,
  acceptedRules: [],
  acceptedVisual: [],
  dismissedRules: [],
  dismissedVisual: [],
  rulesKey: null,
  visualKey: null,
  dangling: null,
}) as CopilotReviewRound;
// Frozen arrays are shared across readers by design (never mutated in place —
// every action below replaces the slice wholesale), but they are not
// assignable to the mutable array fields, hence the cast at the boundary.

interface ExperienceCopilotReviewState {
  roundsByThread: Record<string, CopilotReviewRound>;
  /** CD-2: push a turn-start snapshot for the thread (rising edge of send). */
  pushSnapshot: (threadId: string, snapshot: Omit<CopilotReviewSnapshot, "id">) => void;
  /** CD-3: pop and return the LAST snapshot (revert consumes it); null when
   *  the stack is empty. */
  popSnapshot: (threadId: string) => CopilotReviewSnapshot | null;
  /** CD-6/RV-2: replace one buffer's accepted-hunk id set. */
  setAcceptedHunks: (threadId: string, buffer: CopilotReviewBuffer, ids: number[]) => void;
  /** RV-2: replace one buffer's dismissed-hunk id set. */
  setDismissedHunks: (threadId: string, buffer: CopilotReviewBuffer, ids: number[]) => void;
  /** RV-1: reset the buffer's sets iff the proposal key changed. Passing the
   *  CURRENT key on every render is safe — a matching key is a no-op, so a
   *  remount preserves the accept/dismiss progress. */
  ensureReviewKey: (threadId: string, buffer: CopilotReviewBuffer, key: string | null) => void;
  /** CD-8: freeze the still-pending proposal before a new turn's send. */
  captureDangling: (threadId: string, capture: CopilotDanglingCapture) => void;
  /** CD-3 toolbar revert: drop the dangling capture. */
  clearDangling: (threadId: string) => void;
  /** Drop one thread's round entirely (tests / future thread deletion). */
  resetRound: (threadId: string) => void;
}

function roundOf(state: ExperienceCopilotReviewState, threadId: string): CopilotReviewRound {
  return state.roundsByThread[threadId] ?? EMPTY_REVIEW_ROUND;
}

function writeRound(
  state: ExperienceCopilotReviewState,
  threadId: string,
  mutate: (round: CopilotReviewRound) => CopilotReviewRound,
): Partial<ExperienceCopilotReviewState> {
  const current = roundOf(state, threadId);
  const next = mutate(current);
  return { roundsByThread: { ...state.roundsByThread, [threadId]: next } };
}

export const useCopilotReviewRoundStore = create<ExperienceCopilotReviewState>((set, get) => ({
  roundsByThread: {},
  pushSnapshot: (threadId, snapshot) => {
    set((s) =>
      writeRound(s, threadId, (round) => ({
        ...round,
        snapshots: [...round.snapshots, { ...snapshot, id: round.nextSnapshotId }],
        nextSnapshotId: round.nextSnapshotId + 1,
      })),
    );
  },
  popSnapshot: (threadId) => {
    const round = roundOf(get(), threadId);
    const last = round.snapshots[round.snapshots.length - 1];
    if (!last) return null;
    set((s) =>
      writeRound(s, threadId, (r) => ({ ...r, snapshots: r.snapshots.slice(0, -1) })),
    );
    return last;
  },
  setAcceptedHunks: (threadId, buffer, ids) => {
    set((s) =>
      writeRound(s, threadId, (round) =>
        buffer === "rules" ? { ...round, acceptedRules: ids } : { ...round, acceptedVisual: ids },
      ),
    );
  },
  setDismissedHunks: (threadId, buffer, ids) => {
    set((s) =>
      writeRound(s, threadId, (round) =>
        buffer === "rules" ? { ...round, dismissedRules: ids } : { ...round, dismissedVisual: ids },
      ),
    );
  },
  ensureReviewKey: (threadId, buffer, key) => {
    const round = roundOf(get(), threadId);
    const currentKey = buffer === "rules" ? round.rulesKey : round.visualKey;
    if (currentKey === key) return;
    set((s) =>
      writeRound(s, threadId, (r) =>
        buffer === "rules"
          ? { ...r, rulesKey: key, acceptedRules: [], dismissedRules: [] }
          : { ...r, visualKey: key, acceptedVisual: [], dismissedVisual: [] },
      ),
    );
  },
  captureDangling: (threadId, capture) => {
    set((s) => writeRound(s, threadId, (round) => ({ ...round, dangling: capture })));
  },
  clearDangling: (threadId) => {
    set((s) => writeRound(s, threadId, (round) => ({ ...round, dangling: null })));
  },
  resetRound: (threadId) => {
    set((s) => {
      if (s.roundsByThread[threadId] === undefined) return s;
      const next = { ...s.roundsByThread };
      delete next[threadId];
      return { roundsByThread: next };
    });
  },
}));

if (typeof window !== "undefined") {
  window.__useCopilotReviewRoundStore = useCopilotReviewRoundStore;
}
