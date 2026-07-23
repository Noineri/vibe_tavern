import { describe, expect, test } from "bun:test";
import { MODEL_FAVORITE_SCOPE, type ModelFavoriteScope } from "@vibe-tavern/domain";
import { createProviderRoutes } from "../src/api/routes/provider.js";
import type { ProviderRuntimeApi } from "../src/api/contract/runtime-api.js";

function mockRuntime(overrides: Partial<Pick<ProviderRuntimeApi,
  "listFavoriteProviderModels" |
  "addFavoriteProviderModel" |
  "removeFavoriteProviderModel"
>> = {}): ProviderRuntimeApi {
  return { ...overrides } as unknown as ProviderRuntimeApi;
}

const favorite = (scope: ModelFavoriteScope) => ({
  id: "fav_1",
  providerProfileId: "prov_1",
  modelId: "gpt-4o",
  label: "GPT-4o",
  contextLength: 128_000,
  scope,
  createdAt: "2025-05-04T12:00:00.000Z",
});

describe("provider model-favorites routes", () => {
  test("GET defaults legacy omitted scope to RP and returns the persisted scope", async () => {
    let captured: ModelFavoriteScope | null = null;
    const app = createProviderRoutes(mockRuntime({
      listFavoriteProviderModels: async (_profileId, scope) => {
        captured = scope;
        return [favorite(scope)];
      },
    }));

    const response = await app.request("/api/providers/prov_1/model-favorites");

    expect(response.status).toBe(200);
    expect(captured).toBe(MODEL_FAVORITE_SCOPE.rp);
    expect(await response.json()).toMatchObject([{ scope: MODEL_FAVORITE_SCOPE.rp }]);
  });

  test("GET forwards an explicit Co-Author scope and rejects invalid scopes", async () => {
    let captured: ModelFavoriteScope | null = null;
    const app = createProviderRoutes(mockRuntime({
      listFavoriteProviderModels: async (_profileId, scope) => {
        captured = scope;
        return [favorite(scope)];
      },
    }));

    const response = await app.request("/api/providers/prov_1/model-favorites?scope=coauthor");
    expect(response.status).toBe(200);
    expect(captured).toBe(MODEL_FAVORITE_SCOPE.coauthor);

    const invalid = await app.request("/api/providers/prov_1/model-favorites?scope=invalid");
    expect(invalid.status).toBe(400);
  });

  test("POST defaults omitted scope to RP and forwards explicit Co-Author scope", async () => {
    const captured: Array<{ scope: ModelFavoriteScope; modelId: string }> = [];
    const app = createProviderRoutes(mockRuntime({
      addFavoriteProviderModel: async (_profileId, body) => {
        captured.push({ scope: body.scope, modelId: body.modelId });
        return favorite(body.scope);
      },
    }));

    const rpResponse = await app.request("/api/providers/prov_1/model-favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "gpt-4o" }),
    });
    const coauthorResponse = await app.request("/api/providers/prov_1/model-favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "gpt-4o", scope: MODEL_FAVORITE_SCOPE.coauthor }),
    });

    expect(rpResponse.status).toBe(201);
    expect(coauthorResponse.status).toBe(201);
    expect(captured).toEqual([
      { scope: MODEL_FAVORITE_SCOPE.rp, modelId: "gpt-4o" },
      { scope: MODEL_FAVORITE_SCOPE.coauthor, modelId: "gpt-4o" },
    ]);
  });

  test("DELETE defaults omitted scope to RP and forwards explicit Co-Author scope", async () => {
    const captured: ModelFavoriteScope[] = [];
    const app = createProviderRoutes(mockRuntime({
      removeFavoriteProviderModel: async (_profileId, body) => {
        captured.push(body.scope);
      },
    }));

    const rpResponse = await app.request("/api/providers/prov_1/model-favorites", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "gpt-4o" }),
    });
    const coauthorResponse = await app.request("/api/providers/prov_1/model-favorites", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "gpt-4o", scope: MODEL_FAVORITE_SCOPE.coauthor }),
    });

    expect(rpResponse.status).toBe(200);
    expect(coauthorResponse.status).toBe(200);
    expect(captured).toEqual([MODEL_FAVORITE_SCOPE.rp, MODEL_FAVORITE_SCOPE.coauthor]);
  });
});
