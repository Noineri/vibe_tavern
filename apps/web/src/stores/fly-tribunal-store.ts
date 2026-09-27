import { create } from "zustand";
import {
  FLY_TRIBUNAL_PRECEDENT_GATE,
  flyTribunalSettingsSchema,
  type FlyTribunalSettings,
} from "@vibe-tavern/api-contracts";
import type { FlyDrivingSpan, FlyEvaluation } from "../lib/fly/fly-engine-core.js";
import type { FlyWorkerRequest } from "../lib/fly/fly-worker.js";

/**
 * Fly Tribunal UI state (FLY_TRIBUNAL_PLAN FT-8).
 *
 * This is deliberately a plain Zustand state sink, not an Immer canonical-data
 * store. Worker and API wiring live in later waves; they report their stable
 * results here through the actions below, while React consumes selectors.
 *
 * Display mapping:
 * - `courtState: "silent"` always renders the silent cold-start judge, even
 *   if a worker has an evaluation; text verdicts unlock only at the shared gate.
 * - `courtState: "active"` + no transient renders the resting active judge.
 * - Active + learned confidence > 0 renders `alert` for `indication`, and
 *   `verdict` for `hint` / `auto`. FT-13 owns sensitivity and auto-swipe
 *   threshold policy; this store never invents numeric confidence cutoffs.
 * - `notes-a-precedent`, `escapes`, and `sleeps` are explicit transient
 *   animation overrides. FT-13 may enter the latter two only after it applies
 *   its approved auto-swipe/cap rules; UI consumers clear them after animating.
 */

export type FlyCourtState = "silent" | "active";
export type FlyTransientState = "notes-a-precedent" | "alert" | "verdict" | "escapes" | "sleeps";
export type FlyDisplayState = FlyCourtState | FlyTransientState;
export type FlySettingsLoadState = "idle" | "loading" | "ready" | "error";

/** The small worker-facing seam kept in UI state; the store never constructs
 * or owns a Worker. FT-10/FT-12 attach a protocol-compatible client. */
export interface FlyWorkerClient {
  postMessage: (request: FlyWorkerRequest, transfer?: Transferable[]) => void;
}

/** Stable UI projection of one worker evaluation for one message variant. */
export interface FlyVariantVerdict {
  messageId: string;
  variantIndex: number;
  confidence: number;
  drivingSpans: FlyDrivingSpan[];
  evaluatedAt: number;
}

export interface FlyGateProgress {
  current: number;
  gate: number;
  remaining: number;
  unlocked: boolean;
}

export interface FlyTribunalState {
  courtState: FlyCourtState;
  transientState: FlyTransientState | null;
  precedentCount: number;
  /** Timestamp for the widget's training-feedback animation; null before it observes a precedent. */
  lastPrecedentAt: number | null;
  /** One-shot signal for the explanatory re-silence toast; consume it through the action. */
  justFellSilent: boolean;
  /** JSON-tuple key (`[messageId, variantIndex]`) → latest evaluation only. */
  verdicts: Record<string, FlyVariantVerdict>;
  settings: FlyTribunalSettings;
  settingsLoadState: FlySettingsLoadState;
  settingsError: string | null;
  workerClient: FlyWorkerClient | null;
}

export interface FlyTribunalActions {
  /** Initial GET started by the Wave 4 settings surface. */
  beginSettingsLoad: () => void;
  /** API has validated the complete object; this is a mirror, not a validator. */
  applySettings: (settings: FlyTribunalSettings) => void;
  failSettingsLoad: (message: string) => void;
  /** Attach/detach the app-lifetime protocol client. The raw Worker stays outside this store. */
  attachWorkerClient: (client: FlyWorkerClient | null) => void;
  /** Drop worker-derived outputs when its brain session ends; persisted precedents stay. */
  clearDerivedVerdicts: () => void;
  /** Upsert, rather than append, the one verdict for this message variant. */
  recordEvaluation: (messageId: string, variantIndex: number, evaluation: FlyEvaluation) => void;
  /** Confirmed training event: increments the counter and starts the note animation. */
  recordPrecedent: () => void;
  /** Hydrate the persisted counter after a memory GET; falling below the gate re-silences. */
  setPrecedentCount: (count: number) => void;
  /** Fresh memory for amnesty or a scope switch; settings/client remain attached. */
  resetForAmnesty: () => void;
  /** Return-and-clear the one-shot re-silence signal. */
  consumeJustFellSilent: () => boolean;
  /** FT-13 enters these only after applying its own confidence/cap rules. */
  showEscape: () => void;
  showSleep: () => void;
  /** UI has finished its transient animation. */
  clearTransientState: () => void;
}

export type FlyTribunalStore = FlyTribunalState & FlyTribunalActions;

const DEFAULT_SETTINGS = flyTribunalSettingsSchema.parse({});

function courtStateFor(precedentCount: number): FlyCourtState {
  return precedentCount >= FLY_TRIBUNAL_PRECEDENT_GATE ? "active" : "silent";
}

function transientForEvaluation(
  courtState: FlyCourtState,
  settings: FlyTribunalSettings,
  confidence: number,
): FlyTransientState | null {
  if (courtState === "silent" || confidence <= 0) return null;
  return settings.reactionTier === "indication" ? "alert" : "verdict";
}

/** One unambiguous key even if an opaque message id contains punctuation. */
export function flyVerdictKey(messageId: string, variantIndex: number): string {
  return JSON.stringify([messageId, variantIndex]);
}

/** Gate math for the modal counter (`N/25`) and cold-start UI. */
export function selectFlyGateProgress(state: Pick<FlyTribunalState, "precedentCount">): FlyGateProgress {
  return {
    current: state.precedentCount,
    gate: FLY_TRIBUNAL_PRECEDENT_GATE,
    remaining: Math.max(0, FLY_TRIBUNAL_PRECEDENT_GATE - state.precedentCount),
    unlocked: state.precedentCount >= FLY_TRIBUNAL_PRECEDENT_GATE,
  };
}

/** Transients deliberately win over the resting court state while animating. */
export function selectFlyDisplayState(
  state: Pick<FlyTribunalState, "courtState" | "transientState">,
): FlyDisplayState {
  return state.transientState ?? state.courtState;
}

export function selectFlyVerdict(
  state: Pick<FlyTribunalState, "verdicts">,
  messageId: string,
  variantIndex: number,
): FlyVariantVerdict | undefined {
  return state.verdicts[flyVerdictKey(messageId, variantIndex)];
}

export const useFlyTribunalStore = create<FlyTribunalStore>()((set, get) => ({
  courtState: "silent",
  transientState: null,
  precedentCount: 0,
  lastPrecedentAt: null,
  justFellSilent: false,
  verdicts: {},
  settings: DEFAULT_SETTINGS,
  settingsLoadState: "idle",
  settingsError: null,
  workerClient: null,

  beginSettingsLoad: () => set({ settingsLoadState: "loading", settingsError: null }),

  applySettings: (settings) => set({ settings, settingsLoadState: "ready", settingsError: null }),

  failSettingsLoad: (message) => set({ settingsLoadState: "error", settingsError: message }),

  attachWorkerClient: (client) => set({ workerClient: client }),

  clearDerivedVerdicts: () => set({ verdicts: {}, transientState: null }),

  recordEvaluation: (messageId, variantIndex, evaluation) => {
    const evaluatedAt = Date.now();
    set((state) => {
      const verdict: FlyVariantVerdict = {
        messageId,
        variantIndex,
        confidence: evaluation.confidence,
        drivingSpans: evaluation.drivingSpans.map((span) => ({
          ...span,
          activeKcGlobalIndexes: [...span.activeKcGlobalIndexes],
        })),
        evaluatedAt,
      };
      return {
        verdicts: { ...state.verdicts, [flyVerdictKey(messageId, variantIndex)]: verdict },
        transientState: transientForEvaluation(state.courtState, state.settings, evaluation.confidence),
      };
    });
  },

  recordPrecedent: () => {
    const now = Date.now();
    set((state) => {
      const precedentCount = state.precedentCount + 1;
      return {
        precedentCount,
        courtState: courtStateFor(precedentCount),
        transientState: "notes-a-precedent",
        lastPrecedentAt: now,
      };
    });
  },

  setPrecedentCount: (precedentCount) => {
    set((state) => {
      const courtState = courtStateFor(precedentCount);
      const fellSilent = state.courtState === "active" && courtState === "silent";
      return {
        precedentCount,
        courtState,
        transientState: courtState === "silent" ? null : state.transientState,
        justFellSilent: state.justFellSilent || fellSilent,
      };
    });
  },

  resetForAmnesty: () => {
    const wasActive = get().courtState === "active";
    set((state) => ({
      courtState: "silent",
      transientState: null,
      precedentCount: 0,
      lastPrecedentAt: null,
      justFellSilent: state.justFellSilent || wasActive,
      verdicts: {},
    }));
  },

  consumeJustFellSilent: () => {
    const justFellSilent = get().justFellSilent;
    set({ justFellSilent: false });
    return justFellSilent;
  },

  showEscape: () => {
    if (get().courtState === "active") set({ transientState: "escapes" });
  },

  showSleep: () => {
    if (get().courtState === "active") set({ transientState: "sleeps" });
  },

  clearTransientState: () => set({ transientState: null }),
}));
