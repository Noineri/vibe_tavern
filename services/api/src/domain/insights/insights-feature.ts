import type { FeatureModule, FeatureDeps } from "../../shared/feature-module.js";
import type { ChatId } from "@vibe-tavern/domain";
import type { ObjectiveService } from "./objective-service.js";
import type { SceneTrackerService } from "./tracker-service.js";
import { logSendDebug } from "../../shared/send-debug-log.js";

// ────────────────────────────────────────────────────────────────────────────
// Insights Feature — Objective Tracker + Scene Tracker (INSIGHTS_PLAN INS-4)
// ────────────────────────────────────────────────────────────────────────────
// Case B background feature (per docs/guides/adding-a-feature.md): subscribes
// to "message.appended" on the EventBus and runs each feature's auto-start
// fire-and-forget. The event fires on send/generate ONLY (notifyAssistantAppended
// is the sole emitter; the regenerate/swipe path does NOT emit it), so a queued
// burst of swipes produces zero triggers — both features follow committed turns,
// not exploratory swipes.
//
// Objective dedup + trailing-edge correctness live on the ObjectiveService
// (runExclusiveTrailing). Scene's auto-start is target-keyed by immutable variant
// id (the appended message's selected variant), so a re-trigger for an
// already-current variant is a no-op and a burst coalesces into one job per target.
//
// No SSE — manual actions return directly; auto persists to the per-feature state
// column, the next prompt joins the job, and the frontend receives the committed
// state through the target-scoped completion-refresh RPC.
//
// composeForwardStateWait (SCN-8) is the single injected wait at the
// LiveChatOrchestrator.resolveProvider chokepoint: Objective + Scene waits run
// concurrently via Promise.all, each individually failure-contained so one
// auxiliary failure never blocks the main model or cancels the other wait.
// ────────────────────────────────────────────────────────────────────────────

export function createInsightsFeature(deps: {
  objectiveService: Pick<ObjectiveService, "triggerAutoCheck">;
  trackerService: Pick<SceneTrackerService, "triggerAutoGenerate">;
}): FeatureModule {
  const objectiveService = deps.objectiveService;
  const trackerService = deps.trackerService;
  let unsubscribeObjective: (() => void) | null = null;
  let unsubscribeScene: (() => void) | null = null;

  return {
    id: "insights",

    activate({ events }: FeatureDeps): void {
      unsubscribeObjective = events.on("message.appended", ({ chatId, branchId, messageId, role }) => {
        if (role !== "assistant") return;
        void objectiveService.triggerAutoCheck({ chatId, branchId, messageId });
      });
      unsubscribeScene = events.on("message.appended", ({ chatId, branchId, messageId, role }) => {
        if (role !== "assistant") return;
        void trackerService.triggerAutoGenerate({ chatId, branchId, messageId });
      });
    },

    deactivate(): void {
      unsubscribeObjective?.();
      unsubscribeScene?.();
      unsubscribeObjective = null;
      unsubscribeScene = null;
    },
  };
}

/** Minimal wait surface each Insights feature exposes for the chokepoint composition. */
interface ForwardStateWaiter {
  waitForForwardState(chatId: ChatId, signal?: AbortSignal): Promise<void>;
}

/**
 * Compose the Objective + Scene forward-state waits into the single chokepoint
 * waiter (SCN-8). Both run concurrently via `Promise.all` (success waits for
 * both commits). Each is individually failure-contained: a NON-abort error is
 * logged and swallowed so one auxiliary feature can never block the main model
 * or cancel the other wait (Scene failure → proceed with latest-valid/no Scene;
 * Objective failure → proceed regardless). An abort PROPAGATES — the caller is
 * cancelling the send — but the shared jobs keep running either way (each
 * feature's waitForForwardState detaches on abort without aborting its job).
 */
export function composeForwardStateWait(
  objective: ForwardStateWaiter,
  scene: ForwardStateWaiter,
): (chatId: string, signal?: AbortSignal) => Promise<void> {
  return async (chatId, signal) => {
    const chatIdBranded = chatId as ChatId;
    const contain = (wait: Promise<void>): Promise<void> =>
      wait.catch((error: unknown) => {
        if (signal?.aborted) throw error;
        logSendDebug("insights.forward_state_wait.error", {
          chatId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    await Promise.all([
      contain(objective.waitForForwardState(chatIdBranded, signal)),
      contain(scene.waitForForwardState(chatIdBranded, signal)),
    ]);
  };
}
