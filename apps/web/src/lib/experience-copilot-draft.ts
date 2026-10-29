/**
 * ER-10a — cross-session persistence of unapplied experience-copilot proposals
 * (the "draft" that survives a page reload).
 *
 * The experience-copilot turn store (`agent-turn-store.ts`) is
 * deliberately ephemeral: it holds a turn's tool activities in memory with no
 * `persist` middleware. Rebuilding a diff after reload also requires its old
 * base and hunk progress, not just message history. We persist the finalized
 * proposal-producing activities and their complete round (the
 * subset `aggregateExperienceCopilotProposal` derives from) through the review
 * API, keyed by threadId. localStorage is read only for one-time migration.
 *
 * ENVELOPE V2 — THE WHOLE ROUND. A review is more than its activities: the
 * turn-start snapshot (the diff "before" side), the per-buffer accepted /
 * dismissed hunk ids and the CD-8 dangling capture all live in the review-round
 * store (`agent-review-store.ts`) and are needed to rebuild the
 * SAME review after a reload — without the round the rehydrated activities
 * would have `base === undefined` and render nothing. V2 therefore persists
 * `{ activities, round }` together; a V1 envelope (activities only) still
 * loads, degraded (no review anchor).
 *
 * WRITE SIDE. `syncPersistedCopilotRound(threadId)` is the single entry point
 * the copilot shell calls from an effect on every round/activity mutation: it
 * reads both stores and either saves or DELETES the server review. It survives while
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
 * after a schema change) discards the legacy entry rather than seeding incompatible
 * data — the user simply sees no draft, same as before ER-10. Malformed JSON
 * is likewise discarded (best-effort: persistence is a convenience, never a
 * correctness constraint — the canonical buffers are the script/visual draft
 * stores' source of truth).
 */
import type { AgentToolActivity } from "../stores/agent-turn-store.js";
import { useAgentTurnStore } from "../stores/agent-turn-store.js";
import type { AgentReviewRound } from "../stores/agent-review-store.js";
import { useAgentReviewRoundStore } from "../stores/agent-review-store.js";
import { agentThreadKey } from "./agent-host-registry.js";
import type { AgentReviewEnvelope } from "@vibe-tavern/api-contracts";
import { isFinalizedReviewActivity as isFinalizedActivity, finalizeReviewActivities as finalizeForPersistence } from "@vibe-tavern/api-contracts";
import { aggregateExperienceCopilotProposal, captureAgentReviewProposal } from "@vibe-tavern/api-contracts";
import { AgentReviewPersistence } from "./agent-review-persistence.js";
import {
  getExperienceCopilotReview, putExperienceCopilotReview, deleteExperienceCopilotReview, isExperienceCopilotRunning,
  streamExperienceCopilot, answerCopilotAsk,
} from "../api/experience-copilot-api.js";
export { isFinalizedActivity, finalizeForPersistence };

/** The draft envelope is experience-scoped (the `vt:experience-copilot-draft:`
 *  prefix, the store slices below) — its store-map keys go through the shared
 *  helper with the experience kind, retaining the legacy bare threadId. */
const DRAFT_KIND = "experience";

const DRAFT_PREFIX = "vt:experience-copilot-draft:";
const DRAFT_VERSION = 2;

/** The legacy reader also examines V1/unknown versions before narrowing. */
type DraftEnvelope = Omit<AgentReviewEnvelope, "_v"> & { _v: number };

/** What a parsed envelope yields: the finalized activities plus (V2 only) the
 *  review round. `round` is null for V1 envelopes and for a malformed round —
 *  the activities still load, degraded. */
export type ParsedCopilotDraft = Pick<AgentReviewEnvelope, "activities" | "round">;

/**
 * The shared finalized guard preserves the legacy reader's permissive filter.
 */

/** Type guard for the V2 review-round payload. Mirrors the round store's
 *  `AgentReviewRound` shape field by field — a value that fails any clause
 *  degrades to `round: null` while the activities still load. */
export function isReviewRound(x: unknown): x is AgentReviewRound {
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
// The shared finalizer above retains first-call order with later values winning.

/**
 * Serialize a thread's activities + review round to the versioned persistence
 * envelope. Returns `null` when nothing reviewable remains (no finalized
 * proposal AND no dangling capture — snapshots alone rehydrate nothing without
 * a proposal source, so a resolved/reverted round clears the key). Pure: no I/O.
 */
export function serializeDraft(
  activities: AgentToolActivity[],
  round: AgentReviewRound | null,
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
 * Legacy envelope writer retained for migration fixtures / older callers.
 * The running host writes ONLY through syncPersistedCopilotRound below.
 * Best-effort: any localStorage failure (quota / disabled / absent) is
 * swallowed — the in-memory proposal still works for the current session.
 * No-op without localStorage.
 */
export function saveDraft(
  threadId: string,
  activities: AgentToolActivity[],
  round: AgentReviewRound | null,
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
 * Project both live stores into the durable envelope, excluding transient
 * placeholders and retaining dangling-only rounds. Never write draft buffers.
 */
function readCurrentReview(threadId: string): AgentReviewEnvelope | null {
  const key = agentThreadKey(DRAFT_KIND, threadId);
  const activities = useAgentTurnStore.getState().turnsByThread[key] ?? [];
  const round = useAgentReviewRoundStore.getState().roundsByThread[key] ?? null;
  const json = serializeDraft(activities, round);
  return json === null ? null : JSON.parse(json) as AgentReviewEnvelope;
}

const reviewPersistence = new AgentReviewPersistence({
  api: { get: getExperienceCopilotReview, put: putExperienceCopilotReview, delete: deleteExperienceCopilotReview, isRunning: isExperienceCopilotRunning },
  read: readCurrentReview,
  apply: (threadId, envelope) => {
    const key = agentThreadKey(DRAFT_KIND, threadId);
    useAgentTurnStore.setState((s) => ({ turnsByThread: { ...s.turnsByThread, [key]: envelope?.activities ?? [] } }));
    if (envelope?.round) {
      useAgentReviewRoundStore.setState((s) => ({ roundsByThread: { ...s.roundsByThread, [key]: envelope.round! } }));
    } else useAgentReviewRoundStore.getState().resetRound(DRAFT_KIND, threadId);
  },
  readLegacy: (threadId) => {
    const parsed = loadDraft(threadId);
    return parsed === null ? null : { _v: 2, ...parsed };
  },
  removeLegacy: clearDraft,
});

/** Per-thread server hydration; never boot-scan legacy keys into live stores. */
export function rehydrateExperienceCopilotDrafts(threadId: string): Promise<void> {
  return reviewPersistence.hydrate(threadId);
}

/** Ordered, run-aware write funnel. An unhydrated or server-owned review
 * cannot be overwritten by the editor's initial empty/transient render. */
export function syncPersistedCopilotRound(threadId: string): Promise<void> {
  return reviewPersistence.sync(threadId);
}

const preparedBuffers = new Map<string, { rules: string; visual: string }>();

/** The shared controller awaits this before destructive turn-start changes. */
export async function prepareExperienceCopilotReviewTurn(threadId: string, signal: AbortSignal, buffers: { rules: string; visual: string }): Promise<void> {
  await reviewPersistence.ensureHydrated(threadId);
  signal.throwIfAborted();
  const key = agentThreadKey(DRAFT_KIND, threadId);
  const activities = useAgentTurnStore.getState().turnsByThread[key] ?? [];
  const round = useAgentReviewRoundStore.getState().roundsByThread[key];
  const capture = captureAgentReviewProposal(aggregateExperienceCopilotProposal(activities), round?.snapshots.at(-1) ?? null, buffers);
  if (capture) useAgentReviewRoundStore.getState().captureDangling(DRAFT_KIND, threadId, capture);
  await reviewPersistence.prepare(threadId, signal);
  signal.throwIfAborted();
  preparedBuffers.set(threadId, buffers);
  signal.addEventListener("abort", () => { preparedBuffers.delete(threadId); }, { once: true });
}

async function runPersistedTurn<T>(threadId: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  const buffers = preparedBuffers.get(threadId);
  if (!buffers) throw new Error("Agent review turn was not prepared");
  preparedBuffers.delete(threadId);
  // Explicit after the flush and clearTurn, before network I/O: a very short
  // stream cannot batch the checkpoint away, and the server sees no duplicate.
  useAgentReviewRoundStore.getState().pushSnapshot(DRAFT_KIND, threadId, buffers);
  reviewPersistence.start(threadId);
  let watched = false;
  try {
    const result = await run();
    watched = !signal?.aborted;
    return result;
  } finally {
    await reviewPersistence.finish(threadId, watched).catch((error: unknown) => {
      // Preserve the stream's original success/error. The next load/sync retries
      // reconciliation; never pretend a failed server read means no review.
      console.warn("[agent-review] settlement persistence failed", error);
    });
  }
}

export const streamPersistedExperienceCopilot: typeof streamExperienceCopilot = (threadId, body, opts) =>
  runPersistedTurn(threadId, opts.signal, () => streamExperienceCopilot(threadId, body, opts));
export const answerPersistedCopilotAsk: typeof answerCopilotAsk = (threadId, body, opts) =>
  runPersistedTurn(threadId, opts.signal, () => answerCopilotAsk(threadId, body, opts));
