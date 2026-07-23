import { beforeEach, describe, expect, test, vi } from "vitest";
import { MODEL_FAVORITE_SCOPE, type ModelFavoriteScope } from "@vibe-tavern/domain";
import type { FavoriteProviderModelRecord } from "../../app-client.js";
import { useProviderDataStore } from "../provider-data-store.js";
import { loadFavoriteModelsAction } from "./provider-actions.js";

const { listFavoriteProviderModelsMock } = vi.hoisted(() => ({
  listFavoriteProviderModelsMock: vi.fn(),
}));
vi.mock("../../app-client.js", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("../../app-client.js");
  return { ...actual, listFavoriteProviderModels: listFavoriteProviderModelsMock };
});

function favorite(scope: ModelFavoriteScope): FavoriteProviderModelRecord {
  return {
    id: `fav_${scope}`,
    providerProfileId: "prov_1",
    modelId: `model_${scope}`,
    scope,
    label: null,
    contextLength: null,
    createdAt: "2025-05-04T12:00:00.000Z",
  };
}

beforeEach(() => {
  listFavoriteProviderModelsMock.mockReset();
  useProviderDataStore.setState({
    profiles: [],
    favoritesByProfile: {},
    coauthorFavoritesByProfile: {},
  });
});

describe("loadFavoriteModelsAction", () => {
  test("keeps RP and Co-Author loads in separate caches", async () => {
    listFavoriteProviderModelsMock.mockImplementation(async (_profileId: string, scope: ModelFavoriteScope) => [favorite(scope)]);

    await loadFavoriteModelsAction("prov_1", MODEL_FAVORITE_SCOPE.rp);
    await loadFavoriteModelsAction("prov_1", MODEL_FAVORITE_SCOPE.coauthor);

    expect(useProviderDataStore.getState().favoritesByProfile.prov_1).toMatchObject([
      { scope: MODEL_FAVORITE_SCOPE.rp },
    ]);
    expect(useProviderDataStore.getState().coauthorFavoritesByProfile.prov_1).toMatchObject([
      { scope: MODEL_FAVORITE_SCOPE.coauthor },
    ]);
  });
});
