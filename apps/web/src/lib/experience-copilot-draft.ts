/**
 * ER-10a — cross-session persistence of unapplied experience-copilot proposals
 * (the "draft" that survives a page reload).
 *
 * The experience-copilot turn store (`experience-copilot-turn-store.ts`) is
 * deliberately ephemeral: it holds a turn's tool activities in memory with no
 * `persist` middleware, because the backend does not persist tool calls onto
 * the message record. The consequence is that a page reload wipes any in-review
 * proposal, so the user loses the diff + Apply affordance and has to re-run the
 * turn. ER-10 persists just the FINALIZED proposed-producing activities (the
 * subset `aggregateExperienceCopilotProposal` derives from) to localStorage,
 * keyed by threadId, and rehydrates them on boot.
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
 * so rehydration reconstructs the same two-buffer diff + Apply request with ZERO
 * new UI — Apply/Reject (which already clear the turn store via `clearTurn`)
 * also clear the persisted draft via the `clearTurn` → `clearDraft` hook wired
 * in Wave 4.
 *
 * VERSIONING. The envelope carries `_v`. A version mismatch on load (e.g.
 * after a schema change) discards the entry rather than seeding incompatible
 * data — the user simply sees no draft, same as before ER-10. Malformed JSON
 * is likewise discarded (best-effort: persistence is a convenience, never a
 * correctness constraint — the canonical buffers are the script/visual draft
 * stores' source of truth).
 *
 * REHYDRATION CORRECTNESS. The reviewing diff is `canonical → proposed`, where
 * `canonical` is read LIVE from the freshly-loaded script/visual buffers. If the
 * buffer changed between the proposal and the reload, the diff base shifts —
 * which is the honest behavior (review the proposal against the current
 * buffer). Apply sends the full proposed buffer text regardless, so it is
 * self-contained.
 */
import type { ExperienceCopilotToolActivity } from "../stores/experience-copilot-turn-store.js";
import { useExperienceCopilotTurnStore } from "../stores/experience-copilot-turn-store.js";

const DRAFT_PREFIX = "vt:experience-copilot-draft:";
const DRAFT_VERSION = 1;

/** localStorage envelope — versioned so a future schema change can migrate/discard. */
interface DraftEnvelope {
  _v: number;
  activities: unknown[];
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
 * Serialize a thread's activities to the versioned persistence envelope. Returns
 * `null` when there is nothing to persist (no finalized proposal) — the caller
 * treats null as "clear the key". Pure: no I/O.
 */
export function serializeDraft(activities: ExperienceCopilotToolActivity[]): string | null {
  const finalized = finalizeForPersistence(activities);
  if (finalized.length === 0) return null;
  const envelope: DraftEnvelope = { _v: DRAFT_VERSION, activities: finalized };
  return JSON.stringify(envelope);
}

/**
 * Parse + validate a persisted envelope. Returns the finalized activities, or
 * `null` if absent / malformed / version-skewed / empty-after-filter. Pure: no I/O.
 */
export function parseDraft(raw: string | null): ExperienceCopilotToolActivity[] | null {
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // corrupted JSON — discard
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const env = parsed as DraftEnvelope;
  if (env._v !== DRAFT_VERSION) return null; // version skew — discard
  if (!Array.isArray(env.activities)) return null;
  const finalized = env.activities.filter(isFinalizedActivity);
  return finalized.length > 0 ? finalized : null;
}

function key(threadId: string): string {
  return DRAFT_PREFIX + threadId;
}

/**
 * Persist a thread's activities (filtered to the finalized subset). If none
 * qualify, the key is removed instead. Best-effort: any localStorage failure
 * (quota / disabled / absent) is swallowed — the in-memory proposal still
 * works for the current session. No-op without localStorage.
 */
export function saveDraft(threadId: string, activities: ExperienceCopilotToolActivity[]): void {
  if (typeof localStorage === "undefined") return;
  const json = serializeDraft(activities);
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

/** Load + validate a thread's persisted draft. `null` if absent/malformed. No-op without localStorage. */
export function loadDraft(threadId: string): ExperienceCopilotToolActivity[] | null {
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
export function loadAllDrafts(): Record<string, ExperienceCopilotToolActivity[]> {
  if (typeof localStorage === "undefined") return {};
  const out: Record<string, ExperienceCopilotToolActivity[]> = {};
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
    if (acts && acts.length > 0) {
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
 * Boot rehydration: seed the turn store with any persisted drafts from a
 * previous session. Merges into the existing dict (additive; on a fresh page
 * load the store is empty). Safe to call multiple times. No-op without
 * localStorage. Called once from app bootstrap in Wave 4.
 */
export function rehydrateExperienceCopilotDrafts(): void {
  const drafts = loadAllDrafts();
  if (Object.keys(drafts).length === 0) return;
  useExperienceCopilotTurnStore.setState((s) => ({ turnsByThread: { ...s.turnsByThread, ...drafts } }));
}
