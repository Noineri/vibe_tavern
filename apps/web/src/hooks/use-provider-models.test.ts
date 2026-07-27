import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();

const realProviderApi = await import("../api/provider-api.js");
const fetchModels = mock<typeof realProviderApi.fetchProviderProfileModels>(async (_profileId) => ({ models: [] }));
mock.module("../api/provider-api.js", () => ({
	...realProviderApi,
	fetchProviderProfileModels: fetchModels,
}));

const { useProviderDataStore } = await import("../stores/provider-data-store.js");
const { useProviderModels } = await import("./use-provider-models.js");

describe("useProviderModels", () => {
	beforeEach(() => {
		mock.clearAllMocks();
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
