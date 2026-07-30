import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { MODEL_FAVORITE_SCOPE, type ModelFavoriteScope } from "@vibe-tavern/domain";
import type { FavoriteProviderModelRecord } from "../../app-client.js";
import { useProviderDataStore } from "../provider-data-store.js";

const listFavoriteProviderModelsMock = mock();
const realAppClient = await import("../../app-client.js");

mock.module("../../app-client.js", () => ({
	...realAppClient,
	listFavoriteProviderModels: listFavoriteProviderModelsMock,
}));

let loadFavoriteModelsAction: typeof import("./provider-actions.js").loadFavoriteModelsAction;
beforeAll(async () => {
	({ loadFavoriteModelsAction } = await import("./provider-actions.js"));
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
