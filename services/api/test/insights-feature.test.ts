import { describe, expect, it } from "bun:test";
import { EventBus } from "@vibe-tavern/domain";
import { createInsightsFeature } from "../src/domain/insights/insights-feature.js";
import type { ObjectiveAutoCheckTrigger, ObjectiveService } from "../src/domain/insights/objective-service.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Insights feature immutable event targeting (OFA-4)", () => {
  it("forwards only qualifying assistant appends with immutable chat, branch, and message identity", async () => {
    const seen: ObjectiveAutoCheckTrigger[] = [];
    const objectiveService = {
      triggerAutoCheck: async (trigger: ObjectiveAutoCheckTrigger) => {
        seen.push(trigger);
      },
    } satisfies Pick<ObjectiveService, "triggerAutoCheck">;
    const events = new EventBus();
    const feature = createInsightsFeature({ objectiveService });
    feature.activate({ events, router: null as never });

    events.emit("message.appended", {
      chatId: "chat_1",
      branchId: "branch_user",
      messageId: "message_user",
      role: "user",
    });
    events.emit("message.appended", {
      chatId: "chat_1",
      branchId: "branch_committed",
      messageId: "message_committed",
      role: "assistant",
    });
    await flush();

    expect(seen).toEqual([{
      chatId: "chat_1",
      branchId: "branch_committed",
      messageId: "message_committed",
    }]);
    feature.deactivate?.();
  });
});
