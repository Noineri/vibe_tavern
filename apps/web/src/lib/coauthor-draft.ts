/** Server-owned Co-Author reviews (BR-4d). LocalStorage is a one-time CA-15
 * migration source only; live/replayed tool activities are never browser PUTs.
 * The diff continues to compare the restored proposal against the current card. */
import { buildCoauthorReviewEnvelope, coauthorReviewActivitySchema, type CoauthorReviewActivity, type CoauthorReviewEnvelope } from "@vibe-tavern/api-contracts";
import type { CoauthorToolActivity } from "../stores/coauthor-turn-store.js";
import { useCoauthorTurnStore } from "../stores/coauthor-turn-store.js";
import { getCoauthorReview, putCoauthorReview, deleteCoauthorReview } from "../api/coauthor-review-api.js";
import { isChatGenerationRunning } from "../api/chat-generation-api.js";
import { clearCoauthorRemoteReview } from "./coauthor-editor-snapshot.js";

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
export function isFinalizedActivity(x: unknown): x is CoauthorReviewActivity {
  return coauthorReviewActivitySchema.safeParse(x).success;
}

/**
 * Reduce a chat's activities to the persistable finalized-proposed subset,
 * deduped by `toolCallId` (later wins) in insertion order — mirroring the
 * store's own upsert-merge semantics. Pure: no I/O.
 */
export function finalizeForPersistence(activities: CoauthorToolActivity[]): CoauthorToolActivity[] {
  return buildCoauthorReviewEnvelope(activities)?.activities ?? [];
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
 * Legacy CA-15 writer, retained for migration fixtures; new turns never call it.
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

/** Remove a migrated/resolved legacy key. Turn-start never calls this. */
export function clearDraft(chatId: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(key(chatId));
  } catch {
    // best-effort
  }
}

/**
 * Inspect ALL legacy drafts (migration characterization). Iterates localStorage keys
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

/** Injectable boundaries; production uses the typed API and per-chat store. */
export interface CoauthorReviewPersistenceDeps {
  get: (id: string) => Promise<CoauthorReviewEnvelope | null>;
  put: (id: string, envelope: CoauthorReviewEnvelope) => Promise<CoauthorReviewEnvelope>;
  delete: (id: string) => Promise<void>;
  isRunning: (id: string) => Promise<boolean>;
  read: (id: string) => CoauthorToolActivity[] | undefined;
  apply: (id: string, envelope: CoauthorReviewEnvelope | null) => void;
  readLegacy: (id: string) => CoauthorToolActivity[] | null;
  removeLegacy: (id: string) => void;
}

/** Ordered per-chat consumer lane. Only legacy migration writes a proposal;
 * ordinary turns always recover the producer's final review, including no-op
 * turns that must retain an older proposal. No cross-client CAS is claimed. */
export class CoauthorReviewPersistence {
  private readonly tails = new Map<string, Promise<unknown>>();
  constructor(private readonly deps: CoauthorReviewPersistenceDeps) {}

  private enqueue<T>(id: string, work: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(id) ?? Promise.resolve()).then(work);
    const tail = result.catch(() => undefined);
    this.tails.set(id, tail);
    void tail.then(() => { if (this.tails.get(id) === tail) this.tails.delete(id); });
    return result;
  }

  hydrate(id: string, isCurrent = () => true): Promise<void> {
    return this.enqueue(id, async () => {
      if (!isCurrent()) return;
      const before = this.deps.read(id);
      if (await this.deps.isRunning(id)) return;
      let envelope = await this.deps.get(id);
      if (!isCurrent() || this.deps.read(id) !== before) return;
      const legacy = this.deps.readLegacy(id);
      if (envelope === null && legacy !== null) {
        // Recheck before the sole browser upload. A running producer owns the
        // review; failure leaves the key intact so the next visit can retry.
        if (await this.deps.isRunning(id) || !isCurrent() || this.deps.read(id) !== before) return;
        const migration = buildCoauthorReviewEnvelope(legacy);
        if (migration) envelope = await this.deps.put(id, migration);
      }
      this.deps.removeLegacy(id);
      if (isCurrent() && this.deps.read(id) === before) this.deps.apply(id, envelope);
    });
  }

  /** Resolve the exact offered proposal, not whatever a later turn produced.
   * GET/DELETE is best-effort predecessor protection, not cross-client CAS. */
  resolve(id: string, origin: readonly CoauthorToolActivity[]): Promise<void> {
    return this.enqueue(id, async () => {
      const before = this.deps.read(id);
      if (await this.deps.isRunning(id)) throw new Error("Co-Author generation still owns this review");
      const remote = await this.deps.get(id);
      if (remote !== null && JSON.stringify(remote) !== JSON.stringify(buildCoauthorReviewEnvelope(origin))) {
        if (this.deps.read(id) === before) this.deps.apply(id, remote);
        return;
      }
      if (await this.deps.isRunning(id)) throw new Error("Co-Author generation still owns this review");
      if (this.deps.read(id) !== before) return;
      await this.deps.delete(id);
      this.deps.removeLegacy(id);
    });
  }
}

export const coauthorReviews = new CoauthorReviewPersistence({
  get: getCoauthorReview, put: putCoauthorReview, delete: deleteCoauthorReview,
  isRunning: isChatGenerationRunning,
  read: (id) => useCoauthorTurnStore.getState().turnsByChat[id],
  apply: (id, envelope) => {
    if (envelope === null) clearCoauthorRemoteReview(id);
    useCoauthorTurnStore.setState((s) => {
    const current = s.turnsByChat[id] ?? [];
    if (envelope !== null && JSON.stringify(buildCoauthorReviewEnvelope(current)) === JSON.stringify(envelope)) return s;
    // Keep the current turn's read/error cards; only reviewable proposals are
    // replaced by the server round. Equal proposals keep their UI identity.
    const reviewIds = new Set(envelope?.activities.map((a) => a.toolCallId));
    return { turnsByChat: { ...s.turnsByChat, [id]: [...current.filter((a) => !isFinalizedActivity(a) && !reviewIds.has(a.toolCallId)), ...(envelope?.activities ?? [])] } };
    });
  },
  readLegacy: loadDraft, removeLegacy: clearDraft,
});
