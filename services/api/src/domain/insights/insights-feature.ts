import type { FeatureModule, FeatureDeps } from "../../shared/feature-module.js";
import type { ObjectiveService } from "./objective-service.js";

// ────────────────────────────────────────────────────────────────────────────
// Insights Feature — Objective Tracker + Scene Tracker (INSIGHTS_PLAN INS-4)
// ────────────────────────────────────────────────────────────────────────────
// Case B background feature (per docs/guides/adding-a-feature.md): subscribes
// to "message.appended" on the EventBus and runs the objective auto-check
// fire-and-forget. The event fires on send/generate ONLY (notifyAssistantAppended
// is the sole emitter; the regenerate/swipe path does NOT emit it), so a queued
// burst of swipes produces zero triggers — Objective follows committed turns,
// not exploratory swipes.
//
// Dedup + trailing-edge correctness live on the ObjectiveService
// (runExclusiveTrailing — a dropped trigger marks the key dirty and the running
// check re-runs once before releasing, so the latest message is always
// evaluated; objective is forward-injected, so a one-turn detection lag is
// toxic). No SSE — manual actions return via RPC; auto persists to
// insightsObjectiveStateJson and the UI reads it on the next snapshot refresh.
//
// Mirrors chat-summary-feature.ts's shape. Scene Tracker (INS-9) will share
// this module (a second message.appended subscription + its own trailing lock).
// ────────────────────────────────────────────────────────────────────────────

export function createInsightsFeature(deps: {
  objectiveService: ObjectiveService;
}): FeatureModule {
  const objectiveService = deps.objectiveService;
  let unsubscribe: (() => void) | null = null;

  return {
    id: "insights",

    activate({ events }: FeatureDeps): void {
      unsubscribe = events.on("message.appended", ({ chatId }) => {
        void objectiveService.triggerAutoCheck(chatId);
      });
    },

    deactivate(): void {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
