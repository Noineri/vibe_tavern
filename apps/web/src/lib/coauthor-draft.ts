/**
 * CA-15 — cross-session persistence of unapplied co-author proposals (the
 * "draft" that survives a page reload).
 *
 * The co-author turn store (`coauthor-turn-store.ts`) is deliberately ephemeral:
 * it holds a turn's tool activities in memory with no `persist` middleware,
 * because the backend does not persist tool calls onto the message record. The
 * consequence was that a page reload wiped any in-review proposal, so the user
 * lost the diff + Apply affordance and had to re-run the turn. CA-15 persists
 * just the FINALIZED proposed-producing activities (the subset `hasProposal`
 * derives from) to localStorage, keyed by chatId, and rehydrates them on boot.
 *
 * WHY ONLY THE FINALIZED SUBSET. Streaming placeholders and errors are
 * transient and carry no reviewable content. Persisting them would rehydrate a
 * dead "AI is editing…" state pointing at a stream that no longer exists. The
 * persisted set is exactly what `aggregateCoauthorProposal` consumes, so
 * rehydration reconstructs the same diff + Apply request with ZERO new UI —
 * Apply/Reject (which already clear the turn store) also clear the persisted
 * draft via the `clearTurn` → `clearDraft` hook.
 *
 * WHAT DOESN'T CLEAR IT. `clearTurn` is called only at turn-start, on Apply,
 * and on Reject — NOT on chat switch (verified in code; the store doc comment
 * is aspirational). So the turn store's per-chat dict already keeps a proposal
 * alive across chat switches in-memory; CA-15 additionally keeps it alive
 * across reloads. The two compose without conflict.
 *
 * VERSIONING. The envelope carries `_v`. A version mismatch on load (e.g.
 * after a schema change) discards the entry rather than seeding incompatible
 * data — the user simply sees no draft, same as before CA-15. Malformed JSON
 * is likewise discarded (best-effort: persistence is a convenience, never a
 * correctness constraint — the canonical card is the backend's source of truth).
 *
 * REHYDRATION CORRECTNESS. The reviewing diff is `canonical → proposed`, where
 * `canonical` is read LIVE from the freshly-loaded snapshot character. If the
 * card changed between the proposal and the reload, the diff base shifts —
 * which is the honest behavior (review the proposal against the current card).
 * Apply sends the full proposed document regardless, so it is self-contained.
 */
import type { CoauthorToolActivity } from "../stores/coauthor-turn-store.js";
import { useCoauthorTurnStore } from "../stores/coauthor-turn-store.js";

const DRAFT_PREFIX = "vt:coauthor-draft:";
const DRAFT_VERSION = 1;

/** localStorage envelope — versioned so a future schema change can migrate/discard. */
interface DraftEnvelope {
  _v: number;
  activities: unknown[];
}

/**
 * Type guard for a finalized, proposed-producing activity. Mirrors the filter
 * in `coauthor-apply-aggregate.ts` (`finalizedActivities`) so the persisted
 * subset is exactly what the aggregator consumes. Defensive: a value that
 * fails any clause is dropped on load (corruption / version-skew defense).
 */
export function isFinalizedActivity(x: unknown): x is CoauthorToolActivity {
  if (typeof x !== "object" || x === null) return false;
  const a = x as Record<string, unknown>;
  return (
    a.status === "done" &&
    (a.target === "profile" || a.target === "greeting") &&
    typeof a.proposed === "string" &&
    a.proposed.length > 0 &&
    typeof a.toolCallId === "string" &&
    typeof a.toolName === "string"
  );
}

/**
 * Reduce a chat's activities to the persistable finalized-proposed subset,
 * deduped by `toolCallId` (later wins) in insertion order — mirroring the
 * store's own upsert-merge semantics. Pure: no I/O.
 */
export function finalizeForPersistence(activities: CoauthorToolActivity[]): CoauthorToolActivity[] {
  // Map (not Set) so a later duplicate toolCallId OVERWRITES the value while
  // preserving the first occurrence's POSITION — mirroring both the store's
  // upsert-merge (later fields win) and `aggregateCoauthorProposal`'s
  // finalizedActivities dedup. Map iteration is insertion order.
  const byId = new Map<string, CoauthorToolActivity>();
  for (const a of activities) {
    if (!isFinalizedActivity(a)) continue;
    byId.set(a.toolCallId, a);
  }
  return [...byId.values()];
}

/**
 * Serialize a chat's activities to the versioned persistence envelope. Returns
 * `null` when there is nothing to persist (no finalized proposal) — the caller
 * treats null as "clear the key". Pure: no I/O.
 */
export function serializeDraft(activities: CoauthorToolActivity[]): string | null {
  const finalized = finalizeForPersistence(activities);
  if (finalized.length === 0) return null;
  const envelope: DraftEnvelope = { _v: DRAFT_VERSION, activities: finalized };
  return JSON.stringify(envelope);
}

/**
 * Parse + validate a persisted envelope. Returns the finalized activities, or
 * `null` if absent / malformed / version-skewed / empty-after-filter. Pure: no I/O.
 */
export function parseDraft(raw: string | null): CoauthorToolActivity[] | null {
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

function key(chatId: string): string {
  return DRAFT_PREFIX + chatId;
}

/**
 * Persist a chat's activities (filtered to the finalized subset). If none
 * qualify, the key is removed instead. Best-effort: any localStorage failure
 * (quota / disabled / absent) is swallowed — the in-memory proposal still
 * works for the current session. No-op without localStorage.
 */
export function saveDraft(chatId: string, activities: CoauthorToolActivity[]): void {
  if (typeof localStorage === "undefined") return;
  const json = serializeDraft(activities);
  try {
    if (json === null) {
      localStorage.removeItem(key(chatId));
    } else {
      localStorage.setItem(key(chatId), json);
    }
  } catch {
    // best-effort
  }
}

/** Load + validate a chat's persisted draft. `null` if absent/malformed. No-op without localStorage. */
export function loadDraft(chatId: string): CoauthorToolActivity[] | null {
  if (typeof localStorage === "undefined") return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(key(chatId));
  } catch {
    return null;
  }
  return parseDraft(raw);
}

/** Remove a chat's persisted draft (Apply / Reject / turn-start). No-op without localStorage. */
export function clearDraft(chatId: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(key(chatId));
  } catch {
    // best-effort
  }
}

/**
 * Load ALL persisted drafts (for boot rehydration). Iterates localStorage keys
 * with the draft prefix; returns a map keyed by chatId. Malformed / versioned /
 * empty entries are pruned so they don't linger. No-op without localStorage.
 */
export function loadAllDrafts(): Record<string, CoauthorToolActivity[]> {
  if (typeof localStorage === "undefined") return {};
  const out: Record<string, CoauthorToolActivity[]> = {};
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
    const chatId = k.slice(DRAFT_PREFIX.length);
    let raw: string | null;
    try {
      raw = localStorage.getItem(k);
    } catch {
      continue;
    }
    const acts = parseDraft(raw);
    if (acts && acts.length > 0) {
      out[chatId] = acts;
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
 * localStorage. Called once from app bootstrap (`app.tsx`).
 */
export function rehydrateCoauthorDrafts(): void {
  const drafts = loadAllDrafts();
  if (Object.keys(drafts).length === 0) return;
  useCoauthorTurnStore.setState((s) => ({ turnsByChat: { ...s.turnsByChat, ...drafts } }));
}
