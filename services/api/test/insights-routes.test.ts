import { describe, expect, it } from "bun:test";
import { createInsightsRoutes } from "../src/api/routes/insights.js";
import type { InsightsRuntimeApi } from "../src/api/contract/runtime-api.js";
import { defaultObjectiveState } from "../src/domain/insights/objective-service.js";

describe("Insights completion-refresh route", () => {
  it("forwards the typed chat target and request signal", async () => {
    const target = { branchId: "branch_1", messageId: "msg_1" };
    const responseBody = {
      target: { chatId: "chat_1", ...target },
      patch: { objectiveState: defaultObjectiveState() },
    };
    let received: { chatId: string; body: { target: typeof target }; signal?: AbortSignal } | undefined;
    const runtime = {
      refreshInsightsCompletion: async (chatId: string, body: { target: typeof target }, signal?: AbortSignal) => {
        received = { chatId, body, signal };
        return responseBody;
      },
    } as unknown as InsightsRuntimeApi;
    const app = createInsightsRoutes(runtime);
    const controller = new AbortController();

    const response = await app.request("/api/chats/chat_1/insights/completion-refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target }),
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(responseBody);
    expect(received).toEqual({ chatId: "chat_1", body: { target }, signal: controller.signal });
  });

  it("rejects an empty target before calling the runtime", async () => {
    let calls = 0;
    const runtime = {
      refreshInsightsCompletion: async () => {
        calls += 1;
        throw new Error("runtime must not be called");
      },
    } as unknown as InsightsRuntimeApi;
    const app = createInsightsRoutes(runtime);

    const response = await app.request("/api/chats/chat_1/insights/completion-refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: { branchId: "", messageId: "" } }),
    });

    expect(response.status).toBe(400);
    expect(calls).toBe(0);
  });
});
