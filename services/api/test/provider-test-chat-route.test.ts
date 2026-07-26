import { describe, expect, test } from "bun:test";
import { createProviderRoutes } from "../src/api/routes/provider.js";
import type { ProviderRuntimeApi } from "../src/api/contract/runtime-api.js";

function mockRuntime(overrides: Partial<Pick<ProviderRuntimeApi, "testProviderChatByProfile">>): ProviderRuntimeApi {
  return overrides as ProviderRuntimeApi;
}

describe("profile Test: Hi transport routing", () => {
  test("passes an explicit Responses selection to the runtime", async () => {
    let received: { profileId: string; model: string; transport: string | undefined } | null = null;
    const app = createProviderRoutes(mockRuntime({
      testProviderChatByProfile: async (profileId, model, transport) => {
        received = { profileId, model, transport };
        return { success: true, reply: "Hi" };
      },
    }));

    const response = await app.request("/api/providers/profile_1/test-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "kimi-k2.5", transport: "responses" }),
    });

    expect(response.status).toBe(200);
    expect(received).toEqual({ profileId: "profile_1", model: "kimi-k2.5", transport: "responses" });
  });

  test("rejects an invalid transport before it reaches the runtime", async () => {
    const app = createProviderRoutes(mockRuntime({
      testProviderChatByProfile: async () => ({ success: true, reply: "unexpected" }),
    }));

    const response = await app.request("/api/providers/profile_1/test-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "model", transport: "made-up" }),
    });

    expect(response.status).toBe(400);
  });
});
