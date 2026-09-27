/**
 * L1 checklist: no paths, registries, globals, environment changes, mocks, or
 * waits; local dependency injection keeps tests deterministic and platform-free.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { flyTribunalSettingsSchema } from "@vibe-tavern/api-contracts";
import { useFlyTribunalStore, type FlyVariantVerdict } from "../../stores/fly-tribunal-store.js";
import {
  FlyTribunalActions,
  renderFlySteeringNote,
} from "./fly-tribunal-actions.js";
import {
  FLY_AUTO_SWIPE_CONFIDENCE,
  FLY_SENSITIVITY_CONFIDENCE,
  flyAutoBarExceedsAllSensitivityBars,
} from "./fly-tribunal-policy.js";
import type { FlyTribunalSnapshotState } from "./fly-tribunal-wiring.js";

const verdict: FlyVariantVerdict = {
  messageId: "assistant-1",
  variantIndex: 0,
  confidence: 0.9,
  drivingSpans: [{ ngram: "repeated phrase", channel: 1, activation: 0.8, activeKcGlobalIndexes: [1] }],
  evaluatedAt: 1,
};

function snapshot(): FlyTribunalSnapshotState {
  return {
    activeChat: { id: "chat-1" },
    messageOrder: ["assistant-1"],
    messagesById: {
      "assistant-1": {
        id: "assistant-1",
        role: "assistant",
        content: "old text",
        selectedVariantIndex: 0,
        variants: [{ variantIndex: 0, content: "old text", isSelected: true }],
      },
    },
  };
}

function prepare(settings = flyTribunalSettingsSchema.parse({ enabled: true, reactionTier: "hint", sensitivity: "soft", hints: ["Avoid {detected}."], regenCap: 2 })) {
  useFlyTribunalStore.setState({
    precedentCount: 25,
    courtState: "active",
    transientState: null,
    actionNotice: null,
    verdicts: {},
    settings,
  });
  const state = snapshot();
  const calls: Array<{ steeringNote?: string } | undefined> = [];
  const selections: number[] = [];
  let typing = false;
  let landOnRun = false;
  const actions = new FlyTribunalActions({
    store: useFlyTribunalStore,
    snapshot: { getState: () => state, subscribe: () => () => {} },
    getTyping: () => typing,
    runRegenerate: async (_chatId, _messageId, override) => {
      calls.push(override);
      if (landOnRun) state.messagesById["assistant-1"]!.variants.push({ variantIndex: 1, content: "new text" });
      return "done";
    },
    selectVariant: (_messageId, index) => selections.push(index),
  });
  return {
    actions,
    state,
    calls,
    selections,
    setTyping: (next: boolean) => { typing = next; },
    land: () => { landOnRun = true; },
  };
}

afterEach(() => {
  useFlyTribunalStore.setState({
    precedentCount: 0,
    courtState: "silent",
    transientState: null,
    actionNotice: null,
    verdicts: {},
    settings: flyTribunalSettingsSchema.parse({}),
  });
});

describe("Fly Tribunal action ladder", () => {
  test("keeps every auto bar above every sensitivity bar", () => {
    expect(flyAutoBarExceedsAllSensitivityBars()).toBe(true);
    expect(Math.min(...Object.values(FLY_AUTO_SWIPE_CONFIDENCE))).toBeGreaterThan(Math.max(...Object.values(FLY_SENSITIVITY_CONFIDENCE)));
  });

  test("renders evidence in a hint and sends it only through tribunal regeneration", async () => {
    const fixture = prepare();
    fixture.land();
    await fixture.actions.consider(verdict);
    expect(fixture.calls).toEqual([{ steeringNote: "Avoid repeated phrase." }]);
    expect(fixture.selections).toEqual([1]);
  });

  test("an empty hint list keeps the regenerate override absent", async () => {
    const fixture = prepare(flyTribunalSettingsSchema.parse({ enabled: true, reactionTier: "hint", sensitivity: "soft", hints: [] }));
    fixture.land();
    await fixture.actions.consider(verdict);
    expect(fixture.calls).toEqual([undefined]);
    expect(renderFlySteeringNote([], verdict)).toBeUndefined();
  });

  test("auto is opt-in and typing blocks the auto-swipe path", async () => {
    const fixture = prepare(flyTribunalSettingsSchema.parse({ enabled: true, reactionTier: "auto", sensitivity: "soft", autoSwipeConfidence: "high", hints: ["Avoid {detected}."] }));
    fixture.setTyping(true);
    await fixture.actions.consider(verdict);
    expect(fixture.calls).toEqual([]);
    expect(useFlyTribunalStore.getState().actionNotice).toBeNull();
  });

  test("requires a landed variant before selection and sleeps at the per-message cap", async () => {
    const fixture = prepare();
    await fixture.actions.consider(verdict);
    await fixture.actions.consider(verdict);
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.selections).toEqual([]);
    expect(useFlyTribunalStore.getState().transientState).toBe("sleeps");
  });

  test("indication and below-gate verdicts never regenerate", async () => {
    const fixture = prepare(flyTribunalSettingsSchema.parse({ enabled: true, reactionTier: "indication", sensitivity: "soft" }));
    await fixture.actions.consider(verdict);
    useFlyTribunalStore.setState({ precedentCount: 24, settings: flyTribunalSettingsSchema.parse({ enabled: true, reactionTier: "hint", sensitivity: "soft" }) });
    await fixture.actions.consider(verdict);
    expect(fixture.calls).toEqual([]);
  });
});
