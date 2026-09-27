import {
  FLY_HINT_PLACEHOLDER,
  FLY_TRIBUNAL_PRECEDENT_GATE,
} from "@vibe-tavern/api-contracts";
import type { StreamOutcome } from "../../hooks/use-chat-controller.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";
import {
  flyVerdictKey,
  useFlyTribunalStore,
  type FlyTribunalStore,
  type FlyVariantVerdict,
} from "../../stores/fly-tribunal-store.js";
import type { FlyTribunalSnapshotMessage, FlyTribunalSnapshotState } from "./fly-tribunal-wiring.js";
import { flyAutoSwipeThreshold, flySensitivityThreshold } from "./fly-tribunal-policy.js";

/** Replace the required hint placeholder with the top learned evidence spans. */
export function renderFlySteeringNote(templates: string[], verdict: FlyVariantVerdict): string | undefined {
  const template = templates[0];
  if (template === undefined) return undefined;
  const detected = verdict.drivingSpans.slice(0, 3).map((span) => span.ngram).join(", ");
  return template.replaceAll(FLY_HINT_PLACEHOLDER, detected);
}

export interface FlyTribunalActionDeps {
  runRegenerate: (chatId: string, messageId: string, override?: { steeringNote?: string }) => Promise<StreamOutcome>;
  selectVariant: (messageId: string, variantIndex: number) => void;
  getTyping: () => boolean;
  snapshot: { getState: () => FlyTribunalSnapshotState; subscribe: (listener: () => void) => () => void };
  store: { getState: () => FlyTribunalStore; subscribe: (listener: () => void) => () => void };
}

const defaultDeps: FlyTribunalActionDeps = {
  runRegenerate: async () => "failed",
  selectVariant: (messageId, variantIndex) => useSnapshotStore.getState().selectVariant(messageId, variantIndex, 1),
  getTyping: () => useChatStore.getState().draft.trim().length > 0,
  snapshot: useSnapshotStore,
  store: useFlyTribunalStore,
};

type Target = { chatId: string; message: FlyTribunalSnapshotMessage; variantIndex: number; content: string; variantIndexes: Set<number> };

/**
 * UI-land reaction ladder. The brain/wiring only report learned evaluations;
 * this module alone decides whether a fresh shown verdict gets a hint or a
 * guarded auto-swipe through the controller's existing regenerate runner.
 */
export class FlyTribunalActions {
  private readonly seenEvaluations = new Set<string>();
  private readonly attemptsByMessage = new Map<string, number>();
  private unsubscribeStore: (() => void) | null = null;

  constructor(private readonly deps: FlyTribunalActionDeps = defaultDeps) {}

  start(): void {
    if (this.unsubscribeStore !== null) return;
    this.unsubscribeStore = this.deps.store.subscribe(this.observe);
    this.observe();
  }

  stop(): void {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.seenEvaluations.clear();
    this.attemptsByMessage.clear();
  }

  /** Public deterministic seam for action tests. */
  async consider(verdict: FlyVariantVerdict): Promise<void> {
    const state = this.deps.store.getState();
    if (state.precedentCount < FLY_TRIBUNAL_PRECEDENT_GATE || verdict.confidence < flySensitivityThreshold(state.settings.sensitivity)) return;
    if (state.settings.reactionTier === "indication") return;
    const target = this.currentTarget(verdict);
    if (target === null) return;

    const auto = state.settings.reactionTier === "auto" && verdict.confidence >= flyAutoSwipeThreshold(state.settings.autoSwipeConfidence);
    if (auto && this.deps.getTyping()) return;
    const attempts = this.attemptsByMessage.get(verdict.messageId) ?? 0;
    if (attempts >= state.settings.regenCap) {
      state.showSleep();
      return;
    }

    this.attemptsByMessage.set(verdict.messageId, attempts + 1);
    state.showEscape(auto ? "auto" : "hint");
    const note = renderFlySteeringNote(state.settings.hints, verdict);
    const outcome = await this.deps.runRegenerate(target.chatId, verdict.messageId, note === undefined ? undefined : { steeringNote: note });
    if (outcome !== "done" || !this.targetUnchanged(target)) return;

    const landed = this.landedVariant(target);
    if (landed === null) {
      if ((this.attemptsByMessage.get(verdict.messageId) ?? 0) >= state.settings.regenCap) state.showSleep();
      return;
    }
    // The server's regenerate creates a variant but does not select it. Mirror
    // the existing optimistic select path only after arrival is verified.
    this.deps.selectVariant(verdict.messageId, landed.variantIndex);
  }

  private readonly observe = (): void => {
    const state = this.deps.store.getState();
    for (const verdict of Object.values(state.verdicts)) {
      const key = `${flyVerdictKey(verdict.messageId, verdict.variantIndex)}:${verdict.evaluatedAt}`;
      if (this.seenEvaluations.has(key)) continue;
      this.seenEvaluations.add(key);
      void this.consider(verdict);
    }
  };

  private currentTarget(verdict: FlyVariantVerdict): Target | null {
    const snapshot = this.deps.snapshot.getState();
    const chatId = snapshot.activeChat?.id;
    const message = snapshot.messagesById[verdict.messageId];
    const variant = message === undefined ? undefined : activeVariant(message);
    if (chatId === undefined || message?.role !== "assistant" || variant?.variantIndex !== verdict.variantIndex) return null;
    return { chatId, message, variantIndex: variant.variantIndex, content: variant.content, variantIndexes: new Set(message.variants.map((item) => item.variantIndex)) };
  }

  private targetUnchanged(target: Target): boolean {
    const snapshot = this.deps.snapshot.getState();
    const message = snapshot.messagesById[target.message.id];
    const variant = message === undefined ? undefined : activeVariant(message);
    return snapshot.activeChat?.id === target.chatId && variant?.variantIndex === target.variantIndex && variant.content === target.content;
  }

  private landedVariant(target: Target): FlyTribunalSnapshotMessage["variants"][number] | null {
    const message = this.deps.snapshot.getState().messagesById[target.message.id];
    if (message === undefined) return null;
    return message.variants.find((variant) => !target.variantIndexes.has(variant.variantIndex)) ?? null;
  }
}

let appActions: FlyTribunalActions | null = null;

/** Register the controller runner; no parallel fetch path is ever created. */
export function startFlyTribunalActions(
  runRegenerate: FlyTribunalActionDeps["runRegenerate"],
  selectVariant: FlyTribunalActionDeps["selectVariant"],
): void {
  if (appActions === null) appActions = new FlyTribunalActions({ ...defaultDeps, runRegenerate, selectVariant });
  appActions.start();
}

export function stopFlyTribunalActions(): void {
  appActions?.stop();
  appActions = null;
}

function activeVariant(message: FlyTribunalSnapshotMessage): FlyTribunalSnapshotMessage["variants"][number] | null {
  if (message.selectedVariantIndex !== null) {
    const selected = message.variants.find((variant) => variant.variantIndex === message.selectedVariantIndex);
    if (selected !== undefined) return selected;
  }
  return message.variants.find((variant) => variant.isSelected) ?? message.variants[0] ?? null;
}
