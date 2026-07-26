import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { fetchProviderProfileModels } from "../api/provider-api.js";
import { useProviderDataStore } from "../stores/provider-data-store.js";
import { useProviderModels } from "./use-provider-models.js";

vi.mock("../api/provider-api.js", async (importOriginal) => {
  const real = await importOriginal() as typeof import("../api/provider-api.js");
  return { ...real, fetchProviderProfileModels: vi.fn() };
});

const fetchModels = vi.mocked(fetchProviderProfileModels);

describe("useProviderModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProviderDataStore.setState({
      profiles: [{ id: "prof_1", cachedModels: { models: [{ id: "cached", label: "Cached" }], cachedAt: "2026-01-01" } } as never],
    });
  });

  test("uses cached models initially but refresh explicitly fetches a new list", async () => {
    fetchModels.mockResolvedValue({ models: [{ id: "live", label: "Live" }] });
    const { result } = renderHook(() => useProviderModels("prof_1"));
    expect(result.current.models.map((model) => model.id)).toEqual(["cached"]);
    expect(fetchModels).not.toHaveBeenCalled();

    await act(async () => { await result.current.refresh(); });
    await waitFor(() => expect(result.current.models.map((model) => model.id)).toEqual(["live"]));
    expect(fetchModels).toHaveBeenCalledWith("prof_1");
  });
});
