/**
 * The Scene record-write observer seam (DIRECTOR_DECK_CALENDAR_PLAN DK-4b).
 *
 * `SceneTrackerService` fires ONE optional observer after every successful
 * Scene record write — generate (manual, auto-start and backfill items all
 * commit through `commitRecord`) and manual edit (`editScene`); deletion is
 * NOT a write and never fires it, a preview never persists and never fires
 * it. The observer adds NO await inside the Scene Tracker's own write path —
 * the commit lanes serialize Scene writes, and an await inside them would
 * reorder the very writes they exist to serialize — so this module owns the
 * fire-and-forget invocation shape: sync throws and detached promise
 * rejections are logged and swallowed, and the written record stands
 * regardless of observer failures (a plan-side problem must never corrupt or
 * fail a scene write).
 *
 * The one production consumer is `StoryPlanSync.advanceByClock` (registered
 * at wiring, server-runtime.ts); because that consumer writes only the plan
 * + the goal projection — never a Scene record — the observer cannot
 * re-enter itself (pinned in the story-plan clock tests).
 *
 * Extracted from tracker-service.ts (DK-4b arch-gate ratchet: the service
 * file could not grow; tracker-service re-exports the type so its public
 * surface is unchanged). Fork #1 of ObjectiveService.notifyStateObserver
 * (services/api/src/domain/insights/objective-service.ts — forks: 1 there):
 * the same strictly-synchronous-from-the-lane's-point-of-view invocation
 * shape. Deviations: two-argument identity (chatId, branchId); a free
 * function taking the (optional) observer as its first argument; logs go
 * through logSendDebug like the rest of the Scene modules.
 */
import type { ChatBranchId, ChatId } from "@vibe-tavern/domain";
import { logSendDebug } from "../../shared/send-debug-log.js";

/**
 * The (optional) post-write record observer: fired with the written record's
 * chat + branch identity. Registration happens at wiring, after both the
 * service and the observer's owner (StoryPlanSync) exist — the same
 * late-bound shape as ObjectiveService.registerStateObserver, which is why
 * it is a registration and not a constructor param; there is no unregister —
 * the observer lives as long as the process.
 */
export type SceneRecordWrittenObserver = (chatId: ChatId, branchId: ChatBranchId) => void | Promise<void>;

/**
 * Signal the record observer WITHOUT awaiting it, after a successful record
 * write stood. A null observer is today's no-notification behavior. Sync
 * throws and detached promise rejections are logged and swallowed — the
 * committed record stands regardless of observer failures. (Fork #1 of
 * ObjectiveService.notifyStateObserver — see the module header.)
 */
export function notifyRecordWritten(
  observer: SceneRecordWrittenObserver | null,
  chatId: ChatId,
  branchId: ChatBranchId,
): void {
  if (!observer) return;
  try {
    const maybe = observer(chatId, branchId);
    if (maybe instanceof Promise) {
      void maybe.catch((error: unknown) => {
        logSendDebug("insights.scene.record.observer.rejected", {
          chatId: chatId as string,
          branchId: branchId as string,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
  } catch (error) {
    logSendDebug("insights.scene.record.observer.threw", {
      chatId: chatId as string,
      branchId: branchId as string,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
