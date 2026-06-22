import { describe, expect, test } from "bun:test";
import { createProviderRoutes } from "../src/api/routes/provider.js";
import type { ProviderRuntimeApi } from "../src/api/contract/runtime-api.js";

/**
 * Route-level integration tests for the per-model settings overlay endpoints.
 * Builds the Hono app with a mock runtime and hits the routes via app.request(),
 * so zod validation + routing + JSON wiring are exercised end-to-end.
 */

// Minimal mock — only the overlay methods are exercised; the rest is cast away.
function mockRuntime(overrides: Partial<Pick<ProviderRuntimeApi,
  "listProviderModelSettings" |
  "getProviderModelSettings" |
  "upsertProviderModelSettings" |
  "deleteProviderModelSettings"
>> = {}): ProviderRuntimeApi {
  return { ...overrides } as unknown as ProviderRuntimeApi;
}

const OVERLAY = { temperature: 0.3, contextBudget: 8000, pinContextBudget: true };

describe("provider model-settings overlay routes", () => {
  test("GET /api/providers/:id/model-settings → 200 + list", async () => {
    const runtime = mockRuntime({
      listProviderModelSettings: async () => [{
        id: "pms_1", providerProfileId: "prov_1", modelId: "gpt-4o",
        settings: OVERLAY, createdAt: "t1", updatedAt: "t2",
      }],
    });
    const app = createProviderRoutes(runtime);
    const res = await app.request("/api/providers/prov_1/model-settings");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(1);
    expect(json[0].modelId).toBe("gpt-4o");
    expect(json[0].settings.temperature).toBe(0.3);
  });

  test("GET /api/providers/:id/model-settings/:modelId → 200 + row (or null)", async () => {
    const runtime = mockRuntime({
      getProviderModelSettings: async () => ({
        id: "pms_1", providerProfileId: "prov_1", modelId: "gpt-4o",
        settings: OVERLAY, createdAt: "t1", updatedAt: "t2",
      }),
    });
    const app = createProviderRoutes(runtime);
    const res = await app.request("/api/providers/prov_1/model-settings/gpt-4o");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.modelId).toBe("gpt-4o");
    expect(json.settings.pinContextBudget).toBe(true);
  });

  test("GET single overlay returns null when none exists (null passthrough)", async () => {
    const runtime = mockRuntime({ getProviderModelSettings: async () => null });
    const app = createProviderRoutes(runtime);
    const res = await app.request("/api/providers/prov_1/model-settings/unknown");
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  test("PUT /api/providers/:id/model-settings/:modelId → upsert, body is the overlay, modelId from URL", async () => {
    let captured: { profileId: string; modelId: string; settings: unknown } | null = null;
    const runtime = mockRuntime({
      upsertProviderModelSettings: async (profileId, modelId, settings) => {
        captured = { profileId, modelId, settings };
        return {
          id: "pms_1", providerProfileId: profileId, modelId,
          settings: settings as never, createdAt: "t1", updatedAt: "t2",
        };
      },
    });
    const app = createProviderRoutes(runtime);
    const res = await app.request("/api/providers/prov_1/model-settings/gpt-4o", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(OVERLAY),
    });
    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured!.profileId).toBe("prov_1");
    expect(captured!.modelId).toBe("gpt-4o"); // from URL, NOT body
    expect(captured!.settings).toEqual(OVERLAY);
  });

  test("PUT strips unknown identity fields from the body (overlay schema enforces)", async () => {
    let capturedSettings: unknown = null;
    const runtime = mockRuntime({
      upsertProviderModelSettings: async (_p, _m, settings) => {
        capturedSettings = settings;
        return { id: "x", providerProfileId: "p", modelId: "m", settings: settings as never, createdAt: "t", updatedAt: "t" };
      },
    });
    const app = createProviderRoutes(runtime);
    // 'name' is NOT a valid overlay field → zod strips it before upsert.
    await app.request("/api/providers/prov_1/model-settings/gpt-4o", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "sneaky", temperature: 0.5 }),
    });
    expect(capturedSettings).toEqual({ temperature: 0.5 });
    expect((capturedSettings as Record<string, unknown>).name).toBeUndefined();
  });

  test("PUT with invalid bias (>100) → 400 (zod rejects)", async () => {
    const runtime = mockRuntime();
    const app = createProviderRoutes(runtime);
    const res = await app.request("/api/providers/prov_1/model-settings/gpt-4o", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logitBias: [{ tokenId: 1, bias: 999 }] }),
    });
    expect(res.status).toBe(400);
  });

  test("DELETE /api/providers/:id/model-settings/:modelId → 200 + {ok:true}", async () => {
    let deleted: { profileId: string; modelId: string } | null = null;
    const runtime = mockRuntime({
      deleteProviderModelSettings: async (profileId, modelId) => {
        deleted = { profileId, modelId };
      },
    });
    const app = createProviderRoutes(runtime);
    const res = await app.request("/api/providers/prov_1/model-settings/gpt-4o", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deleted).toEqual({ profileId: "prov_1", modelId: "gpt-4o" });
  });
});
