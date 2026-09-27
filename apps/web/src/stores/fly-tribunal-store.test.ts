import { beforeEach, describe, expect, test } from "bun:test";
import { FLY_TRIBUNAL_PRECEDENT_GATE, flyTribunalSettingsSchema } from "@vibe-tavern/api-contracts";
import type { FlyEvaluation } from "../lib/fly/fly-engine-core.js";
import type { FlyWorkerRequest } from "../lib/fly/fly-worker.js";
import {
  flyVerdictKey,
  selectFlyDisplayState,
  selectFlyGateProgress,
  selectFlyVerdict,
  useFlyTribunalStore,
  type FlyWorkerClient,
} from "./fly-tribunal-store.js";

/**
 * Fly Tribunal UI state (FLY_TRIBUNAL_PLAN FT-8).
 *
 * L1 checklist:
 * 1. Paths: none.
 * 2. Restores: no process-global state, registries, fetch, or environment changes.
 * 3. Determinism: plain store actions and stable reads; no waits or sleeps.
 * 4. Platform: no OS paths or platform-specific APIs.
 * 5. Shared worker pool: no module mocks or mutable global registries.
 * 6. Stable state: every assertion reads useFlyTribunalStore.getState() after
 *    the synchronous action that establishes its invariant.
 */

function defaultSettings() {
  return flyTribunalSettingsSchema.parse({});
}

function evaluation(confidence: number, ngram = "violet lantern"): FlyEvaluation {
  return {
    confidence,
    registry: [{ ngram, channel: 7, count: 1, activation: 1 }],
    drivingSpans: [{ ngram, channel: 7, activation: 1, activeKcGlobalIndexes: [10, 11] }],
    activeKcIndexes: [3, 4],
    activeKcGlobalIndexes: [10, 11],
    mbonReadout: [],
  };
}

function resetStore(): void {
  useFlyTribunalStore.setState({
    courtState: "silent",
    transientState: null,
    precedentCount: 0,
    lastPrecedentAt: null,
    justFellSilent: false,
    verdicts: {},
    settings: defaultSettings(),
    settingsLoadState: "idle",
    settingsError: null,
    workerClient: null,
  });
}

beforeEach(() => {
  resetStore();
});

describe("Fly Tribunal verdicts", () => {
  test("upserts one verdict per message/variant key instead of appending", () => {
    const store = useFlyTribunalStore.getState();
    store.setPrecedentCount(FLY_TRIBUNAL_PRECEDENT_GATE);
    store.recordEvaluation("message_1", 0, evaluation(0.2, "first pattern"));
    store.recordEvaluation("message_1", 0, evaluation(0.9, "replacement pattern"));
    store.recordEvaluation("message_1", 1, evaluation(0.4, "second variant"));

    const state = useFlyTribunalStore.getState();
    expect(Object.keys(state.verdicts)).toHaveLength(2);
    expect(selectFlyVerdict(state, "message_1", 0)).toMatchObject({
      confidence: 0.9,
      drivingSpans: [{ ngram: "replacement pattern" }],
    });
    expect(selectFlyVerdict(state, "message_1", 1)).toMatchObject({ confidence: 0.4 });
    expect(flyVerdictKey("message_1", 0)).not.toBe(flyVerdictKey("message_1", 1));
  });

  test("clears worker-derived verdicts without discarding the persisted precedent gate", () => {
    const store = useFlyTribunalStore.getState();
    store.setPrecedentCount(FLY_TRIBUNAL_PRECEDENT_GATE);
    store.recordEvaluation("message_1", 0, evaluation(0.8));

    store.clearDerivedVerdicts();

    const state = useFlyTribunalStore.getState();
    expect(state.verdicts).toEqual({});
    expect(state.transientState).toBeNull();
    expect(state.precedentCount).toBe(FLY_TRIBUNAL_PRECEDENT_GATE);
    expect(state.courtState).toBe("active");
  });
});

describe("Fly Tribunal precedent gate", () => {
  test("stays silent below the gate, unlocks at it, then re-silences with a consumable signal", () => {
    const store = useFlyTribunalStore.getState();
    store.setPrecedentCount(FLY_TRIBUNAL_PRECEDENT_GATE - 1);

    let state = useFlyTribunalStore.getState();
    expect(state.courtState).toBe("silent");
    expect(selectFlyGateProgress(state)).toEqual({
      current: FLY_TRIBUNAL_PRECEDENT_GATE - 1,
      gate: FLY_TRIBUNAL_PRECEDENT_GATE,
      remaining: 1,
      unlocked: false,
    });

    store.recordPrecedent();
    state = useFlyTribunalStore.getState();
    expect(state.precedentCount).toBe(FLY_TRIBUNAL_PRECEDENT_GATE);
    expect(state.courtState).toBe("active");
    expect(selectFlyGateProgress(state)).toEqual({
      current: FLY_TRIBUNAL_PRECEDENT_GATE,
      gate: FLY_TRIBUNAL_PRECEDENT_GATE,
      remaining: 0,
      unlocked: true,
    });
    expect(selectFlyDisplayState(state)).toBe("notes-a-precedent");
    expect(state.lastPrecedentAt).not.toBeNull();

    store.resetForAmnesty();
    state = useFlyTribunalStore.getState();
    expect(state).toMatchObject({ courtState: "silent", precedentCount: 0, justFellSilent: true, verdicts: {} });
    expect(store.consumeJustFellSilent()).toBe(true);
    expect(useFlyTribunalStore.getState().justFellSilent).toBe(false);
    expect(store.consumeJustFellSilent()).toBe(false);
  });
});

describe("Fly Tribunal display state machine", () => {
  test("maps active confidence and reaction tiers only to documented display states", () => {
    const store = useFlyTribunalStore.getState();
    store.setPrecedentCount(FLY_TRIBUNAL_PRECEDENT_GATE);

    store.recordEvaluation("message_1", 0, evaluation(0));
    expect(selectFlyDisplayState(useFlyTribunalStore.getState())).toBe("active");

    store.recordEvaluation("message_1", 0, evaluation(0.3));
    expect(selectFlyDisplayState(useFlyTribunalStore.getState())).toBe("alert");

    store.applySettings({ ...defaultSettings(), reactionTier: "hint" });
    store.recordEvaluation("message_1", 0, evaluation(0.3));
    expect(selectFlyDisplayState(useFlyTribunalStore.getState())).toBe("verdict");

    store.applySettings({ ...defaultSettings(), reactionTier: "auto" });
    store.recordEvaluation("message_1", 0, evaluation(0.3));
    expect(selectFlyDisplayState(useFlyTribunalStore.getState())).toBe("verdict");

    store.showEscape();
    expect(selectFlyDisplayState(useFlyTribunalStore.getState())).toBe("escapes");
    store.showSleep();
    expect(selectFlyDisplayState(useFlyTribunalStore.getState())).toBe("sleeps");
    store.clearTransientState();
    expect(selectFlyDisplayState(useFlyTribunalStore.getState())).toBe("active");

    store.setPrecedentCount(0);
    store.recordEvaluation("message_1", 0, evaluation(0.9));
    expect(selectFlyDisplayState(useFlyTribunalStore.getState())).toBe("silent");
  });
});

describe("Fly Tribunal settings and client seams", () => {
  test("mirrors a full validated settings object and exposes post-action state through getState", () => {
    const store = useFlyTribunalStore.getState();
    const settings = flyTribunalSettingsSchema.parse({
      enabled: true,
      reactionTier: "auto",
      regenCap: 3,
      sensitivity: "strict",
      autoSwipeConfidence: "very-high",
      trainingEnabled: false,
      trainingSpeed: "fast",
      precedentLifetimeDays: null,
      hints: ["Detected: {detected}"],
      memoryScope: "global",
    });
    const client: FlyWorkerClient = {
      postMessage(_request: FlyWorkerRequest): void {},
    };

    store.beginSettingsLoad();
    expect(useFlyTribunalStore.getState().settingsLoadState).toBe("loading");
    store.applySettings(settings);
    store.attachWorkerClient(client);

    const state = useFlyTribunalStore.getState();
    expect(state.settings).toEqual(settings);
    expect(state.settingsLoadState).toBe("ready");
    expect(state.settingsError).toBeNull();
    expect(state.workerClient).toBe(client);
  });
});
