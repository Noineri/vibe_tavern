/**
 * SM-8 sound alerts — the event subscriber (plan VT_SETTINGS_MODAL_PLAN
 * Wave 5 step 3).
 *
 * Event sources (re-derived 2026-11-04, see the seams):
 * - reply ready / generation error — `notifyChatGenerationSettled` is called
 *   from the two generation funnels in use-chat-controller (they carry send /
 *   regenerate / continue / queue runs / reattach, streaming and not);
 *   "cancelled" is the user's own stop and stays silent.
 * - image ready — `notifyImageGenerationSettled` from image-gen-chat-store's
 *   runGeneration (abort errors never reach it).
 * - queue finished — the `useGenerationQueueStore` subscription installed by
 *   {@link installSoundAlerts}: a chat's active (pending|running) count
 *   reaching zero after at least one job COMPLETED (done|failed) — cancelling
 *   pending work or dropping a running job is not a finished queue.
 *
 * One rule gates every event: the event's own toggle AND `isBackground()`;
 * OS notifications additionally require the osNotifications toggle.
 */
import { getT } from "../i18n/locale-helpers.js";
import { useGenerationQueueStore, type QueueJob } from "../stores/generation-queue-store.js";
import { useSoundAlertsStore } from "../stores/sound-alerts-store.js";
import { installSoundAlertsGesturePrimer, isBackground, notifyOs, playAlert, type SoundAlertKind } from "./sound-alerts.js";

export type SoundAlertEvent = "replyReady" | "imageReady" | "queueFinished" | "generationError";

/** Injectable for tests — the real set reads the store and the browser APIs. */
export interface SoundAlertEffects {
  playAlert: (kind: SoundAlertKind) => void;
  notifyOs: (title: string, body: string) => void;
  isBackground: () => boolean;
}

const realEffects: SoundAlertEffects = {
  playAlert: (kind) => playAlert(kind, useSoundAlertsStore.getState().settings.volume),
  notifyOs,
  isBackground,
};

let effects: SoundAlertEffects | null = null;

/** Test seam: swap the browser-facing effects (restore with null). */
export function setSoundAlertsEffectsForTests(overrides: SoundAlertEffects | null): void {
  effects = overrides;
}

const NOTIFY_BODY_KEY = {
  replyReady: "settings_sound_notify_reply_ready",
  imageReady: "settings_sound_notify_image_ready",
  queueFinished: "settings_sound_notify_queue_finished",
  generationError: "settings_sound_notify_generation_error",
} as const satisfies Record<SoundAlertEvent, Parameters<ReturnType<typeof getT>>[0]>;

function fire(event: SoundAlertEvent): void {
  const { settings } = useSoundAlertsStore.getState();
  if (!settings[event]) return;
  const active = effects ?? realEffects;
  if (!active.isBackground()) return;
  active.playAlert(event === "generationError" ? "error" : "success");
  // OS notifications ride on an enabled event — there is no eventless notify.
  if (settings.osNotifications) {
    active.notifyOs(getT()("settings_sound_notification_title"), getT()(NOTIFY_BODY_KEY[event]));
  }
}

/**
 * A chat text generation settled. "done" → reply ready; "failed" → generation
 * error; "cancelled" (the user's stop, an abort) is silent by design.
 */
export function notifyChatGenerationSettled(outcome: "done" | "cancelled" | "failed"): void {
  if (outcome === "done") fire("replyReady");
  else if (outcome === "failed") fire("generationError");
}

/** An image-gen chat job settled. Aborts are filtered at the store seam. */
export function notifyImageGenerationSettled(outcome: "done" | "failed"): void {
  fire(outcome === "done" ? "imageReady" : "generationError");
}

function countActive(jobs: readonly QueueJob[]): number {
  return jobs.filter((job) => job.status === "pending" || job.status === "running").length;
}

/**
 * Subscribe to the generation queue once per app (AppShell mount). Fires
 * queue-finished when a chat drains its active jobs BECAUSE a job completed:
 * some job id went pending/running → done/failed in the same transition.
 * Cancels, clears and removals never qualify. Also primes the shared
 * AudioContext on the first user gesture anywhere — after a reload with
 * toggles already on, the sound section is never reopened, so without this
 * the alerts would stay silent until the user happened to visit it.
 */
export function installSoundAlerts(): () => void {
  const disposeGesturePrimer = installSoundAlertsGesturePrimer();
  const unsubscribe = useGenerationQueueStore.subscribe((state, prevState) => {
    for (const [chatId, jobs] of Object.entries(state.jobsByChat)) {
      const before = prevState.jobsByChat[chatId];
      if (!before || countActive(before) === 0 || countActive(jobs) > 0) continue;
      const completed = jobs.some((job) => {
        const was = before.find((candidate) => candidate.id === job.id);
        return was && (was.status === "pending" || was.status === "running")
          && (job.status === "done" || job.status === "failed");
      });
      if (completed) fire("queueFinished");
    }
  });
  return () => {
    unsubscribe();
    disposeGesturePrimer();
  };
}
