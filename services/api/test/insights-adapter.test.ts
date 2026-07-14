import { describe, expect, it } from "bun:test";
import type { StoreContainer } from "@vibe-tavern/db";
import type { ObjectiveState } from "@vibe-tavern/domain";
import { InsightsAdapter } from "../src/api/adapters/insights-adapter.js";
import { defaultObjectiveState, type ObjectiveService } from "../src/domain/insights/objective-service.js";
import type { SessionRuntime } from "../src/runtime/session/session-runtime.js";

describe("InsightsAdapter Objective context", () => {
  it("uses the stored contextWindow for manual generation", async () => {
    const state: ObjectiveState = { ...defaultObjectiveState(), contextWindow: 4 };
    let recentMessageLimit: number | undefined;
    let receivedContext: unknown;
    const context = { identity: { chatId: "chat_1" } };

    const stores = {
      chats: { getById: async () => ({ id: "chat_1" }) },
    } as unknown as StoreContainer;
    const sessionRuntime = {
      chatLifecycle: {
        buildPipelineContext: async (input: { recentMessageLimit?: number }) => {
          recentMessageLimit = input.recentMessageLimit;
          return { context };
        },
      },
      buildConfigPatchResponse: async () => ({ activeChat: {} }),
    } as unknown as SessionRuntime;
    const objectiveService = {
      getState: async () => state,
      resolveInsightProvider: async () => ({ profile: {}, model: "test-model" }),
      generateTasks: async (input: { context: unknown }) => {
        receivedContext = input.context;
        return state;
      },
    } as unknown as ObjectiveService;

    const adapter = new InsightsAdapter(stores, sessionRuntime, objectiveService);
    await adapter.generateObjectiveTasks("chat_1", {});

    expect(recentMessageLimit).toBe(4);
    expect(receivedContext).toBe(context);
  });
});
