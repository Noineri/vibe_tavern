/**
 * ER-10a — cross-session persistence of unapplied experience-copilot proposals
 * (the "draft" that survives a page reload).
 *
 * The experience-copilot turn store (`experience-copilot-turn-store.ts`) is
 * deliberately ephemeral: it holds a turn's tool activities in memory with no
 * `persist` middleware, because the backend does not persist tool calls onto
 * the message record. The consequence is that a page reload wipes any in-review
 * proposal, so the user loses the diff + review affordance and has to re-run
 * the turn. ER-10 persists the FINALIZED proposed-producing activities (the
 * subset `aggregateExperienceCopilotProposal` derives from) to localStorage,
 * keyed by threadId, and rehydrates them on boot.
 *
 * ENVELOPE V2 — THE WHOLE ROUND. A review is more than its activities: the
 * turn-start snapshot (the diff "before" side), the per-buffer accepted /
 * dismissed hunk ids and the CD-8 dangling capture all live in the review-round
 * store (`experience-copilot-review-store.ts`) and are needed to rebuild the
 * SAME review after a reload — without the round the rehydrated activities
 * would have `base === undefined` and render nothing. V2 therefore persists
 * `{ activities, round }` together; a V1 envelope (activities only) still
 * loads, degraded (no review anchor).
 *
 * WRITE SIDE. `syncPersistedCopilotRound(threadId)` is the single entry point
 * the copilot shell calls from an effect on every round/activity mutation: it
 * reads both stores and either saves or CLEARS the key. The key survives while
 * anything reviewable remains (finalized activities OR a dangling capture);
 * a fully resolved / reverted round removes it. Unsaved buffer edits and
 * accepted-hunk text do NOT survive a reload (the draft buffers are in-memory),
 * so a rehydrated review may diff against a base the current buffer drifted
 * from — the standard CD-8 conflict semantics (anchor-or-skip, toast) handle
 * exactly that, on purpose, with no silent rebase.
 *
 * TWO PLAIN-TEXT BUFFERS. The copilot edits exactly two buffers — `rules` (the
 * script's code) and `visual` (the active visual's source) — and nothing else.
 * There is no profile.md, no greetings, no lore bundle: a finalized activity is
 * simply a `done` tool result carrying a `target` ("rules" | "visual") and a
 * non-empty `proposed` text. The read-only tools (`read_skill_file`,
 * `run_test`, `run_simulate`, `suggest_visual_binding`) never carry
 * `target`/`proposed`, so they are naturally excluded.
 *
 * WHY ONLY THE FINALIZED SUBSET. Streaming placeholders and errors are
 * transient and carry no reviewable content. Persisting them would rehydrate a
 * dead "AI is editing…" state pointing at a stream that no longer exists. The
 * persisted set is exactly what `aggregateExperienceCopilotProposal` consumes,
 * so rehydration reconstructs the same two-buffer diff with zero new UI.
 *
 * VERSIONING. The envelope carries `_v`. A version mismatch on load (e.g.
 * after a schema change) discards the entry rather than seeding incompatible
 * data — the user simply sees no draft, same as before ER-10. Malformed JSON
 * is likewise discarded (best-effort: persistence is a convenience, never a
 * correctness constraint — the canonical buffers are the script/visual draft
 * stores' source of truth).
 */
import type { ExperienceCopilotToolActivity } from "../stores/experience-copilot-turn-store.js";
import { useExperienceCopilotTurnStore } from "../stores/experience-copilot-turn-store.js";
import type { CopilotReviewRound } from "../stores/experience-copilot-review-store.js";
import { useCopilotReviewRoundStore } from "../stores/experience-copilot-review-store.js";

const DRAFT_PREFIX = "vt:experience-copilot-draft:";
const DRAFT_VERSION = 2;

/** localStorage envelope — versioned so a future schema change can migrate/discard. */
interface DraftEnvelope {
  _v: number;
  activities: unknown[];
  /** V2: the review round (snapshots / hunk selections / dangling). */
  round: CopilotReviewRound | null;
}

/** What a parsed envelope yields: the finalized activities plus (V2 only) the
 *  review round. `round` is null for V1 envelopes and for a malformed round —
 *  the activities still load, degraded. */
export interface ParsedCopilotDraft {
  activities: ExperienceCopilotToolActivity[];
  round: CopilotReviewRound | null;
}

/**
 * Type guard for a finalized, proposed-producing activity. Mirrors the filter
 * in `experience-copilot-apply.ts` (`aggregateExperienceCopilotProposal`) so
 * the persisted subset is exactly what the aggregator consumes. Defensive: a
 * value that fails any clause is dropped on load (corruption / version-skew
 * defense).
 */
export function isFinalizedActivity(x: unknown): x is ExperienceCopilotToolActivity {
  if (typeof x !== "object" || x === null) return false;
  const a = x as Record<string, unknown>;
  if (
    a.status !== "done"
    || typeof a.toolCallId !== "string"
    || typeof a.toolName !== "string"
    || (a.target !== "rules" && a.target !== "visual")
    || typeof a.proposed !== "string"
    || a.proposed.length === 0
  ) return false;
  return true;
}

/** Type guard for the V2 review-round payload. Mirrors the round store's
 *  `CopilotReviewRound` shape field by field — a value that fails any clause
 *  degrades to `round: null` while the activities still load. */
export function isReviewRound(x: unknown): x is CopilotReviewRound {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  if (!Array.isArray(r.snapshots) || typeof r.nextSnapshotId !== "number") return false;
  for (const s of r.snapshots) {
    if (typeof s !== "object" || s === null) return false;
    const sn = s as Record<string, unknown>;
    if (typeof sn.id !== "number" || typeof sn.rules !== "string" || typeof sn.visual !== "string") return false;
  }
  for (const arr of [r.acceptedRules, r.acceptedVisual, r.dismissedRules, r.dismissedVisual]) {
    if (!Array.isArray(arr) || arr.some((v) => typeof v !== "number" || !Number.isInteger(v))) return false;
  }
  if (!(typeof r.rulesKey === "string" || r.rulesKey === null)) return false;
  if (!(typeof r.visualKey === "string" || r.visualKey === null)) return false;
  const d = r.dangling;
  if (d != null) {
    if (typeof d !== "object") return false;
    const dd = d as Record<string, unknown>;
    if (typeof dd.baseRules !== "string" || typeof dd.baseVisual !== "string") return false;
    if (!(dd.rules === undefined || typeof dd.rules === "string")) return false;
    if (!(dd.visual === undefined || typeof dd.visual === "string")) return false;
  }
  return true;
}

/**
 * Reduce a thread's activities to the persistable finalized-proposed subset,
 * deduped by `toolCallId` (later wins) in insertion order — mirroring the
 * store's own upsert-merge semantics. Pure: no I/O.
 */
export function finalizeForPersistence(activities: ExperienceCopilotToolActivity[]): ExperienceCopilotToolActivity[] {
  // Map (not Set) so a later duplicate toolCallId OVERWRITES the value while
  // preserving the first occurrence's POSITION — mirroring both the store's
  // upsert-merge (later fields win) and `aggregateExperienceCopilotProposal`'s
  // finalizedActivities dedup. Map iteration is insertion order.
  const byId = new Map<string, ExperienceCopilotToolActivity>();
  for (const a of activities) {
    if (!isFinalizedActivity(a)) continue;
    byId.set(a.toolCallId, a);
  }
  return [...byId.values()];
}

/**
 * Serialize a thread's activities + review round to the versioned persistence
 * envelope. Returns `null` when nothing reviewable remains (no finalized
 * proposal AND no dangling capture — snapshots alone rehydrate nothing without
 * a proposal source, so a resolved/reverted round clears the key). Pure: no I/O.
 */
export function serializeDraft(
  activities: ExperienceCopilotToolActivity[],
  round: CopilotReviewRound | null,
): string | null {
  const finalized = finalizeForPersistence(activities);
  if (finalized.length === 0 && round?.dangling == null) return null;
  const envelope: DraftEnvelope = { _v: DRAFT_VERSION, activities: finalized, round };
  return JSON.stringify(envelope);
}

/**
 * Parse + validate a persisted envelope (V2: activities + round; V1: activities
 * only, round degrades to null). Returns null if absent / malformed /
 * version-skewed / nothing-reviewable-after-filter. Pure: no I/O.
 */
export function parseDraft(raw: string | null): ParsedCopilotDraft | null {
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // corrupted JSON — discard
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const env = parsed as DraftEnvelope;
  if (env._v !== DRAFT_VERSION && env._v !== 1) return null; // version skew — discard
  if (!Array.isArray(env.activities)) return null;
  const finalized = env.activities.filter(isFinalizedActivity);
  const round = env._v >= 2 && isReviewRound(env.round) ? env.round : null;
  if (finalized.length === 0 && round === null) return null;
  return { activities: finalized, round };
}

function key(threadId: string): string {
  return DRAFT_PREFIX + threadId;
}

/**
 * Persist a thread's activities (filtered to the finalized subset) + review
 * round. When nothing reviewable remains the key is removed instead.
 * Best-effort: any localStorage failure (quota / disabled / absent) is
 * swallowed — the in-memory proposal still works for the current session.
 * No-op without localStorage.
 */
export function saveDraft(
  threadId: string,
  activities: ExperienceCopilotToolActivity[],
  round: CopilotReviewRound | null,
): void {
  if (typeof localStorage === "undefined") return;
  const json = serializeDraft(activities, round);
  try {
    if (json === null) {
      localStorage.removeItem(key(threadId));
    } else {
      localStorage.setItem(key(threadId), json);
    }
  } catch {
    // best-effort
  }
}

/** Load + validate a thread's persisted draft (activities + round).
 *  `null` if absent/malformed. No-op without localStorage. */
export function loadDraft(threadId: string): ParsedCopilotDraft | null {
  if (typeof localStorage === "undefined") return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(key(threadId));
  } catch {
    return null;
  }
  return parseDraft(raw);
}

/** Remove a thread's persisted draft (Apply / Reject / turn-start). No-op without localStorage. */
export function clearDraft(threadId: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(key(threadId));
  } catch {
    // best-effort
  }
}

/**
 * Load ALL persisted drafts (for boot rehydration). Iterates localStorage keys
 * with the draft prefix; returns a map keyed by threadId. Malformed / versioned /
 * empty entries are pruned so they don't linger. No-op without localStorage.
 */
export function loadAllDrafts(): Record<string, ParsedCopilotDraft> {
  if (typeof localStorage === "undefined") return {};
  const out: Record<string, ParsedCopilotDraft> = {};
  // Snapshot the draft keys first: removing items during a forward index loop
  // shifts subsequent keys down, so i++ would skip the shifted entry. Collect,
  // then process.
  const draftKeys: string[] = [];
  try {
    const len = localStorage.length;
    for (let i = 0; i < len; i++) {
      const k = localStorage.key(i);
      if (k != null && k.startsWith(DRAFT_PREFIX)) draftKeys.push(k);
    }
  } catch {
    // best-effort — return whatever was collected
  }
  for (const k of draftKeys) {
    const threadId = k.slice(DRAFT_PREFIX.length);
    let raw: string | null;
    try {
      raw = localStorage.getItem(k);
    } catch {
      continue;
    }
    const acts = parseDraft(raw);
    if (acts && (acts.activities.length > 0 || acts.round !== null)) {
      out[threadId] = acts;
    } else {
      // prune empty/invalid entry in-place
      try {
        localStorage.removeItem(k);
      } catch {
        // best-effort
      }
    }
  }
  return out;
}

/**
 * The WRITE side of the persistence contract (envelope v2): read both stores'
 * current state for the thread and save/clear the localStorage key. Called by
 * the copilot shell from an effect on every round/activity mutation — the
 * single funnel that keeps the key in sync without wiring localStorage into
 * the stores themselves. Idempotent; no-op without localStorage.
 */
export function syncPersistedCopilotRound(threadId: string): void {
  const activities = useExperienceCopilotTurnStore.getState().turnsByThread[threadId] ?? [];
  const round = useCopilotReviewRoundStore.getState().roundsByThread[threadId] ?? null;
  saveDraft(threadId, activities, round);
}

/**
 * Boot rehydration: seed the turn store (activities) AND the review-round
 * store (round) with any persisted drafts from a previous session. Merges into
 * the existing dicts (additive; on a fresh page load both stores are empty).
 * Safe to call multiple times. No-op without localStorage. Called from the
 * copilot shell's mount effect.
 */
export function rehydrateExperienceCopilotDrafts(): void {
  const drafts = loadAllDrafts();
  if (Object.keys(drafts).length === 0) return;
  useExperienceCopilotTurnStore.setState((s) => ({
    turnsByThread: {
      ...s.turnsByThread,
      ...Object.fromEntries(Object.entries(drafts).map(([tid, d]) => [tid, d.activities])),
    },
  }));
  const rounds = Object.fromEntries(
    Object
      .entries(drafts)
      .flatMap(([tid, d]) => (d.round !== null ? [[tid, d.round] as const] : [])),
  );
  if (Object.keys(rounds).length === 0) return;
  useCopilotReviewRoundStore.setState((s) => ({ roundsByThread: { ...s.roundsByThread, ...rounds } }));
}
