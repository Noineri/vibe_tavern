import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import {
  installSoundAlerts,
  notifyChatGenerationSettled,
  notifyImageGenerationSettled,
  setSoundAlertsEffectsForTests,
  type SoundAlertEffects,
} from "./sound-alerts-subscriber.js";
import { DEFAULT_SOUND_ALERTS, useSoundAlertsStore } from "../stores/sound-alerts-store.js";
import { useGenerationQueueStore } from "../stores/generation-queue-store.js";
import { initI18n } from "../i18n/i18n.js";
import { getT } from "../i18n/locale-helpers.js";

// dom-env: installSoundAlerts now also owns the app-level gesture primer
// (window listeners). The sound/alert effects themselves are still swapped
// through the module's test seam — no real Web Audio or Notification API.
// Real i18n (initI18n("en"), the chip-section-summaries precedent) so notifyOs
// assertions compare against t() itself — pinning the event → key mapping
// without hardcoding the copy.
useDomEnv();

const played: string[] = [];
const notified: Array<{ title: string; body: string }> = [];
let background = true;

const fakeEffects: SoundAlertEffects = {
  playAlert: (kind) => { played.push(kind); },
  notifyOs: (title, body) => { notified.push({ title, body }); },
  isBackground: () => background,
};

function setToggles(toggles: Partial<typeof DEFAULT_SOUND_ALERTS>): void {
  useSoundAlertsStore.setState({ settings: { ...DEFAULT_SOUND_ALERTS, ...toggles } });
}

function seedRunningJob(chatId: string): string {
  const { enqueueJob, markRunning } = useGenerationQueueStore.getState();
  const id = enqueueJob({ chatId, messageId: "m1", model: "test-model", promptPresetId: null });
  markRunning(id);
  return id;
}

beforeEach(() => {
  played.length = 0;
  notified.length = 0;
  background = true;
  setToggles({});
  useGenerationQueueStore.setState({ jobsByChat: {}, batchesByChat: {}, recordsByChat: {} });
  setSoundAlertsEffectsForTests(fakeEffects);
  initI18n("en");
});

afterAll(() => {
  setSoundAlertsEffectsForTests(null);
});

describe("sound-alerts gating", () => {
  test("all toggles off (defaults): nothing plays even in the background", () => {
    notifyChatGenerationSettled("done");
    notifyImageGenerationSettled("done");
    expect(played).toEqual([]);
    expect(notified).toEqual([]);
  });

  test("reply ready in the background plays the success tone", () => {
    setToggles({ replyReady: true });

    notifyChatGenerationSettled("done");

    expect(played).toEqual(["success"]);
    expect(notified).toEqual([]);
  });

  test("foreground stays silent — the user is looking at the chat", () => {
    background = false;
    setToggles({ replyReady: true, generationError: true });

    notifyChatGenerationSettled("done");
    notifyChatGenerationSettled("failed");

    expect(played).toEqual([]);
    expect(notified).toEqual([]);
  });

  test("a cancelled generation is silent; a failure plays the error tone", () => {
    setToggles({ replyReady: true, generationError: true });

    notifyChatGenerationSettled("cancelled");
    expect(played).toEqual([]);

    notifyChatGenerationSettled("failed");
    expect(played).toEqual(["error"]);
  });

  test("image done maps to image-ready (success), failed to generation-error", () => {
    setToggles({ imageReady: true, generationError: true });

    notifyImageGenerationSettled("done");
    notifyImageGenerationSettled("failed");

    expect(played).toEqual(["success", "error"]);
  });

  test("OS notifications ride on an enabled event only — no eventless notify", () => {
    setToggles({ osNotifications: true });
    notifyChatGenerationSettled("done");
    expect(played).toEqual([]);
    expect(notified).toEqual([]);

    setToggles({ replyReady: true, osNotifications: true });
    notifyChatGenerationSettled("done");
    expect(played).toEqual(["success"]);
    const t = getT();
    expect(notified).toEqual([
      { title: t("settings_sound_notification_title"), body: t("settings_sound_notify_reply_ready") },
    ]);
  });

  test("each event's notification body key maps to its own event", () => {
    setToggles({
      imageReady: true,
      queueFinished: true,
      generationError: true,
      osNotifications: true,
    });

    notifyImageGenerationSettled("done");
    notifyImageGenerationSettled("failed");
    const dispose = installSoundAlerts();
    const jobId = seedRunningJob("chat-1");
    useGenerationQueueStore.getState().markDone(jobId);
    dispose();

    expect(notified).toEqual([
      { title: getT()("settings_sound_notification_title"), body: getT()("settings_sound_notify_image_ready") },
      { title: getT()("settings_sound_notification_title"), body: getT()("settings_sound_notify_generation_error") },
      { title: getT()("settings_sound_notification_title"), body: getT()("settings_sound_notify_queue_finished") },
    ]);
  });
});

describe("sound-alerts queue-finished subscription", () => {
  test("fires once when the last active job completes", () => {
    setToggles({ queueFinished: true });
    const dispose = installSoundAlerts();
    const jobId = seedRunningJob("chat-1");

    useGenerationQueueStore.getState().markDone(jobId);
    expect(played).toEqual(["success"]);

    // No re-fire on unrelated updates after the drain.
    useGenerationQueueStore.setState({ batchesByChat: {} });
    expect(played).toEqual(["success"]);
    dispose();
  });

  test("a multi-job queue fires only at the drain, not per completed job", () => {
    setToggles({ queueFinished: true });
    const { enqueueJob, markRunning, markDone } = useGenerationQueueStore.getState();
    const first = enqueueJob({ chatId: "chat-1", messageId: "m1", model: "x", promptPresetId: null });
    const second = enqueueJob({ chatId: "chat-1", messageId: "m1", model: "x", promptPresetId: null });
    markRunning(first);

    const dispose = installSoundAlerts();
    markDone(first);
    expect(played).toEqual([]); // second is still pending — the queue lives on

    markRunning(second);
    markDone(second);
    expect(played).toEqual(["success"]);
    dispose();
  });

  test("cancelling pending work never fires — nothing completed", () => {
    setToggles({ queueFinished: true });
    const { enqueueJob, cancelJob } = useGenerationQueueStore.getState();
    const jobId = enqueueJob({ chatId: "chat-1", messageId: "m1", model: "x", promptPresetId: null });

    const dispose = installSoundAlerts();
    cancelJob(jobId);
    expect(played).toEqual([]);
    dispose();
  });

  test("removing the last running job (an observed abort) is silent", () => {
    setToggles({ queueFinished: true });
    const jobId = seedRunningJob("chat-1");

    const dispose = installSoundAlerts();
    useGenerationQueueStore.getState().removeJob(jobId);
    expect(played).toEqual([]);
    dispose();
  });
});
