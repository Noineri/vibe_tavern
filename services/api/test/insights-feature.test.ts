import { describe, expect, it } from "bun:test";
import { EventBus } from "@vibe-tavern/domain";
import { createInsightsFeature, composeForwardStateWait } from "../src/domain/insights/insights-feature.js";
import type { ObjectiveAutoCheckTrigger, ObjectiveService } from "../src/domain/insights/objective-service.js";
import type { SceneAutoGenerateTrigger, SceneTrackerService } from "../src/domain/insights/tracker-service.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("Insights feature immutable event targeting (OFA-4 / SCN-8)", () => {
  it("forwards only qualifying assistant appends to Objective with immutable identity", async () => {
    const seen: ObjectiveAutoCheckTrigger[] = [];
    const objectiveService = {
      triggerAutoCheck: async (trigger: ObjectiveAutoCheckTrigger) => { seen.push(trigger); },
    } satisfies Pick<ObjectiveService, "triggerAutoCheck">;
    const trackerService = {
      triggerAutoGenerate: async () => {},
    } satisfies Pick<SceneTrackerService, "triggerAutoGenerate">;
    const events = new EventBus();
    const feature = createInsightsFeature({ objectiveService, trackerService });
    feature.activate({ events, router: null as never });

    events.emit("message.appended", { chatId: "chat_1", branchId: "bu", messageId: "mu", role: "user" });
    events.emit("message.appended", { chatId: "chat_1", branchId: "bc", messageId: "mc", role: "assistant" });
    await flush();

    expect(seen).toEqual([{ chatId: "chat_1", branchId: "bc", messageId: "mc" }]);
    feature.deactivate?.();
  });

  it("forwards qualifying assistant appends to the Scene auto-start (SCN-8)", async () => {
    const seen: SceneAutoGenerateTrigger[] = [];
    const objectiveService = { triggerAutoCheck: async () => {} } as unknown as Pick<ObjectiveService, "triggerAutoCheck">;
    const trackerService = {
      triggerAutoGenerate: async (trigger: SceneAutoGenerateTrigger) => { seen.push(trigger); },
    } satisfies Pick<SceneTrackerService, "triggerAutoGenerate">;
    const events = new EventBus();
    const feature = createInsightsFeature({ objectiveService, trackerService });
    feature.activate({ events, router: null as never });

    events.emit("message.appended", { chatId: "chat_2", branchId: "b1", messageId: "m_user", role: "user" });
    events.emit("message.appended", { chatId: "chat_2", branchId: "b1", messageId: "m_asst", role: "assistant" });
    await flush();

    expect(seen).toEqual([{ chatId: "chat_2", branchId: "b1", messageId: "m_asst" }]);
    feature.deactivate?.();
  });

  it("stops forwarding after deactivate (both subscriptions removed)", async () => {
    const obj: ObjectiveAutoCheckTrigger[] = [];
    const scn: SceneAutoGenerateTrigger[] = [];
    const objectiveService = { triggerAutoCheck: async (t: ObjectiveAutoCheckTrigger) => { obj.push(t); } } as unknown as Pick<ObjectiveService, "triggerAutoCheck">;
    const trackerService = { triggerAutoGenerate: async (t: SceneAutoGenerateTrigger) => { scn.push(t); } } as unknown as Pick<SceneTrackerService, "triggerAutoGenerate">;
    const events = new EventBus();
    const feature = createInsightsFeature({ objectiveService, trackerService });
    feature.activate({ events, router: null as never });
    feature.deactivate?.();

    events.emit("message.appended", { chatId: "c", branchId: "b", messageId: "m", role: "assistant" });
    await flush();

    expect(obj).toHaveLength(0);
    expect(scn).toHaveLength(0);
  });
});

describe("composeForwardStateWait — Objective+Scene chokepoint composition (SCN-8)", () => {
  it("runs both waits concurrently and resolves only after BOTH complete", async () => {
    const obj = deferred();
    const scn = deferred();
    let objDone = false;
    let scnDone = false;
    const wait = composeForwardStateWait(
      { waitForForwardState: async () => { await obj.promise; objDone = true; } },
      { waitForForwardState: async () => { await scn.promise; scnDone = true; } },
    );

    const pending = wait("chat_1");
    await Promise.resolve();
    // Neither done yet → the composed wait has not resolved.
    obj.resolve();
    await flush();
    expect(objDone).toBe(true);
    expect(scnDone).toBe(false);

    scn.resolve();
    await expect(pending).resolves.toBeUndefined();
    expect(scnDone).toBe(true);
  });

  it("a NON-abort failure in one wait is swallowed — the other still completes and the send proceeds", async () => {
    const scn = deferred();
    const wait = composeForwardStateWait(
      { waitForForwardState: async () => { throw new Error("objective boom"); } },
      { waitForForwardState: async () => { await scn.promise; } },
    );

    const pending = wait("chat_1");
    await flush();
    // Objective threw (non-abort) but the composed wait is still waiting on Scene.
    scn.resolve();
    await expect(pending).resolves.toBeUndefined(); // Scene failure fallback → proceed
  });

  it("a Scene failure (non-abort) resolves the wait so the main model proceeds with latest-valid/none", async () => {
    const obj = deferred();
    const wait = composeForwardStateWait(
      { waitForForwardState: async () => { await obj.promise; } },
      { waitForForwardState: async () => { throw new Error("scene boom"); } },
    );

    const pending = wait("chat_1");
    obj.resolve();
    await expect(pending).resolves.toBeUndefined();
  });

  it("abort propagates (the send is cancelled)", async () => {
    const controller = new AbortController();
    // Each mock mirrors a real waitForForwardState: it parks until the signal
    // aborts, then rejects with the abort reason (waiter detaches). The shared
    // JOB (the never-resolving park) is not itself cancelled — that invariant
    // is pinned in tracker-coordinator.test.ts against the real service.
    const parking = () => ({
      waitForForwardState: async (_id: string, signal?: AbortSignal) => {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    const wait = composeForwardStateWait(parking(), parking());

    const pending = wait("chat_1", controller.signal);
    await Promise.resolve();
    controller.abort(new Error("user cancelled send"));
    await expect(pending).rejects.toThrow("user cancelled send");
  });
});
