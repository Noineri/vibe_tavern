import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/react/shallow";
import type {
  DiceDefinitionsResponse,
  DiceLaneState,
  DicePendingState,
  DiceRollRequest,
  DiceRollSnapshot,
} from "../api/types.js";
import {
  chooseDiceAttempt,
  clearDiceLane,
  getDiceDefinitions,
  getDicePending,
  removeDiceRoll,
  rollDice,
  setDiceRollIncluded,
} from "../api/dice-api.js";

/**
 * Dice pending store (DICE_SYSTEM_FRONTEND_PLAN, Wave F1 / DICE-F2_dice_store).
 *
 * A server-authoritative mirror of the per-`{chatId, branchId}` Dice pending
 * lanes plus the enabled-script definitions. The store NEVER fabricates dice
 * faces/totals and NEVER caches bound message-owned results (`boundMessageId
 * != null`) — pending only. Every mutation ends in a server `refreshPending`
 * (server state wins); `setIncluded`/`chooseAttempt` (and the Normal
 * remove/clear) additionally flip optimistically for instant UI feedback and
 * roll back to the pre-mutation snapshot on failure before resyncing.
 *
 * Idempotency: `roll` mints one `crypto.randomUUID()` `requestId` per
 * in-flight roll intent and REUSES it while that intent is still in flight, so
 * a rapid double-click (or a retry of the same in-flight request) hits the
 * server's DB-unique `requestId` constraint and cannot duplicate the roll. The
 * key is cleared on completion, so a deliberate later re-roll mints a fresh
 * `requestId` (a real new roll that replaces the Normal pending result).
 */

/** Roll-intent input (no requestId — the store owns idempotency keys). */
export type DiceRollIntent = Omit<DiceRollRequest, "requestId">;

export interface DiceScopeState {
  /** Enabled Dice scripts + resolvable checks for the chat (null = not loaded). */
  definitions: DiceDefinitionsResponse | null;
  /** Both pending lanes (null = not loaded). Bound rolls are filtered out. */
  lanes: { normal: DiceLaneState; immersive: DiceLaneState } | null;
  /** In-flight roll intents: intentKey → requestId (cleared on completion). */
  rollingRequestIds: Record<string, string>;
  lastError: string | null;
}

interface DiceState {
  byScope: Record<string, DiceScopeState>;
  /** The scope the composer is currently showing — the refocus rehydration target. */
  activeScope: { chatId: string; branchId: string } | null;
}

export interface DiceActions {
  /** Record the active scope and rehydrate it (scope-change rehydration). */
  setScope: (chatId: string, branchId: string) => void;
  /** Reload definitions + pending for a scope (refocus / post-mutation resync). */
  rehydrate: (chatId: string, branchId: string) => Promise<void>;
  loadDefinitions: (chatId: string, branchId: string) => Promise<void>;
  refreshPending: (chatId: string, branchId: string) => Promise<void>;
  /** Execute a server-authoritative roll. Returns the requestId used. */
  roll: (chatId: string, branchId: string, intent: DiceRollIntent) => Promise<string>;
  removeRoll: (chatId: string, branchId: string, rollId: string) => Promise<void>;
  clearLane: (chatId: string, branchId: string) => Promise<void>;
  setIncluded: (chatId: string, branchId: string, rollId: string, included: boolean) => Promise<void>;
  chooseAttempt: (chatId: string, branchId: string, rollId: string, attemptId: string) => Promise<void>;
}

const EMPTY_LANES: DiceScopeState["lanes"] = null;

function emptyScope(): DiceScopeState {
  return { definitions: null, lanes: null, rollingRequestIds: {}, lastError: null };
}

function scopeKey(chatId: string, branchId: string): string {
  return `${chatId}|${branchId}`;
}

function intentKey(intent: DiceRollIntent): string {
  return `${intent.checkId}:${intent.actorId}`;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function scopeDraft(s: DiceState, key: string): DiceScopeState {
  return s.byScope[key] ?? (s.byScope[key] = emptyScope());
}

/** Apply `fn` to the roll with `rollId` in whichever lane holds it (no-op if absent). */
function mutateRoll(s: DiceState, key: string, rollId: string, fn: (roll: DiceRollSnapshot) => void): void {
  const scope = s.byScope[key];
  if (!scope?.lanes) return;
  for (const lane of [scope.lanes.normal, scope.lanes.immersive]) {
    const roll = lane.rolls.find((r) => r.rollId === rollId);
    if (roll) {
      fn(roll);
      return;
    }
  }
}

/** Project a server pending response into store lanes, dropping bound rolls. */
function toLanes(pending: DicePendingState): { normal: DiceLaneState; immersive: DiceLaneState } {
  const unbound = (rolls: DiceRollSnapshot[]) => rolls.filter((r) => r.boundMessageId == null);
  return {
    normal: { revision: pending.normal.revision, rolls: unbound(pending.normal.rolls) },
    immersive: { revision: pending.immersive.revision, rolls: unbound(pending.immersive.rolls) },
  };
}

// Lazily registered (once) document listener: rehydrate the active scope when
// the tab regains visibility. Guarded so SSR/tests without a document skip it.
let visibilityListenerRegistered = false;
function ensureVisibilityListener(): void {
  if (visibilityListenerRegistered || typeof document === "undefined") return;
  visibilityListenerRegistered = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const scope = useDiceStore.getState().activeScope;
    if (!scope) return;
    void useDiceStore.getState().rehydrate(scope.chatId, scope.branchId);
  });
}

export const useDiceStore = create<DiceState & DiceActions>()(
  immer((set, get) => ({
    byScope: {},
    activeScope: null,

    setScope: (chatId, branchId) => {
      set((s) => {
        s.activeScope = { chatId, branchId };
      });
      ensureVisibilityListener();
      void get().rehydrate(chatId, branchId);
    },

    rehydrate: async (chatId, branchId) => {
      await Promise.all([get().loadDefinitions(chatId, branchId), get().refreshPending(chatId, branchId)]);
    },

    loadDefinitions: async (chatId, branchId) => {
      const key = scopeKey(chatId, branchId);
      try {
        const definitions = await getDiceDefinitions(chatId);
        set((s) => {
          scopeDraft(s, key).definitions = definitions;
        });
      } catch (err) {
        set((s) => {
          scopeDraft(s, key).lastError = toMessage(err);
        });
      }
    },

    refreshPending: async (chatId, branchId) => {
      const key = scopeKey(chatId, branchId);
      try {
        const pending = await getDicePending(chatId, branchId);
        set((s) => {
          scopeDraft(s, key).lanes = toLanes(pending);
        });
      } catch (err) {
        set((s) => {
          scopeDraft(s, key).lastError = toMessage(err);
        });
      }
    },

    roll: async (chatId, branchId, intent) => {
      const key = scopeKey(chatId, branchId);
      const iKey = intentKey(intent);
      // Reuse the in-flight requestId for this intent (idempotent retry / rapid
      // click), else mint a fresh one for a genuinely new roll.
      const requestId = get().byScope[key]?.rollingRequestIds[iKey] ?? crypto.randomUUID();
      set((s) => {
        const scope = scopeDraft(s, key);
        scope.rollingRequestIds[iKey] = requestId;
        scope.lastError = null;
      });
      try {
        await rollDice(chatId, { ...intent, requestId });
        await get().refreshPending(chatId, branchId);
      } catch (err) {
        // Resync (stale-revision / no-grant recovery), then surface the error.
        await get().refreshPending(chatId, branchId);
        set((s) => {
          scopeDraft(s, key).lastError = toMessage(err);
        });
      } finally {
        set((s) => {
          delete scopeDraft(s, key).rollingRequestIds[iKey];
        });
      }
      return requestId;
    },

    removeRoll: async (chatId, branchId, rollId) => {
      const key = scopeKey(chatId, branchId);
      const prior = get().byScope[key]?.lanes ?? EMPTY_LANES;
      if (prior) {
        set((s) => {
          const scope = scopeDraft(s, key);
          if (!scope.lanes) return;
          scope.lanes.normal.rolls = scope.lanes.normal.rolls.filter((r) => r.rollId !== rollId);
          scope.lanes.immersive.rolls = scope.lanes.immersive.rolls.filter((r) => r.rollId !== rollId);
        });
      }
      try {
        await removeDiceRoll(chatId, rollId);
        await get().refreshPending(chatId, branchId);
        set((s) => {
          scopeDraft(s, key).lastError = null;
        });
      } catch (err) {
        set((s) => {
          scopeDraft(s, key).lanes = prior;
        });
        await get().refreshPending(chatId, branchId);
        set((s) => {
          scopeDraft(s, key).lastError = toMessage(err);
        });
      }
    },

    clearLane: async (chatId, branchId) => {
      const key = scopeKey(chatId, branchId);
      const prior = get().byScope[key]?.lanes ?? EMPTY_LANES;
      if (prior) {
        set((s) => {
          const scope = scopeDraft(s, key);
          if (scope.lanes) scope.lanes.normal = { ...scope.lanes.normal, rolls: [] };
        });
      }
      try {
        await clearDiceLane(chatId, branchId);
        await get().refreshPending(chatId, branchId);
        set((s) => {
          scopeDraft(s, key).lastError = null;
        });
      } catch (err) {
        set((s) => {
          scopeDraft(s, key).lanes = prior;
        });
        await get().refreshPending(chatId, branchId);
        set((s) => {
          scopeDraft(s, key).lastError = toMessage(err);
        });
      }
    },

    setIncluded: async (chatId, branchId, rollId, included) => {
      const key = scopeKey(chatId, branchId);
      const prior = get().byScope[key]?.lanes ?? EMPTY_LANES;
      if (prior) {
        set((s) => {
          mutateRoll(s, key, rollId, (roll) => {
            roll.included = included;
          });
        });
      }
      try {
        await setDiceRollIncluded(chatId, rollId, included);
        await get().refreshPending(chatId, branchId);
        set((s) => {
          scopeDraft(s, key).lastError = null;
        });
      } catch (err) {
        set((s) => {
          scopeDraft(s, key).lanes = prior;
        });
        await get().refreshPending(chatId, branchId);
        set((s) => {
          scopeDraft(s, key).lastError = toMessage(err);
        });
      }
    },

    chooseAttempt: async (chatId, branchId, rollId, attemptId) => {
      const key = scopeKey(chatId, branchId);
      const prior = get().byScope[key]?.lanes ?? EMPTY_LANES;
      if (prior) {
        set((s) => {
          mutateRoll(s, key, rollId, (roll) => {
            roll.finalAttemptId = attemptId;
            for (const attempt of roll.attempts) {
              attempt.chosenFinal = attempt.attemptId === attemptId;
            }
          });
        });
      }
      try {
        await chooseDiceAttempt(chatId, rollId, attemptId);
        await get().refreshPending(chatId, branchId);
        set((s) => {
          scopeDraft(s, key).lastError = null;
        });
      } catch (err) {
        set((s) => {
          scopeDraft(s, key).lanes = prior;
        });
        await get().refreshPending(chatId, branchId);
        set((s) => {
          scopeDraft(s, key).lastError = toMessage(err);
        });
      }
    },
  })),
);

// Dev-only debug global (mirrors the generation-queue-store / chat-store pattern).
if (typeof window !== "undefined") {
  window.__useDiceStore = useDiceStore;
}

// ── Narrow selectors ─────────────────────────────────────────────────────
// Each projects one field of one scope so unrelated scope/field changes do not
// re-render a subscriber.

const EMPTY_SCOPE = emptyScope();

function selectScope(s: DiceState, chatId: string | null | undefined, branchId: string | null | undefined): DiceScopeState {
  if (!chatId || !branchId) return EMPTY_SCOPE;
  return s.byScope[scopeKey(chatId, branchId)] ?? EMPTY_SCOPE;
}

/** Enabled Dice scripts + checks for the scope (null while unloaded). */
export function useDiceDefinitions(chatId: string | null | undefined, branchId: string | null | undefined): DiceDefinitionsResponse | null {
  return useDiceStore(useShallow((s) => selectScope(s, chatId, branchId).definitions));
}

/** Both pending lanes for the scope (null while unloaded). */
export function useDiceLanes(chatId: string | null | undefined, branchId: string | null | undefined): DiceScopeState["lanes"] {
  return useDiceStore(useShallow((s) => selectScope(s, chatId, branchId).lanes));
}

/** The scope's last error (null when clean). */
export function useDiceLastError(chatId: string | null | undefined, branchId: string | null | undefined): string | null {
  return useDiceStore(useShallow((s) => selectScope(s, chatId, branchId).lastError));
}

/** Whether any roll intent is currently in flight for the scope. */
export function useDiceRolling(chatId: string | null | undefined, branchId: string | null | undefined): boolean {
  return useDiceStore(useShallow((s) => Object.keys(selectScope(s, chatId, branchId).rollingRequestIds).length > 0));
}
