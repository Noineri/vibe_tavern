import { create } from "zustand";
import { agentThreadKey, type AgentKind } from "../lib/agent-host-registry.js";
import type { AgentReviewBufferSnapshot as AgentReviewSnapshot, AgentDanglingCapture, AgentReviewRound } from "@vibe-tavern/api-contracts";
import { appendAgentReviewSnapshot, ensureAgentReviewKey } from "@vibe-tavern/api-contracts";
export type { AgentReviewBufferSnapshot as AgentReviewSnapshot, AgentDanglingCapture, AgentReviewRound } from "@vibe-tavern/api-contracts";

/**
 * Agent review ROUND store (AS-5) — the generic rename of the
 * experience-copilot review round store. The per-thread, mount-independent
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
 *
 * AS-6c-ii keying (decision AS-5/Option A — the kind parameter lands here
 * atomically with the shared key helper and the selector migration, never
 * in a commit where store keys are still bare): every action takes the host
 * `kind` first and keys its rounds map through `agentThreadKey(kind,
 * threadId)` (lib/agent-host-registry.ts — the single source). The
 * experience kind keeps the LEGACY BARE threadId (the localStorage draft
 * envelope persists bare keys — see the helper's persistence contract);
 * later kinds namespace to `${kind}:${threadId}`.
 */

/** Which buffer a per-buffer piece of round state belongs to. */
export type AgentReviewBuffer = "rules" | "visual";

export const EMPTY_REVIEW_ROUND: AgentReviewRound = Object.freeze({
  snapshots: [],
  nextSnapshotId: 1,
  acceptedRules: [],
  acceptedVisual: [],
  dismissedRules: [],
  dismissedVisual: [],
  rulesKey: null,
  visualKey: null,
  dangling: null,
}) as AgentReviewRound;
// Frozen arrays are shared across readers by design (never mutated in place —
// every action below replaces the slice wholesale), but they are not
// assignable to the mutable array fields, hence the cast at the boundary.

interface AgentReviewState {
  roundsByThread: Record<string, AgentReviewRound>;
  /** CD-2: push a turn-start snapshot for the thread (rising edge of send). */
  pushSnapshot: (kind: AgentKind, threadId: string, snapshot: Omit<AgentReviewSnapshot, "id">) => void;
  /** CD-3: pop and return the LAST snapshot (revert consumes it); null when
   *  the stack is empty. */
  popSnapshot: (kind: AgentKind, threadId: string) => AgentReviewSnapshot | null;
  /** CD-6/RV-2: replace one buffer's accepted-hunk id set. */
  setAcceptedHunks: (kind: AgentKind, threadId: string, buffer: AgentReviewBuffer, ids: number[]) => void;
  /** RV-2: replace one buffer's dismissed-hunk id set. */
  setDismissedHunks: (kind: AgentKind, threadId: string, buffer: AgentReviewBuffer, ids: number[]) => void;
  /** RV-1: reset the buffer's sets iff the proposal key changed. Passing the
   *  CURRENT key on every render is safe — a matching key is a no-op, so a
   *  remount preserves the accept/dismiss progress. */
  ensureReviewKey: (kind: AgentKind, threadId: string, buffer: AgentReviewBuffer, key: string | null) => void;
  /** CD-8: freeze the still-pending proposal before a new turn's send. */
  captureDangling: (kind: AgentKind, threadId: string, capture: AgentDanglingCapture) => void;
  /** CD-3 toolbar revert: drop the dangling capture. */
  clearDangling: (kind: AgentKind, threadId: string) => void;
  /** Drop one thread's round entirely (tests / future thread deletion). */
  resetRound: (kind: AgentKind, threadId: string) => void;
}

function roundOf(state: AgentReviewState, key: string): AgentReviewRound {
  return state.roundsByThread[key] ?? EMPTY_REVIEW_ROUND;
}

function writeRound(
  state: AgentReviewState,
  key: string,
  mutate: (round: AgentReviewRound) => AgentReviewRound,
): Partial<AgentReviewState> {
  const current = roundOf(state, key);
  const next = mutate(current);
  return { roundsByThread: { ...state.roundsByThread, [key]: next } };
}

export const useAgentReviewRoundStore = create<AgentReviewState>((set, get) => ({
  roundsByThread: {},
  pushSnapshot: (kind, threadId, snapshot) => {
    const key = agentThreadKey(kind, threadId);
    set((s) =>
      writeRound(s, key, (round) => appendAgentReviewSnapshot(round, snapshot)),
    );
  },
  popSnapshot: (kind, threadId) => {
    const key = agentThreadKey(kind, threadId);
    const round = roundOf(get(), key);
    const last = round.snapshots[round.snapshots.length - 1];
    if (!last) return null;
    set((s) =>
      writeRound(s, key, (r) => ({ ...r, snapshots: r.snapshots.slice(0, -1) })),
    );
    return last;
  },
  setAcceptedHunks: (kind, threadId, buffer, ids) => {
    const key = agentThreadKey(kind, threadId);
    set((s) =>
      writeRound(s, key, (round) =>
        buffer === "rules" ? { ...round, acceptedRules: ids } : { ...round, acceptedVisual: ids },
      ),
    );
  },
  setDismissedHunks: (kind, threadId, buffer, ids) => {
    const key = agentThreadKey(kind, threadId);
    set((s) =>
      writeRound(s, key, (round) =>
        buffer === "rules" ? { ...round, dismissedRules: ids } : { ...round, dismissedVisual: ids },
      ),
    );
  },
  ensureReviewKey: (kind, threadId, buffer, key) => {
    const storeKey = agentThreadKey(kind, threadId);
    const round = roundOf(get(), storeKey);
    if (ensureAgentReviewKey(round, buffer, key) === round) return;
    set((s) =>
      writeRound(s, storeKey, (r) => ensureAgentReviewKey(r, buffer, key)),
    );
  },
  captureDangling: (kind, threadId, capture) => {
    const key = agentThreadKey(kind, threadId);
    set((s) => writeRound(s, key, (round) => ({ ...round, dangling: capture })));
  },
  clearDangling: (kind, threadId) => {
    const key = agentThreadKey(kind, threadId);
    set((s) => writeRound(s, key, (round) => ({ ...round, dangling: null })));
  },
  resetRound: (kind, threadId) => {
    const key = agentThreadKey(kind, threadId);
    set((s) => {
      if (s.roundsByThread[key] === undefined) return s;
      const next = { ...s.roundsByThread };
      delete next[key];
      return { roundsByThread: next };
    });
  },
}));

if (typeof window !== "undefined") {
  window.__useAgentReviewRoundStore = useAgentReviewRoundStore;
}
