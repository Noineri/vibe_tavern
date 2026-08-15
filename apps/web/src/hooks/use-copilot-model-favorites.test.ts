/**
 * useCopilotModelFavorites — copilot-scoped model favorites hook.
 *
 * Pins the hook's contract at the store/API boundary: loading is keyed to the
 * copilot scope, favorites are read per-profile from the store, isFavorite is
 * derived, and toggleFavorite forwards the exact model fields + removing flag
 * to the API action (the action itself is mocked at the module boundary —
 * SAFE pattern: real captured first, only the two favorites fns overridden).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useDomEnv } from "../../test/dom-env.js";
import { useCopilotModelFavorites } from "./use-copilot-model-favorites.js";
import { useProviderDataStore } from "../stores/provider-data-store.js";
import { MODEL_FAVORITE_SCOPE } from "@vibe-tavern/domain";

useDomEnv();

const realProviderActions = await import("../stores/api-actions/provider-actions.js");
const loadFavoriteModelsAction = mock(async (_profileId: string, _scope: string) => {});
const toggleFavoriteModelAction = mock(async () => {});
mock.module("../stores/api-actions/provider-actions.js", () => ({
  ...realProviderActions,
  loadFavoriteModelsAction,
  toggleFavoriteModelAction,
}));

function seedFavorites(profileId: string, favorites: unknown[]) {
  useProviderDataStore.setState({
    copilotFavoritesByProfile: {
      [profileId]: favorites as never,
    },
  });
}

beforeEach(() => {
  loadFavoriteModelsAction.mockReset();
  loadFavoriteModelsAction.mockImplementation(async () => {});
  toggleFavoriteModelAction.mockReset();
  toggleFavoriteModelAction.mockImplementation(async () => {});
  useProviderDataStore.setState({ copilotFavoritesByProfile: {} });
});

afterEach(() => {
  useProviderDataStore.setState({ copilotFavoritesByProfile: {} });
});

describe("useCopilotModelFavorites", () => {
  it("loads the profile's favorites under the copilot scope on mount", async () => {
    const { result } = renderHook(() => useCopilotModelFavorites("p1"));

    await waitFor(() => expect(loadFavoriteModelsAction).toHaveBeenCalledWith("p1", MODEL_FAVORITE_SCOPE.copilot));
    // No cross-scope calls (rp/coauthor must stay untouched).
    expect(loadFavoriteModelsAction).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it("does not load when there is no profile", async () => {
    renderHook(() => useCopilotModelFavorites(null));
    expect(loadFavoriteModelsAction).not.toHaveBeenCalled();
  });

  it("isFavorite derives from the store's per-profile favorites", async () => {
    seedFavorites("p1", [
      { id: "f1", providerProfileId: "p1", modelId: "m9", label: "Nine", contextLength: null, scope: "copilot", createdAt: "" },
    ]);
    const { result } = renderHook(() => useCopilotModelFavorites("p1"));

    expect(result.current.isFavorite("m9")).toBe(true);
    expect(result.current.isFavorite("m1")).toBe(false);
    expect(result.current.favorites).toHaveLength(1);
  });

  it("toggleFavorite star→unstar: forwards removing=true with the model's label/contextLength", async () => {
    seedFavorites("p1", [
      { id: "f1", providerProfileId: "p1", modelId: "m9", label: "Nine", contextLength: 64000, scope: "copilot", createdAt: "" },
    ]);
    const { result } = renderHook(() => useCopilotModelFavorites("p1"));

    await act(async () => {
      result.current.toggleFavorite({ id: "m9", label: "Nine", contextLength: 64000 });
    });

    expect(toggleFavoriteModelAction).toHaveBeenCalledWith(
      "p1",
      "m9",
      "Nine",
      64000,
      true, // already a favorite → removing
      MODEL_FAVORITE_SCOPE.copilot,
    );
  });

  it("toggleFavorite unstar→star: forwards removing=false", async () => {
    const { result } = renderHook(() => useCopilotModelFavorites("p1"));

    await act(async () => {
      result.current.toggleFavorite({ id: "m1", label: "Model One" });
    });

    expect(toggleFavoriteModelAction).toHaveBeenCalledWith(
      "p1",
      "m1",
      "Model One",
      null,
      false, // not a favorite yet → adding
      MODEL_FAVORITE_SCOPE.copilot,
    );
  });

  it("a load failure surfaces in error without throwing", async () => {
    loadFavoriteModelsAction.mockImplementation(async () => {
      throw new Error("network down");
    });
    const { result } = renderHook(() => useCopilotModelFavorites("p1"));

    await waitFor(() => expect(result.current.error).toBe("network down"));
    // The favorites list still resolves (empty), the picker keeps working.
    expect(result.current.favorites).toEqual([]);
  });
});
